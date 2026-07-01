import { useState, useEffect, useRef } from "react";
import { 
  Network, 
  Activity, 
  ShieldAlert, 
  Terminal, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  Send, 
  Sparkles, 
  HelpCircle, 
  Server, 
  Cpu, 
  Database,
  ArrowRight,
  BookOpen,
  Info,
  Layers,
  Flame,
  User,
  Zap
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  Legend, 
  CartesianGrid 
} from "recharts";

interface TelemetryPoint {
  timestamp: string;
  latency: number;
  jitter: number;
  packetLoss: number;
  utilization: number;
}

interface Link {
  id: string;
  source: string;
  target: string;
  name: string;
  type: "mpls" | "broadband" | "lte" | "backup";
  metrics: TelemetryPoint;
}

interface Node {
  id: string;
  name: string;
  type: "branch" | "hub" | "datacenter";
  status: "healthy" | "warning" | "critical";
  ip: string;
}

interface PredictionAlert {
  id: string;
  linkId: string;
  title: string;
  riskScore: number;
  confidence: number;
  eta: string;
  severity: "warning" | "critical";
  reason: string;
  recommendation: string;
  affectedSites: string[];
}

interface SystemLog {
  id: string;
  timestamp: string;
  level: "INFO" | "WARN" | "CRIT";
  message: string;
  category: string;
}

interface ChatMessage {
  role: "user" | "model";
  content: string;
  timestamp: string;
  isSuggested?: boolean;
}

interface Runbook {
  id: string;
  title: string;
  symptoms: string[];
  steps: string[];
}

export default function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [history, setHistory] = useState<Record<string, TelemetryPoint[]>>({});
  const [activeFault, setActiveFault] = useState<string>("none");
  const [predictions, setPredictions] = useState<PredictionAlert[]>([]);
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  
  // Selection / Interaction States
  const [selectedEntity, setSelectedEntity] = useState<{ type: "node" | "link"; id: string } | null>({
    type: "node",
    id: "Hub"
  });
  const [chartMetric, setChartMetric] = useState<"utilization" | "latency" | "jitter" | "packetLoss">("utilization");
  
  // Copilot States
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: "model",
      content: `Hello! I am **SentinelNOC Copilot**, your local air-gapped predictive AI assistant. I continuously monitor Autonomous System **AS-65100** and evaluate pre-emptive telemetry vectors. 

I can help you:
* Trace root causes of rising congestion or packet losses.
* Retrieve specific playbooks from our offline Runbook Knowledge Base.
* Recommend traffic routing modifications to safeguard our SLA.

Try injecting a fault or ask me: *"Why is the Branch A link at risk?"*`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isAiTyping, setIsAiTyping] = useState(false);
  const [isPolling, setIsPolling] = useState(true);
  const [isActionPending, setIsActionPending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, isAiTyping]);

  // Fetch state on mount and tick
  const fetchState = async () => {
    try {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error("Backend offline");
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Invalid content type received (non-JSON)");
      }
      const data = await res.json();
      setNodes(data.nodes);
      setLinks(data.links);
      setHistory(data.history);
      setActiveFault(data.activeFault);
      setPredictions(data.predictions);
      setLogs(data.logs);
    } catch (err) {
      console.warn("NOC feed state sync postponed:", err instanceof Error ? err.message : err);
    }
  };

  // Fetch runbooks once on mount
  const fetchRunbooks = async () => {
    try {
      const res = await fetch("/api/runbooks");
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const data = await res.json();
          setRunbooks(data);
        }
      }
    } catch (err) {
      console.warn("Failed to load runbooks:", err instanceof Error ? err.message : err);
    }
  };

  useEffect(() => {
    fetchState();
    fetchRunbooks();
  }, []);

  // Set up polling interval
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isPolling) {
      interval = setInterval(() => {
        fetchState();
      }, 4000);
    }
    return () => clearInterval(interval);
  }, [isPolling]);

  // Inject a fault
  const injectFault = async (faultType: string) => {
    setIsActionPending(true);
    try {
      const res = await fetch("/api/inject-fault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fault: faultType })
      });
      if (res.ok) {
        await fetchState();
        // Add automatic system notice to copilot
        let alertContext = "";
        if (faultType === "congestion") alertContext = "Injecting Branch A WAN Link Congestion.";
        else if (faultType === "route_flap") alertContext = "Injecting Core Peering (Hub-DC) BGP route flapping.";
        else if (faultType === "tunnel_failure") alertContext = "Injecting dynamic IPsec tunnel degradation on Branch B.";
        else if (faultType === "qos_misconfig") alertContext = "Injecting QoS classification drift on Branch C.";
        else alertContext = "Restoring clean network configuration.";

        setChatMessages(prev => [
          ...prev,
          {
            role: "model",
            content: `**[SYSTEM EVENT]** NOC Operator triggered fault scenario: *${alertContext}* I am recalculating predictive risks and scanning offline playbooks. Ask me how to remediate this!`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isSuggested: true
          }
        ]);
      }
    } catch (err) {
      console.error("Fault injection failed", err);
    } finally {
      setIsActionPending(false);
    }
  };

  // Reset faults
  const clearFaults = async () => {
    setIsActionPending(true);
    try {
      const res = await fetch("/api/resolve-faults", { method: "POST" });
      if (res.ok) {
        await fetchState();
        setChatMessages(prev => [
          ...prev,
          {
            role: "model",
            content: `**[SYSTEM STATE RESOLVED]** Global fault clearance command executed. All WAN links are returning to nominal baselines. Predictive model risk scores have reset.`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isSuggested: true
          }
        ]);
      }
    } catch (err) {
      console.error("State reset failed", err);
    } finally {
      setIsActionPending(false);
    }
  };

  // Chat Submission
  const handleSendMessage = async (msgText: string) => {
    if (!msgText.trim() || isAiTyping) return;
    
    const userMessage: ChatMessage = {
      role: "user",
      content: msgText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput("");
    setIsAiTyping(true);

    // Prepare state package to help Gemini anchor on exact matching metrics
    const latestState = {
      activeFault,
      predictions,
      links: links.map(l => ({
        name: l.name,
        type: l.type,
        metrics: l.metrics
      }))
    };

    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msgText,
          chatHistory: chatMessages.map(m => ({ role: m.role, content: m.content })),
          networkState: latestState
        })
      });

      if (!res.ok) {
        let errorMsg = "Failed to contact Gemini Copilot.";
        try {
          const errData = await res.json();
          if (errData.isOverloaded) {
            errorMsg = "The AI model is currently experiencing temporary high demand (503). Spikes in demand are usually temporary and automatically resolve. Please try your request again in a few seconds.";
          } else if (errData.details) {
            errorMsg = errData.details;
          } else if (errData.error) {
            errorMsg = errData.error;
          }
        } catch (_) {}
        throw new Error(errorMsg);
      }

      const data = await res.json();
      setChatMessages(prev => [
        ...prev,
        {
          role: "model",
          content: data.response,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } catch (err: any) {
      setChatMessages(prev => [
        ...prev,
        {
          role: "model",
          content: `⚠️ **AI Copilot Alert**: ${err.message || "Failed to process your prompt."}\n\n*Suggestion: Ensure a valid \`GEMINI_API_KEY\` is configured in your Settings, or wait a brief moment and resend the message.*`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setIsAiTyping(false);
    }
  };

  const selectedLinkInfo = selectedEntity?.type === "link" ? links.find(l => l.id === selectedEntity.id) : null;
  const selectedNodeInfo = selectedEntity?.type === "node" ? nodes.find(n => n.id === selectedEntity.id) : null;

  // Render metric badge with status color helper
  const getMetricClass = (val: number, type: "util" | "lat" | "jit" | "loss") => {
    if (type === "util") {
      if (val > 85) return "text-[#FF3131] font-bold";
      if (val > 65) return "text-[#F2D600] font-medium";
      return "text-[#00FF41]";
    }
    if (type === "lat") {
      if (val > 100) return "text-[#FF3131] font-bold";
      if (val > 50) return "text-[#F2D600] font-medium";
      return "text-[#00FF41]";
    }
    if (type === "jit") {
      if (val > 25) return "text-[#FF3131] font-bold";
      if (val > 10) return "text-[#F2D600] font-medium";
      return "text-[#00FF41]";
    }
    if (type === "loss") {
      if (val > 2.0) return "text-[#FF3131] font-bold";
      if (val > 0.5) return "text-[#F2D600] font-medium";
      return "text-[#00FF41]";
    }
    return "";
  };

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-[#E0E0E0] font-sans selection:bg-[#00FF41] selection:text-black flex flex-col">
      
      {/* 1. HEADER SECTION */}
      <header className="border-b border-white/10 bg-[#0A0A0B] px-6 py-4 sticky top-0 z-40 flex flex-col md:flex-row md:items-center md:justify-between gap-4" id="noc-header">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#00FF41] rounded flex items-center justify-center shrink-0">
            <div className="w-4 h-4 border-2 border-black rotate-45"></div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white">
                SENTINEL<span className="text-[#00FF41]">NOC</span>
              </h1>
              <span className="text-[10px] bg-white/5 border border-white/10 px-2 py-0.5 rounded text-white/50 tracking-widest uppercase font-mono">
                v2.5 Live
              </span>
            </div>
            <p className="text-xs text-white/40 font-mono tracking-tight">
              Predictive AI Network Operations Assistant — Air-Gapped Simulation
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-8">
          {/* Header Stats Panel */}
          <div className="hidden lg:flex items-center gap-6 text-[11px] font-mono">
            <div className="flex flex-col items-end">
              <span className="text-white/40 uppercase text-[9px]">System Latency</span>
              <span className="text-[#00FF41]">12ms <span className="text-[8px] opacity-50">Stable</span></span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-white/40 uppercase text-[9px]">Predictive Load</span>
              <span className="text-[#F2D600]">74.2% <span className="text-[8px] opacity-50">Rising</span></span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-white/40 uppercase text-[9px]">AI Engine</span>
              <span className="text-[#00FF41]">Active <span className="text-[8px] opacity-50">Phi-4</span></span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Status badge */}
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded px-3 py-1.5 font-mono text-xs">
              <div className="h-2 w-2 rounded-full bg-[#00FF41] animate-pulse" />
              <span className="text-white/80">COPILOT ACTIVE</span>
            </div>

            {/* Refresh/Interval polling control */}
            <button 
              id="polling-toggle"
              onClick={() => setIsPolling(!isPolling)}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 font-mono text-xs border transition-all ${
                isPolling 
                  ? "bg-white/5 border-white/10 text-white hover:bg-white/10" 
                  : "bg-white/5 border-[#F2D600]/30 text-[#F2D600] hover:bg-white/10"
              }`}
            >
              <RefreshCw className={`h-3 w-3 ${isPolling ? "animate-spin [animation-duration:6s]" : ""}`} />
              <span>{isPolling ? "LIVE FEED ACTIVE" : "PAUSED"}</span>
            </button>
          </div>
        </div>
      </header>

      {/* 2. FAULT INJECTION CONTROLS BAR */}
      <section className="bg-white/[0.02] border-b border-white/10 px-6 py-4 flex flex-col lg:flex-row lg:items-center gap-4" id="fault-controller">
        <div className="flex items-center gap-2 font-mono text-xs text-white/50">
          <Zap className="h-4 w-4 text-[#00FF41]" />
          <span className="font-bold text-white/80">FAULT INJECTION LAB:</span>
        </div>
        
        <div className="flex flex-wrap gap-2 grow">
          <button
            id="btn-fault-none"
            onClick={() => injectFault("none")}
            disabled={isActionPending}
            className={`px-3 py-1.5 rounded text-xs font-mono border transition-all flex items-center gap-1.5 ${
              activeFault === "none" 
                ? "bg-[#00FF41]/10 border-[#00FF41]/40 text-[#00FF41]" 
                : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Normal Operations</span>
          </button>

          <button
            id="btn-fault-congestion"
            onClick={() => injectFault("congestion")}
            disabled={isActionPending}
            className={`px-3 py-1.5 rounded text-xs font-mono border transition-all flex items-center gap-1.5 ${
              activeFault === "congestion" 
                ? "bg-[#FF3131]/10 border-[#FF3131]/40 text-[#FF3131]" 
                : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <Flame className="h-3.5 w-3.5" />
            <span>Congestion (Branch A)</span>
          </button>

          <button
            id="btn-fault-flap"
            onClick={() => injectFault("route_flap")}
            disabled={isActionPending}
            className={`px-3 py-1.5 rounded text-xs font-mono border transition-all flex items-center gap-1.5 ${
              activeFault === "route_flap" 
                ? "bg-[#FF3131]/10 border-[#FF3131]/40 text-[#FF3131]" 
                : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>BGP Route Flap (Core)</span>
          </button>

          <button
            id="btn-fault-tunnel"
            onClick={() => injectFault("tunnel_failure")}
            disabled={isActionPending}
            className={`px-3 py-1.5 rounded text-xs font-mono border transition-all flex items-center gap-1.5 ${
              activeFault === "tunnel_failure" 
                ? "bg-[#FF3131]/10 border-[#FF3131]/40 text-[#FF3131]" 
                : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span>Tunnel IPsec Drop (Branch B)</span>
          </button>

          <button
            id="btn-fault-qos"
            onClick={() => injectFault("qos_misconfig")}
            disabled={isActionPending}
            className={`px-3 py-1.5 rounded text-xs font-mono border transition-all flex items-center gap-1.5 ${
              activeFault === "qos_misconfig" 
                ? "bg-[#FF3131]/10 border-[#FF3131]/40 text-[#FF3131]" 
                : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>QoS Drift (Branch C)</span>
          </button>
        </div>

        {activeFault !== "none" && (
          <button
            id="btn-clear-faults"
            onClick={clearFaults}
            disabled={isActionPending}
            className="px-4 py-1.5 rounded text-xs font-mono bg-[#00FF41] hover:bg-[#00FF41]/80 text-black font-bold transition-all flex items-center gap-1.5 shrink-0"
          >
            <RefreshCw className="h-3 w-3" />
            <span>CLEAR ALL FAULTS</span>
          </button>
        )}
      </section>

      {/* 3. MAIN DASHBOARD WORKSPACE (3-COLUMN LAYOUT) */}
      <main className="grow p-6 grid grid-cols-1 xl:grid-cols-12 gap-6 overflow-hidden" id="noc-grid">
        
        {/* COLUMN 1: TOPOLOGY & EVENTS (xl:col-span-4) */}
        <section className="xl:col-span-4 flex flex-col gap-6 h-full" id="col-topology">
          
          {/* Node/Link Topology Panel */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl flex flex-col p-4 grow min-h-[350px]">
            <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Network className="h-4 w-4 text-[#00FF41]" />
                <h2 className="font-mono text-sm font-bold tracking-wide">AS-65100 NETWORK TOPOLOGY</h2>
              </div>
              <span className="text-[10px] font-mono text-white/40">CLICK NODES / PATHS FOR TELEMETRY</span>
            </div>

            {/* Interactive SVG Network Map */}
            <div className="relative bg-black/40 border border-white/5 rounded-xl grow flex items-center justify-center p-2 min-h-[220px]">
              <svg viewBox="0 0 500 300" className="w-full h-full">
                {/* 1. Link Lines between nodes */}
                {links.map(link => {
                  const nodePositions: Record<string, { x: number; y: number }> = {
                    BranchA: { x: 75, y: 60 },
                    BranchB: { x: 75, y: 150 },
                    BranchC: { x: 75, y: 240 },
                    Hub: { x: 260, y: 150 },
                    DC: { x: 425, y: 150 }
                  };
                  const src = nodePositions[link.source];
                  const tgt = nodePositions[link.target];
                  if (!src || !tgt) return null;

                  const isSelected = selectedEntity?.type === "link" && selectedEntity.id === link.id;
                  
                  // Determine link color based on active metrics/faults
                  let strokeColor = "stroke-white/10";
                  let isAnimated = true;
                  let flowColor = "text-[#00FF41]";

                  if (link.metrics.utilization > 85 || link.metrics.packetLoss > 4.0 || link.metrics.jitter > 20) {
                    strokeColor = "stroke-[#FF3131]";
                    flowColor = "text-[#FF3131]";
                  } else if (link.metrics.utilization > 65 || link.metrics.packetLoss > 1.0) {
                    strokeColor = "stroke-[#F2D600]";
                    flowColor = "text-[#F2D600]";
                  } else if (link.type === "backup") {
                    strokeColor = "stroke-white/10";
                    isAnimated = link.metrics.utilization > 5; // Backup only flows when active
                    flowColor = "text-white/40";
                  } else {
                    strokeColor = "stroke-[#00FF41]/30";
                  }

                  return (
                    <g key={link.id} className="cursor-pointer group" onClick={() => setSelectedEntity({ type: "link", id: link.id })}>
                      {/* Interactive wide touch target line */}
                      <line 
                        x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} 
                        className="stroke-transparent stroke-[12] hover:stroke-white/5 transition-all" 
                      />
                      {/* Main link path */}
                      <line 
                        x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} 
                        className={`transition-all ${strokeColor} ${isSelected ? "stroke-[4.5]" : "stroke-[2.5] hover:stroke-white/50"}`} 
                      />
                      {/* Animated data packet flow representation */}
                      {isAnimated && (
                        <line 
                          x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} 
                          className={`animate-dash pointer-events-none stroke-[2.5] ${flowColor}`} 
                        />
                      )}
                    </g>
                  );
                })}

                {/* 2. Nodes rendering */}
                {nodes.map(node => {
                  const nodePositions: Record<string, { x: number; y: number }> = {
                    BranchA: { x: 75, y: 60 },
                    BranchB: { x: 75, y: 150 },
                    BranchC: { x: 75, y: 240 },
                    Hub: { x: 260, y: 150 },
                    DC: { x: 425, y: 150 }
                  };
                  const pos = nodePositions[node.id];
                  if (!pos) return null;

                  const isSelected = selectedEntity?.type === "node" && selectedEntity.id === node.id;
                  
                  let fill = "fill-black";
                  let stroke = "stroke-white/20";
                  let glowClass = "";

                  if (node.status === "critical") {
                    stroke = "stroke-[#FF3131]";
                    glowClass = "animate-pulse";
                  } else if (node.status === "warning") {
                    stroke = "stroke-[#F2D600]";
                  } else {
                    stroke = "stroke-[#00FF41]";
                  }

                  return (
                    <g 
                      key={node.id} 
                      className="cursor-pointer group"
                      onClick={() => setSelectedEntity({ type: "node", id: node.id })}
                    >
                      {/* Node circle outline glowing base */}
                      {isSelected && (
                        <circle 
                          cx={pos.x} cy={pos.y} r={18} 
                          className="fill-transparent stroke-[#00FF41] stroke-2 animate-ping opacity-35" 
                        />
                      )}
                      {/* Main node bubble */}
                      <circle 
                        cx={pos.x} cy={pos.y} r={14} 
                        className={`transition-all ${fill} ${stroke} ${glowClass} ${isSelected ? "stroke-[3.5]" : "stroke-2 group-hover:stroke-white"}`} 
                      />
                      
                      {/* Small Type Icon indicator inside node */}
                      <text 
                        x={pos.x} y={pos.y + 3.5} 
                        className="fill-[#E0E0E0] text-[10px] font-bold font-mono text-center" 
                        textAnchor="middle"
                      >
                        {node.type === "datacenter" ? "DC" : (node.type === "hub" ? "HB" : "BR")}
                      </text>

                      {/* Label below node */}
                      <text 
                        x={pos.x} y={pos.y + 26} 
                        className="fill-white/70 text-[9.5px] font-mono tracking-wide font-medium" 
                        textAnchor="middle"
                      >
                        {node.name.replace(" Office", "").replace(" Router", "")}
                      </text>
                    </g>
                  );
                })}
              </svg>

              {/* Float Legend details */}
              <div className="absolute bottom-2 left-2 flex gap-3 text-[9px] font-mono text-white/50 bg-[#0A0A0B]/95 px-2.5 py-1 rounded border border-white/10">
                <div className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#00FF41] inline-block animate-pulse" />
                  <span>Healthy</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#F2D600] inline-block animate-pulse" />
                  <span>Risk Alert</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#FF3131] inline-block animate-ping" />
                  <span>Breach Risk</span>
                </div>
              </div>
            </div>

            {/* Entity Quick inspect drawer */}
            <div className="mt-3 bg-white/[0.02] border border-white/10 rounded-xl p-3.5 text-xs">
              {selectedNodeInfo && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-white flex items-center gap-1.5 font-mono">
                      <Server className="h-3.5 w-3.5 text-[#00FF41]" />
                      {selectedNodeInfo.name}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${
                      selectedNodeInfo.status === "healthy" ? "bg-[#00FF41]/10 text-[#00FF41] border border-[#00FF41]/20" :
                      selectedNodeInfo.status === "warning" ? "bg-[#F2D600]/10 text-[#F2D600] border border-[#F2D600]/20" :
                      "bg-[#FF3131]/10 text-[#FF3131] border border-[#FF3131]/20 animate-pulse"
                    }`}>
                      {selectedNodeInfo.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-y-1 text-[11px] font-mono text-white/50 mt-2">
                    <div>MGMT IP: <span className="text-[#E0E0E0]">{selectedNodeInfo.ip}</span></div>
                    <div>ROLE: <span className="text-[#E0E0E0] capitalize">{selectedNodeInfo.type}</span></div>
                    <div className="col-span-2 mt-1">
                      Status: <span className="text-white/70">
                        {selectedNodeInfo.status === "healthy" ? "Node is fully operational, responsive, and forwarding traffic routes dynamically." : 
                         selectedNodeInfo.status === "warning" ? "High metrics on adjacent WAN interface triggering warning threshold limits." :
                         "CRITICAL: SLA breach precursors detected. Packet forwarding queuing is saturating. Immediate check recommended."}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {selectedLinkInfo && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-bold text-white flex items-center gap-1.5 font-mono">
                      <Activity className="h-3.5 w-3.5 text-[#00FF41]" />
                      {selectedLinkInfo.name}
                    </span>
                    <span className="px-1.5 py-0.5 bg-white/5 rounded text-[9px] font-mono uppercase text-white/50 border border-white/10">
                      {selectedLinkInfo.type} WAN
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono mt-2 pt-1 border-t border-white/10">
                    <div className="bg-black/40 p-1.5 rounded border border-white/5">
                      <span className="text-[10px] text-white/40 block">UTILIZATION</span>
                      <span className={getMetricClass(selectedLinkInfo.metrics.utilization, "util")}>
                        {selectedLinkInfo.metrics.utilization}%
                      </span>
                    </div>
                    <div className="bg-black/40 p-1.5 rounded border border-white/5">
                      <span className="text-[10px] text-white/40 block">LATENCY</span>
                      <span className={getMetricClass(selectedLinkInfo.metrics.latency, "lat")}>
                        {selectedLinkInfo.metrics.latency} ms
                      </span>
                    </div>
                    <div className="bg-black/40 p-1.5 rounded border border-white/5">
                      <span className="text-[10px] text-white/40 block">JITTER</span>
                      <span className={getMetricClass(selectedLinkInfo.metrics.jitter, "jit")}>
                        {selectedLinkInfo.metrics.jitter} ms
                      </span>
                    </div>
                    <div className="bg-black/40 p-1.5 rounded border border-white/5">
                      <span className="text-[10px] text-white/40 block">PACKET LOSS</span>
                      <span className={getMetricClass(selectedLinkInfo.metrics.packetLoss, "loss")}>
                        {selectedLinkInfo.metrics.packetLoss}%
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Syslogs / NOC Event stream Terminal */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl flex flex-col p-4 h-[240px]">
            <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2 shrink-0">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-[#00FF41]" />
                <h2 className="font-mono text-xs font-bold tracking-wide">SECURE SYSLOG STREAM</h2>
              </div>
              <span className="text-[9px] font-mono text-white/40 uppercase">LOCAL CONSOLE</span>
            </div>

            <div className="grow overflow-y-auto font-mono text-[10px] space-y-1.5 p-2 bg-black/40 border border-white/5 rounded select-text">
              {logs.map(log => (
                <div key={log.id} className="flex gap-2 leading-relaxed">
                  <span className="text-slate-600 shrink-0 select-none">{log.timestamp}</span>
                  <span className={`shrink-0 font-bold select-none ${
                    log.level === "CRIT" ? "text-rose-500" :
                    log.level === "WARN" ? "text-amber-500" : "text-cyan-500"
                  }`}>
                    [{log.level}]
                  </span>
                  <span className="text-slate-500 shrink-0 select-none">[{log.category}]</span>
                  <span className="text-slate-300">{log.message}</span>
                </div>
              ))}
            </div>
          </div>

        </section>

        {/* COLUMN 2: METRICS & PREDICTIVE WARNINGS (xl:col-span-5) */}
        <section className="xl:col-span-5 flex flex-col gap-6 h-full" id="col-analytics">
          
          {/* Active Pre-emptive Alerts (the core predictive feature) */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl flex flex-col p-4 shrink-0 min-h-[170px]">
            <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-[#FF3131] animate-pulse" />
                <h2 className="font-mono text-sm font-bold tracking-wide">
                  AI PREEMPTIVE FAILURES ALERTS
                </h2>
              </div>
              <span className="bg-[#FF3131]/10 text-[#FF3131] border border-[#FF3131]/20 text-[9px] font-mono px-1.5 py-0.5 rounded font-medium">
                MODEL INFERENCE ACTIVE
              </span>
            </div>

            <div className="space-y-3 grow flex flex-col justify-center">
              {predictions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-center text-white/50 font-mono text-xs">
                  <CheckCircle2 className="h-8 w-8 text-[#00FF41] mb-2 glow-green" />
                  <p className="text-[#E0E0E0] font-bold">ALL LINKS CALIBRATED // HEALTHY</p>
                  <p className="text-[10px] text-white/40 mt-1 max-w-sm">
                    No metric anomalies or signature failure patterns detected in the rolling 60-minute forecast window.
                  </p>
                </div>
              ) : (
                predictions.map(pred => (
                  <div 
                    key={pred.id}
                    className={`border rounded-xl p-4 transition-all bg-gradient-to-br ${
                      pred.severity === "critical" 
                        ? "from-[#FF3131]/10 to-transparent border-[#FF3131]/30" 
                        : "from-[#F2D600]/10 to-transparent border-[#F2D600]/30"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2 mb-2">
                      <div className="flex items-center gap-2">
                        {pred.severity === "critical" ? (
                          <span className="h-2 w-2 rounded-full bg-[#FF3131] animate-ping" />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-[#F2D600] animate-pulse" />
                        )}
                        <h3 className="font-mono text-xs font-bold text-white">
                          {pred.title}
                        </h3>
                      </div>
                      <div className="flex gap-2 text-[10px] font-mono">
                        <span className="bg-black/40 border border-white/5 px-1.5 py-0.5 rounded text-white/50">
                          ETA: <span className="text-[#FF3131] font-bold">{pred.eta}</span>
                        </span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3 text-center">
                      <div className="bg-black/40 rounded-lg p-2 border border-white/5">
                        <span className="text-[9px] text-white/40 font-mono block">RISK SCORE</span>
                        <span className={`text-sm font-mono font-bold ${
                          pred.riskScore > 85 ? "text-[#FF3131]" : "text-[#F2D600]"
                        }`}>{pred.riskScore}%</span>
                      </div>
                      <div className="bg-black/40 rounded-lg p-2 border border-white/5">
                        <span className="text-[9px] text-white/40 font-mono block">MODEL CONFIDENCE</span>
                        <span className="text-sm font-mono text-[#00FF41] font-bold">{pred.confidence}%</span>
                      </div>
                      <div className="bg-black/40 rounded-lg p-2 border border-white/5 col-span-2 sm:col-span-1">
                        <span className="text-[9px] text-white/40 font-mono block">AFFECTED NODES</span>
                        <span className="text-[10px] font-mono text-white/80 block truncate">
                          {pred.affectedSites.join(" ↔ ")}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2 font-mono text-[11px] leading-relaxed">
                      <div>
                        <span className="text-white/40 font-bold">PRECURSOR CAUSE:</span>
                        <p className="text-white/80 mt-0.5 bg-black/20 p-2.5 rounded-lg border border-white/5 text-[10.5px]">
                          {pred.reason}
                        </p>
                      </div>
                      <div className="border-t border-white/5 pt-1.5 mt-1.5">
                        <span className="text-[#00FF41] font-bold flex items-center gap-1">
                          <BookOpen className="h-3.5 w-3.5" />
                          CO-PILOT PREVENTATIVE ACTION RECOMMENDATION:
                        </span>
                        <p className="text-white/95 mt-1 bg-[#00FF41]/5 p-2.5 rounded-lg border border-[#00FF41]/20 text-[10.5px]">
                          {pred.recommendation}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Core Historical Telemetry Analytics Charts */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl flex flex-col p-4 grow min-h-[350px]" id="chart-metrics">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/10 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-[#00FF41]" />
                <h2 className="font-mono text-sm font-bold tracking-wide">HISTORICAL TELEMETRY FORECAST</h2>
              </div>
              
              {/* Metric selector tabs */}
              <div className="flex flex-wrap gap-1">
                {(["utilization", "latency", "jitter", "packetLoss"] as const).map(metric => (
                  <button
                    key={metric}
                    onClick={() => setChartMetric(metric)}
                    className={`px-2.5 py-1 rounded text-[10px] font-mono transition-all capitalize border ${
                      chartMetric === metric
                        ? "bg-white/5 text-[#00FF41] border-[#00FF41]/30 font-bold"
                        : "bg-white/5 border-white/10 text-white/50 hover:text-white"
                    }`}
                  >
                    {metric === "packetLoss" ? "Packet Loss" : metric}
                  </button>
                ))}
              </div>
            </div>

            {/* Recharts Container */}
            <div className="grow w-full min-h-[220px] relative select-none">
              {Object.keys(history).length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center text-white/40 font-mono text-xs">
                  Loading telemetry stream...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                    data={
                      // Align history entries for the chart correctly
                      history["BranchA-Hub"]?.map((pt, idx) => {
                        const dataPoint: any = { timestamp: pt.timestamp };
                        for (const linkId of Object.keys(history)) {
                          const linkPt = history[linkId]?.[idx];
                          dataPoint[linkId] = linkPt ? linkPt[chartMetric] : 0;
                        }
                        return dataPoint;
                      }) || []
                    }
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis 
                      dataKey="timestamp" 
                      stroke="rgba(255,255,255,0.3)" 
                      fontSize={9} 
                      fontFamily="JetBrains Mono" 
                      tickLine={false}
                    />
                    <YAxis 
                      stroke="rgba(255,255,255,0.3)" 
                      fontSize={9} 
                      fontFamily="JetBrains Mono"
                      tickLine={false}
                      domain={[0, chartMetric === "utilization" ? 100 : "auto"]}
                      unit={chartMetric === "utilization" || chartMetric === "packetLoss" ? "%" : "ms"}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0A0A0B",
                        borderColor: "rgba(255, 255, 255, 0.1)",
                        borderRadius: "8px",
                        fontSize: "11px",
                        fontFamily: "JetBrains Mono"
                      }}
                    />
                    <Legend 
                      verticalAlign="top"
                      height={36}
                      wrapperStyle={{ fontSize: "9px", fontFamily: "JetBrains Mono" }}
                    />
                    
                    {/* Minimalist neon themed lines */}
                    <Line 
                      type="monotone" 
                      dataKey="BranchA-Hub" 
                      name="Branch A → Hub" 
                      stroke="#00FF41" 
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="BranchB-Hub" 
                      name="Branch B → Hub" 
                      stroke="#00E0FF" 
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="BranchC-Hub" 
                      name="Branch C → Hub" 
                      stroke="#F2D600" 
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="Hub-DC" 
                      name="Hub → Data Center" 
                      stroke="#FF3131" 
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="BranchB-BranchC" 
                      name="Branch B → C Backup" 
                      stroke="rgba(255,255,255,0.2)" 
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            
            {/* Context Helper */}
            <div className="mt-3 bg-white/[0.02] p-3 rounded-lg border border-white/10 text-[10.5px] font-mono text-white/40 leading-normal flex items-start gap-2">
              <Info className="h-4 w-4 text-[#00FF41] shrink-0 mt-0.5" />
              <span>
                Models are running prediction heuristics over rolling 30-sample time windows. Injected faults induce gradual drift over consecutive ticks, enabling proactive lead time detection before metric breaches.
              </span>
            </div>
          </div>
        </section>

        {/* COLUMN 3: AI COPILOT CHAT & RUNBOOK KNOWLEDGE BASE (xl:col-span-3) */}
        <section className="xl:col-span-3 flex flex-col gap-6 h-full" id="col-copilot">
          
          {/* Sentinel AI Copilot Terminal */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl flex flex-col p-4 grow h-[480px]">
            <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-3 shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[#00FF41] animate-pulse" />
                <h2 className="font-mono text-sm font-bold tracking-wide">SENTINEL AI NOC COPILOT</h2>
              </div>
              <span className="bg-[#00FF41]/10 text-[#00FF41] border border-[#00FF41]/20 text-[9px] font-mono px-1.5 py-0.5 rounded font-medium">
                LOCAL GPT-ASSIST
              </span>
            </div>

            {/* Chat message stream */}
            <div className="grow overflow-y-auto space-y-3 p-2 bg-black/40 border border-white/5 rounded-xl select-text mb-3 text-xs leading-relaxed">
              {chatMessages.map((msg, idx) => (
                <div 
                  key={idx} 
                  className={`flex gap-2 p-2 rounded-lg ${
                    msg.role === "user" 
                      ? "bg-white/5 border border-white/10 ml-4" 
                      : msg.isSuggested 
                        ? "bg-[#00FF41]/5 border border-[#00FF41]/10"
                        : "bg-white/[0.02] border border-white/10 mr-4"
                  }`}
                >
                  <div className="shrink-0 mt-0.5">
                    {msg.role === "user" ? (
                      <div className="h-5 w-5 rounded-full bg-white/10 flex items-center justify-center text-[10px] text-white/80 font-bold">
                        <User className="h-3 w-3" />
                      </div>
                    ) : (
                      <div className="h-5 w-5 rounded-full bg-black border border-[#00FF41] flex items-center justify-center text-[10px] text-[#00FF41] font-bold">
                        S
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 grow min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white/80 text-[10px] uppercase font-mono">
                        {msg.role === "user" ? "NOC Engineer" : "Sentinel NOC"}
                      </span>
                      <span className="text-[9px] text-white/30 font-mono">{msg.timestamp}</span>
                    </div>
                    {/* Simplified formatting render */}
                    <div className="text-white/90 select-text break-words whitespace-pre-wrap">
                      {msg.content.split("\n").map((line, lIdx) => {
                        // Render lists
                        if (line.trim().startsWith("*") || line.trim().startsWith("-")) {
                          return <li key={lIdx} className="ml-3 mt-1 list-disc text-white/80">{line.replace(/^[*\-]\s*/, "")}</li>;
                        }
                        // Render headers
                        if (line.startsWith("###")) {
                          return <h4 key={lIdx} className="font-bold text-white font-mono text-xs mt-3 border-b border-white/5 pb-1">{line.replace(/^###\s*/, "")}</h4>;
                        }
                        // Replace double asterisk bold markers inline
                        const parts = line.split("**");
                        return (
                          <p key={lIdx} className="mt-1">
                            {parts.map((p, pIdx) => pIdx % 2 === 1 ? <strong key={pIdx} className="text-[#00FF41] font-bold">{p}</strong> : p)}
                          </p>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
              
              {isAiTyping && (
                <div className="flex gap-2 p-2 bg-black/40 border border-white/5 rounded-lg mr-4 text-white/40 font-mono text-[10px]">
                  <RefreshCw className="h-3.5 w-3.5 text-[#00FF41] animate-spin" />
                  <span>Sentinel AI analyzing real-time indicators...</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Suggested quick queries */}
            <div className="mb-3">
              <span className="text-[9px] font-mono text-white/30 block mb-1">SUGGESTED OPERATIONAL QUERIES:</span>
              <div className="flex flex-wrap gap-1">
                {[
                  "Why is Branch A link status at risk?",
                  "Standard steps to resolve BGP flapping?",
                  "Is there a backup path if Branch B fails?",
                  "Check DSCP policy on Branch C"
                ].map((q, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSendMessage(q)}
                    disabled={isAiTyping}
                    className="text-[10px] font-mono bg-black/40 border border-white/10 text-white/70 hover:text-[#00FF41] hover:border-[#00FF41]/30 px-2 py-1 rounded transition-all select-none text-left"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            {/* Chat Input form */}
            <form 
              onSubmit={(e) => { e.preventDefault(); handleSendMessage(chatInput); }}
              className="flex gap-1.5 shrink-0"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask Sentinel to verify links or playbooks..."
                className="grow bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#00FF41]/50"
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || isAiTyping}
                className="bg-[#00FF41] hover:bg-[#00FF41]/80 text-black font-bold p-1.5 rounded transition-all disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>

          {/* RAG Knowledge Base Runbooks Library Explorer */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl flex flex-col p-4 h-[240px]">
            <div className="flex items-center justify-between border-b border-white/10 pb-2.5 mb-2.5">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[#00FF41]" />
                <h2 className="font-mono text-xs font-bold tracking-wide">RAG LOCAL RUNBOOKS</h2>
              </div>
              <span className="text-[9px] font-mono text-white/40 uppercase">CHROMADB EMBEDDED</span>
            </div>

            <div className="grow overflow-y-auto space-y-2.5 pr-1 text-[11px] font-mono leading-relaxed">
              {runbooks.map(rb => (
                <div key={rb.id} className="border border-white/5 rounded bg-black/20 p-2 hover:border-white/10 transition-all">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-white/85 text-xs">{rb.id}: {rb.title}</span>
                  </div>
                  <div className="space-y-1 text-[10.5px]">
                    <div>
                      <span className="text-white/30 font-bold">SYMPTOMS:</span>
                      <span className="text-white/60 ml-1 block">{rb.symptoms.join(", ")}</span>
                    </div>
                    <div>
                      <span className="text-[#00FF41]/90 font-bold">PLAYBOOK STEPS:</span>
                      <ol className="list-decimal list-inside text-white/60 space-y-0.5 mt-0.5 pl-1.5">
                        {rb.steps.slice(0, 2).map((s, idx) => (
                          <li key={idx} className="truncate">{s}</li>
                        ))}
                        {rb.steps.length > 2 && <li className="text-[9.5px] text-white/40 list-none">+{rb.steps.length - 2} additional diagnostic steps</li>}
                      </ol>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </section>

      </main>

      {/* FOOTER METADATA */}
      <footer className="border-t border-white/5 bg-[#0A0A0B] px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between text-[10px] font-mono text-white/30 gap-2 shrink-0 uppercase tracking-widest">
        <div>
          <span>SECURE SECRETS STATUS: </span>
          <span className={process.env.GEMINI_API_KEY ? "text-[#00FF41] font-bold" : "text-[#F2D600]"}>
            {process.env.GEMINI_API_KEY ? "GEMINI_API_KEY DETECTED (FULL-STACK INFRASTRUCTURE PROXIED)" : "API KEY DEFAULTED"}
          </span>
        </div>
        <div>
          <span>AUTONOMOUS SYSTEM: AS-65100 // ISRO BHARATIYA ANTARIKSH HACKATHON</span>
        </div>
      </footer>
    </div>
  );
}
