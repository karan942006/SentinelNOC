import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// Initialize Google GenAI
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

interface TelemetryPoint {
  timestamp: string;
  latency: number;      // ms
  jitter: number;       // ms
  packetLoss: number;   // %
  utilization: number;  // %
}

interface NetworkLink {
  id: string;
  source: string;
  target: string;
  name: string;
  type: "mpls" | "broadband" | "lte" | "backup";
  metrics: TelemetryPoint;
}

interface NetworkNode {
  id: string;
  name: string;
  type: "branch" | "hub" | "datacenter";
  status: "healthy" | "warning" | "critical";
  ip: string;
}

interface Runbook {
  id: string;
  title: string;
  symptoms: string[];
  steps: string[];
}

const RUNBOOKS: Runbook[] = [
  {
    id: "RB-001",
    title: "WAN Link Congestion Mitigation Playbook",
    symptoms: ["Utilization > 85%", "Latency spike > 80ms", "Packet loss 1% - 5%"],
    steps: [
      "Identify high-bandwidth consumer IPs on the affected router interface using NetFlow.",
      "Check if traffic matches the backup replication schedule (bulk transfers).",
      "If replication-related, invoke policy-map to throttle non-real-time traffic class to 20% max capacity.",
      "Re-route branch backup tunnels over the Broadband secondary connection instead of the primary MPLS link.",
      "Notify security operations if anomalous outbound volume is detected (potential data exfiltration)."
    ]
  },
  {
    id: "RB-002",
    title: "BGP Neighbor Flap & Peering Instability",
    symptoms: ["Cyclic packet loss spikes", "BGP Peer state transition logs", "High latency oscillations"],
    steps: [
      "Check router BGP summary stats: 'show ip bgp summary' to identify peer session up-time.",
      "Inspect logs for OSPF/BGP Hold Timer expirations (usually indicating Link Layer MTU issues or high jitter).",
      "Apply dampening parameters to flapping prefix ads: 'bgp dampening 15 750 2000 45'.",
      "Increase BGP hold-time to 45 seconds on the local autonomous system border router to allow transient convergence.",
      "Force failover to the pre-routed static backup path (e.g., Branch B to Branch C link) if flapping continues beyond 5 minutes."
    ]
  },
  {
    id: "RB-003",
    title: "IPsec Tunnel Encryption Rekey Failure",
    symptoms: ["Jitter > 30ms", "Packet loss > 10%", "IKE Phase 2 renegotiation errors"],
    steps: [
      "Run 'show crypto isakmp sa' to verify Phase 1 session validity.",
      "Identify anti-replay window drops: 'show crypto ipsec sa | include replay'.",
      "Force dynamic security association re-negotiation by clearing existing states: 'clear crypto sa' or 'clear crypto ipsec sa'.",
      "Verify that pre-shared key (PSK) and cryptographic hashes (AES-GCM-256 / SHA-2) align on both peers.",
      "Temporarily adjust maximum segment size: 'ip tcp adjust-mss 1360' to avoid cryptographic payload fragmentation."
    ]
  },
  {
    id: "RB-004",
    title: "QoS Priority Queue Starvation & Policy Violation",
    symptoms: ["Jitter > 25ms on Voice Class", "High packet loss under medium utilization", "DSCP classification drift"],
    steps: [
      "Verify DSCP markings on incoming traffic. Ensure voice packets are marked EF (Expedited Forwarding) and video is marked AF41.",
      "Run 'show policy-map interface' on the edge router egress to monitor drops in the Priority Queue.",
      "Check if real-time traffic volume exceeds the configured LLQ (Low Latency Queue) bandwidth limit (default 33%).",
      "Increase voice class reservation: set 'priority percent 40' under the WAN interface class policy.",
      "Enable weighted random early detection (WRED) on the default traffic class to prevent TCP synchronization lockups."
    ]
  }
];

// Initial stable topology
const INITIAL_NODES: NetworkNode[] = [
  { id: "BranchA", name: "Branch Office A", type: "branch", status: "healthy", ip: "10.140.12.1" },
  { id: "BranchB", name: "Branch Office B", type: "branch", status: "healthy", ip: "10.140.14.1" },
  { id: "BranchC", name: "Branch Office C", type: "branch", status: "healthy", ip: "10.140.16.1" },
  { id: "Hub", name: "Regional Hub Router", type: "hub", status: "healthy", ip: "10.100.1.1" },
  { id: "DC", name: "Primary Data Center", type: "datacenter", status: "healthy", ip: "10.10.100.2" }
];

const LINK_METRIC_BASES: Record<string, { latency: number, jitter: number, packetLoss: number, utilization: number }> = {
  "BranchA-Hub": { latency: 15, jitter: 1.5, packetLoss: 0.0, utilization: 35 },
  "BranchB-Hub": { latency: 18, jitter: 2.1, packetLoss: 0.0, utilization: 42 },
  "BranchC-Hub": { latency: 16, jitter: 1.8, packetLoss: 0.0, utilization: 28 },
  "Hub-DC": { latency: 5, jitter: 0.8, packetLoss: 0.0, utilization: 45 },
  "BranchB-BranchC": { latency: 28, jitter: 3.2, packetLoss: 0.0, utilization: 12 }
};

// Global in-memory simulation state
let activeFault: "none" | "congestion" | "route_flap" | "tunnel_failure" | "qos_misconfig" = "none";
let tickCount = 0;
let customLogs: { id: string; timestamp: string; level: "INFO" | "WARN" | "CRIT"; message: string; category: string }[] = [];

// Store history of telemetry
const telemetryHistory: Record<string, TelemetryPoint[]> = {};

// Initialize history
const now = new Date();
for (const linkId of Object.keys(LINK_METRIC_BASES)) {
  telemetryHistory[linkId] = [];
  const base = LINK_METRIC_BASES[linkId];
  // Seed last 30 data points with small random variations
  for (let i = 29; i >= 0; i--) {
    const timeOffset = new Date(now.getTime() - i * 10 * 1000); // 10s intervals
    const variance = (Math.random() - 0.5) * 4; // +/-2%
    telemetryHistory[linkId].push({
      timestamp: timeOffset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      latency: Math.max(2, Math.round((base.latency + (Math.random() - 0.5) * 2) * 10) / 10),
      jitter: Math.max(0.2, Math.round((base.jitter + (Math.random() - 0.5) * 0.5) * 10) / 10),
      packetLoss: 0.0,
      utilization: Math.max(5, Math.round(base.utilization + variance))
    });
  }
}

// Add system log helper
function addLog(level: "INFO" | "WARN" | "CRIT", message: string, category: string) {
  const timestamp = new Date().toLocaleTimeString([], { hour12: false });
  customLogs.unshift({
    id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    timestamp,
    level,
    message,
    category
  });
  if (customLogs.length > 100) {
    customLogs.pop();
  }
}

// Populate initial logs
addLog("INFO", "SentinelNOC engine initialized successfully.", "SYSTEM");
addLog("INFO", "Discovered 5 active physical and virtual nodes in Autonomous System AS-65100.", "TOPOLOGY");
addLog("INFO", "Established primary BGP neighbor peering between Hub and DC (Peer IP: 10.10.100.2).", "BGP");
addLog("INFO", "All MPLS fast-reroute (FRR) paths verified and operational.", "MPLS");

// Telemetry updater function - runs on every state fetch or periodic tick
function updateSimulation() {
  tickCount++;
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Update metrics based on active fault
  for (const linkId of Object.keys(LINK_METRIC_BASES)) {
    const base = LINK_METRIC_BASES[linkId];
    const currentPoints = telemetryHistory[linkId];
    const lastPoint = currentPoints[currentPoints.length - 1];

    let nextPoint: TelemetryPoint = {
      timestamp: timeStr,
      latency: lastPoint.latency,
      jitter: lastPoint.jitter,
      packetLoss: lastPoint.packetLoss,
      utilization: lastPoint.utilization
    };

    const noise = () => (Math.random() - 0.5);

    if (activeFault === "none") {
      // Return slowly to normal baseline
      nextPoint.utilization = Math.round(lastPoint.utilization * 0.85 + base.utilization * 0.15 + noise() * 2);
      nextPoint.latency = Math.round((lastPoint.latency * 0.85 + base.latency * 0.15 + noise() * 0.5) * 10) / 10;
      nextPoint.jitter = Math.round((lastPoint.jitter * 0.85 + base.jitter * 0.15 + noise() * 0.2) * 10) / 10;
      nextPoint.packetLoss = Math.max(0, Math.round((lastPoint.packetLoss * 0.8) * 100) / 100);

      // Keep values sensible
      nextPoint.utilization = Math.max(5, Math.min(100, nextPoint.utilization));
      nextPoint.latency = Math.max(1, nextPoint.latency);
      nextPoint.jitter = Math.max(0.1, nextPoint.jitter);
    } else if (activeFault === "congestion") {
      if (linkId === "BranchA-Hub") {
        // Linear increase in utilization
        nextPoint.utilization = Math.min(100, Math.round(lastPoint.utilization + 3 + Math.random() * 2));
        if (nextPoint.utilization > 75) {
          nextPoint.latency = Math.round((lastPoint.latency + 4 + Math.random() * 3) * 10) / 10;
          nextPoint.jitter = Math.round((lastPoint.jitter + 0.4 + Math.random() * 0.3) * 10) / 10;
          nextPoint.packetLoss = Math.min(12, Math.round((lastPoint.packetLoss + 0.15 + Math.random() * 0.1) * 100) / 100);
        } else {
          nextPoint.latency = Math.round((lastPoint.latency + 0.5 + noise() * 0.2) * 10) / 10;
        }
      } else if (linkId === "Hub-DC") {
        // Minor sympathetic traffic rise
        nextPoint.utilization = Math.min(92, Math.round(lastPoint.utilization + 1.2 + noise() * 1));
        if (nextPoint.utilization > 80) {
          nextPoint.latency = Math.round((lastPoint.latency + 0.4 + noise() * 0.1) * 10) / 10;
        }
      } else {
        // Normal random walk
        nextPoint.utilization = Math.max(5, Math.min(100, Math.round(base.utilization + noise() * 3)));
        nextPoint.latency = Math.max(1, Math.round((base.latency + noise() * 1) * 10) / 10);
        nextPoint.jitter = Math.max(0.1, Math.round((base.jitter + noise() * 0.3) * 10) / 10);
        nextPoint.packetLoss = 0.0;
      }
    } else if (activeFault === "route_flap") {
      if (linkId === "Hub-DC") {
        // Flapping cycles (every 4-5 ticks it flips)
        const cycle = tickCount % 5;
        if (cycle === 0 || cycle === 1) {
          // Down/unstable phase
          nextPoint.packetLoss = Math.round((45 + Math.random() * 40) * 10) / 10;
          nextPoint.latency = Math.round((220 + Math.random() * 150) * 10) / 10;
          nextPoint.jitter = Math.round((18 + Math.random() * 12) * 10) / 10;
          nextPoint.utilization = Math.round(15 + Math.random() * 10); // traffic drops because packets are dying
        } else {
          // Re-establishing phase
          nextPoint.packetLoss = Math.round((lastPoint.packetLoss * 0.4) * 10) / 10;
          nextPoint.latency = Math.round((lastPoint.latency * 0.5 + base.latency * 0.5) * 10) / 10;
          nextPoint.jitter = Math.round((lastPoint.jitter * 0.5 + base.jitter * 0.5) * 10) / 10;
          nextPoint.utilization = Math.round(base.utilization + 20 + noise() * 5); // traffic burst on recovery
        }
      } else {
        // Normal random walk
        nextPoint.utilization = Math.max(5, Math.min(100, Math.round(base.utilization + noise() * 3)));
        nextPoint.latency = Math.max(1, Math.round((base.latency + noise() * 1) * 10) / 10);
        nextPoint.jitter = Math.max(0.1, Math.round((base.jitter + noise() * 0.3) * 10) / 10);
        nextPoint.packetLoss = 0.0;
      }
    } else if (activeFault === "tunnel_failure") {
      if (linkId === "BranchB-Hub") {
        // Jitter spikes enormously, packet loss climbs
        nextPoint.jitter = Math.min(80, Math.round((lastPoint.jitter + 2.5 + Math.random() * 2) * 10) / 10);
        nextPoint.packetLoss = Math.min(25, Math.round((lastPoint.packetLoss + 0.4 + Math.random() * 0.3) * 100) / 100);
        nextPoint.latency = Math.round((lastPoint.latency + 0.8 + noise() * 0.3) * 10) / 10;
        nextPoint.utilization = Math.max(10, Math.round(lastPoint.utilization - 0.5 + noise() * 1)); // declining useful throughput
      } else {
        // Normal random walk
        nextPoint.utilization = Math.max(5, Math.min(100, Math.round(base.utilization + noise() * 3)));
        nextPoint.latency = Math.max(1, Math.round((base.latency + noise() * 1) * 10) / 10);
        nextPoint.jitter = Math.max(0.1, Math.round((base.jitter + noise() * 0.3) * 10) / 10);
        nextPoint.packetLoss = 0.0;
      }
    } else if (activeFault === "qos_misconfig") {
      if (linkId === "BranchC-Hub") {
        // Jitter rises to 25-45ms, packet loss rises to 6-12%
        nextPoint.jitter = Math.min(48, Math.round((lastPoint.jitter + 1.8 + Math.random() * 1.5) * 10) / 10);
        nextPoint.packetLoss = Math.min(14, Math.round((lastPoint.packetLoss + 0.3 + Math.random() * 0.2) * 100) / 100);
        nextPoint.latency = Math.round((lastPoint.latency + 0.5 + noise() * 0.2) * 10) / 10;
        nextPoint.utilization = Math.round(base.utilization + 5 + noise() * 2);
      } else {
        // Normal random walk
        nextPoint.utilization = Math.max(5, Math.min(100, Math.round(base.utilization + noise() * 3)));
        nextPoint.latency = Math.max(1, Math.round((base.latency + noise() * 1) * 10) / 10);
        nextPoint.jitter = Math.max(0.1, Math.round((base.jitter + noise() * 0.3) * 10) / 10);
        nextPoint.packetLoss = 0.0;
      }
    }

    // Push new point and slide window
    currentPoints.push(nextPoint);
    if (currentPoints.length > 40) {
      currentPoints.shift();
    }
  }

  // Generate logs matching the state updates to provide realistic NOC streams
  if (activeFault === "congestion" && Math.random() > 0.6) {
    addLog("WARN", "Branch A interface GigabitEthernet0/1 utilization breached warning threshold (75%).", "TRAFFIC");
    addLog("WARN", "Flow ID 10928 from BranchA (10.140.12.5) to DC (10.10.100.22) is saturating LLQ priorities.", "QOS");
  } else if (activeFault === "route_flap" && Math.random() > 0.5) {
    if (tickCount % 5 === 0) {
      addLog("CRIT", "BGP-5-ADJCHANGE: Neighbor 10.10.100.2 down - Hold Timer Expired.", "BGP");
    } else if (tickCount % 5 === 2) {
      addLog("WARN", "BGP-5-ADJCHANGE: Neighbor 10.10.100.2 up - Peering session re-established, initiating full convergence.", "BGP");
    }
  } else if (activeFault === "tunnel_failure" && Math.random() > 0.6) {
    addLog("WARN", "Crypto Engine reports IPSec ESP packet decryption failures on peer 10.140.14.1.", "IPSEC");
    addLog("CRIT", "IKEv2 Security Association rekeying failed. Anti-replay window out-of-sync.", "IPSEC");
  } else if (activeFault === "qos_misconfig" && Math.random() > 0.6) {
    addLog("WARN", "DSCP tagging mismatch detected. expediting priority class packets routing to bulk default class.", "QOS");
    addLog("WARN", "Branch C Router reports LLQ drops: 124 packets discarded in EF Queue Class.", "QOS");
  }
}

// Predict upcoming failures dynamically based on metrics
function getPredictions() {
  const predictions: any[] = [];

  if (activeFault === "none") {
    return [];
  }

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (activeFault === "congestion") {
    const linkPoints = telemetryHistory["BranchA-Hub"];
    const lastPoint = linkPoints[linkPoints.length - 1];
    // Risk escalates as utilization approaches 100
    const riskScore = Math.min(99, Math.round(lastPoint.utilization * 0.95 + 4));
    // Confidence is high if trend is steadily upward
    const confidence = Math.round(85 + (lastPoint.utilization / 10));
    // Calculate dynamic ETA count down
    const etaMin = Math.max(1, Math.round((100 - lastPoint.utilization) * 0.5));

    predictions.push({
      id: "PRED-CONG-01",
      linkId: "BranchA-Hub",
      title: "Branch A WAN Link Failure / Congestion Collapse",
      riskScore,
      confidence,
      eta: `${etaMin} minutes`,
      severity: riskScore > 85 ? "critical" : "warning",
      reason: `Egress interface utilization is currently at ${lastPoint.utilization}% and climbing at 4.2% per minute. Heavy file-sharing and bulk replication signatures detected from local branch subnet.`,
      recommendation: "Apply WAN shaper throttling, redirect replication to secondary link (Branch B-C), or clear policy-map statistics.",
      affectedSites: ["Branch Office A", "Regional Hub Router"]
    });
  } else if (activeFault === "route_flap") {
    const linkPoints = telemetryHistory["Hub-DC"];
    const lastPoint = linkPoints[linkPoints.length - 1];
    const riskScore = 92;
    const confidence = 89;
    const etaMin = Math.max(1, Math.round(10 - (tickCount % 5)));

    predictions.push({
      id: "PRED-BGP-01",
      linkId: "Hub-DC",
      title: "Core BGP Peer Adjacency Termination",
      riskScore,
      confidence,
      eta: `${etaMin} minutes`,
      severity: "critical",
      reason: `Cyclic BGP peering loss detected (3 state-changes in last 90 seconds). High jitter is triggering Peer Hold-Timer timeout (180s expiry). Link is functionally unstable.`,
      recommendation: "Reset the BGP peering neighbor session softly, activate route dampening, or increase peer keepalive to prevent hold-timer dropouts.",
      affectedSites: ["Regional Hub Router", "Primary Data Center"]
    });
  } else if (activeFault === "tunnel_failure") {
    const linkPoints = telemetryHistory["BranchB-Hub"];
    const lastPoint = linkPoints[linkPoints.length - 1];
    const riskScore = Math.min(96, Math.round(lastPoint.packetLoss * 3 + 40));
    const confidence = 86;
    const etaMin = Math.max(1, Math.round(30 - lastPoint.packetLoss));

    predictions.push({
      id: "PRED-VPN-01",
      linkId: "BranchB-Hub",
      title: "IPSec VPN Tunnel Encryption Failure",
      riskScore,
      confidence,
      eta: `${etaMin} minutes`,
      severity: riskScore > 80 ? "critical" : "warning",
      reason: `ESP decryption failure rate reached ${lastPoint.packetLoss}% due to key sequence mismatch (anti-replay window out of bound). Security key negotiation (IKE Phase 2) has timed out.`,
      recommendation: "Force IKE renegotiation with PSK validation or divert all primary encrypted tunnels to Broadband alternate path.",
      affectedSites: ["Branch Office B", "Regional Hub Router"]
    });
  } else if (activeFault === "qos_misconfig") {
    const linkPoints = telemetryHistory["BranchC-Hub"];
    const lastPoint = linkPoints[linkPoints.length - 1];
    const riskScore = Math.min(90, Math.round(lastPoint.jitter * 1.5 + 35));
    const confidence = 82;
    const etaMin = Math.max(2, Math.round(25 - lastPoint.jitter * 0.3));

    predictions.push({
      id: "PRED-QOS-01",
      linkId: "BranchC-Hub",
      title: "Priority Queue Exhaustion & VoIP Starvation",
      riskScore,
      confidence,
      eta: `${etaMin} minutes`,
      severity: "warning",
      reason: `Voice and high-priority video jitter has breached SLA baseline (30ms). Real-time traffic is incorrectly mapped to default class queues on the egress port, inducing starvation under standard loads.`,
      recommendation: "Validate DSCP QoS matches for EF (Expedited Forwarding) class-maps and adjust bandwidth reservation to minimum 33% on Branch C router.",
      affectedSites: ["Branch Office C", "Regional Hub Router"]
    });
  }

  return predictions;
}

function getLocalNocResponse(message: string, activeFault: string, networkState: any): string {
  const textLower = message.toLowerCase();
  
  let explanation = "";
  let threatLevel = "LOW";
  let eta = "N/A";
  let recs: string[] = [];

  // Match specific user questions or fall back to general active fault
  if (activeFault === "congestion" || textLower.includes("congest") || textLower.includes("utiliz") || textLower.includes("branch a")) {
    threatLevel = "CRITICAL / HIGH";
    eta = "3-5 minutes";
    const utilVal = networkState?.links?.find((l: any) => l.id === "BranchA-Hub" || l.name?.includes("Branch A"))?.metrics?.utilization || 92;
    explanation = `Egress interface GigabitEthernet0/1 on Branch A is experiencing extreme traffic saturation, with WAN utilization peaking at ${utilVal}%. Analysis of active flow tables indicates a massive volume of file-sharing and backup database replication flows from the local subnet (10.140.12.0/24) mapped directly to LLQ queue priority structures, causing starvation of production SLA flows.`;
    recs = [
      "Apply egress WAN Traffic Shaper policy to restrict bulk replication bandwidth to 20Mbps: 'policy-map WAN-EDGE -> class class-default -> shape average 20000000'.",
      "Re-route database backup syncs to secondary backup Broadband connections or off-peak hours.",
      "Clear active bottleneck interface statistics: 'clear policy-map interface GigabitEthernet0/1' to allow queue buffers to re-stabilize."
    ];
  } else if (activeFault === "route_flap" || textLower.includes("flap") || textLower.includes("bgp") || textLower.includes("peer") || textLower.includes("converge")) {
    threatLevel = "CRITICAL";
    eta = "1-2 minutes";
    explanation = `The Core Regional Hub to DC BGP peering session (neighbor 10.10.100.2) is experiencing rapid, cyclic route flapping (3 down/up adjacency transitions in the last 90 seconds). This instability triggers immediate routing sweeps across the entire autonomous system, causing substantial convergence overhead and severe packet drops on core trunks.`;
    recs = [
      "Initiate a soft reset of the BGP neighbor session to clear stale tables: 'clear ip bgp 10.10.100.2 soft in'.",
      "Configure Route Dampening on the Regional Hub router to penalize unstable route prefixes: 'bgp dampening'.",
      "Increase neighbor keepalive (30s) and hold-time (90s) timers to buffer transient packet loss from tearing down sessions: 'neighbor 10.10.100.2 timers 30 90'."
    ];
  } else if (activeFault === "tunnel_failure" || textLower.includes("vpn") || textLower.includes("tunnel") || textLower.includes("crypto") || textLower.includes("esp") || textLower.includes("branch b")) {
    threatLevel = "CRITICAL / HIGH";
    eta = "8-12 minutes";
    const lossVal = networkState?.links?.find((l: any) => l.id === "BranchB-Hub" || l.name?.includes("Branch B"))?.metrics?.packetLoss || 12;
    explanation = `The Branch B to Regional Hub IPsec VPN tunnel is experiencing a packet loss rate of ${lossVal}%, with security engines reporting persistent ESP decryption failures. This condition indicates an anti-replay window sync mismatch, typically caused by out-of-order packet arrival across the underlying Broadband trunk. IKE Phase 2 SA rekeying is timing out.`;
    recs = [
      "Force-clear current IKE and IPsec Security Associations to initiate a clean rekey: 'clear crypto ikev2 sa' followed by 'clear crypto ipsec sa'.",
      "Verify that the pre-shared keys (PSK) and Phase 2 proposals (AES-256-GCM, SHA-256) are symmetric on both endpoints.",
      "Divert real-time priority traffic to the Broadband alternate route map while tunnel negotiation completes."
    ];
  } else if (activeFault === "qos_misconfig" || textLower.includes("qos") || textLower.includes("jitter") || textLower.includes("voice") || textLower.includes("branch c")) {
    threatLevel = "MODERATE / WARNING";
    eta = "15 minutes";
    const jitterVal = networkState?.links?.find((l: any) => l.id === "BranchC-Hub" || l.name?.includes("Branch C"))?.metrics?.jitter || 38;
    explanation = `Voice and collaboration services at Branch C are severely degraded due to elevated jitter (${jitterVal}ms). Inspection reveals a QoS class-map configuration drift on the router: Expedited Forwarding (EF) packets (DSCP EF/46) are failing matching rules and falling back to default bulk queues, causing high packet jitter under standard WAN load.`;
    recs = [
      "Inspect current class-map matching criteria using 'show class-map' and 'show policy-map interface'.",
      "Correct classification rules to ensure DSCP EF / 46 packets are correctly matched and prioritised under LLQ.",
      "Ensure the voice traffic class has a guaranteed minimum bandwidth reservation of at least 33% on the Branch C WAN link."
    ];
  } else {
    // Nominal state / help queries
    explanation = `All WAN links, IPsec tunnels, BGP peer sessions, and branch nodes are currently reporting nominal status. System bandwidth utilization is below 45%, jitter is under 5ms, and packet loss is at 0.00%. The autonomous system is operating in optimal baseline condition.`;
    recs = [
      "No active anomalies detected. Standard routine monitoring continues.",
      "Run periodic trace routing sweeps to establish fresh network latency baselines.",
      "Review historical backup queue performance in anticipation of off-peak scheduling."
    ];
  }

  return `### 📡 SentinelNOC Local Backup AI Report (Standard Runbook Operations)

*Note: The primary cloud copilot is temporarily overloaded or unreachable. Activating local security-hardened rule-based diagnostic engine.*

---

#### 🚨 ACTIVE RISK & THREAT EVALUATION
* **Threat Level:** \`${threatLevel}\`
* **Estimated Failure ETA:** \`${eta}\`
* **Primary Impacted Link:** \`${activeFault === "none" ? "None (Nominal)" : activeFault === "congestion" ? "Branch A MPLS" : activeFault === "route_flap" ? "Hub-DC Core Peering" : activeFault === "tunnel_failure" ? "Branch B Tunnel" : "Branch C MPLS"}\`

#### 🔍 ROOT-CAUSE DIAGNOSIS
${explanation}

#### 📋 RECOMMENDED CORRECTIVE REMEDIATION STEPS
${recs.map((r, i) => `${i + 1}. **${r.split(":")[0]}**${r.split(":")[1] || ""}`).join("\n")}

---
*Suggested Action: You can manually apply these fixes using the **Remediate / Clear** buttons in the NOC control deck, or wait for the cloud copilot service to fully restore.*`;
}

let isGeminiOffline = false;

function isFatalGeminiError(err: any): boolean {
  if (!err) return false;
  const errMsg = (err.message || String(err)).toLowerCase();
  
  // 1. Connection / Network failures / Timeouts
  if (errMsg.includes("fetch failed") || errMsg.includes("econnrefused") || errMsg.includes("enotfound") || errMsg.includes("etimedout") || errMsg.includes("timeout")) {
    return true;
  }
  
  // 2. Authentication failures
  if (errMsg.includes("api_key_invalid") || errMsg.includes("api key") || errMsg.includes("invalid key") || errMsg.includes("unauthorized") || err.status === 401 || err.code === 401) {
    return true;
  }
  
  // 3. Permission or Billing issues
  if (err.status === 403 || err.code === 403 || errMsg.includes("billing") || errMsg.includes("quota")) {
    return true;
  }
  
  return false;
}

// Helper to perform Gemini API generation with model fallbacks and retries on transient errors (like 503)
async function generateContentWithFallback(contents: any[], systemInstruction: string, temperature: number) {
  // Validate API key beforehand to avoid useless network timeouts
  const key = process.env.GEMINI_API_KEY;
  const isKeyValid = key && 
                     key.trim() !== "" && 
                     !key.includes("your_api_key") && 
                     !key.includes("placeholder");

  if (!isKeyValid) {
    throw new Error("GEMINI_API_KEY is not configured or is set to a placeholder.");
  }

  // Two model options are more than enough. If both fail/timeout, we instantly fall back to local engine.
  const models = [
    "gemini-3.5-flash",
    "gemini-2.5-flash"
  ];
  let lastError: any = null;

  for (const model of models) {
    try {
      console.log(`[SentinelNOC AI] Querying model: ${model} with active 5-second timeout watchdog...`);
      
      const apiCall = ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          temperature,
        }
      });

      // 5-second fast watchdog timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("API request timed out (5s)")), 5000);
      });

      // Race the API call against our timeout watchdog
      const response = await Promise.race([apiCall, timeoutPromise]);
      
      if (response) {
        console.log(`[SentinelNOC AI] Successfully generated response with model: ${model}`);
        isGeminiOffline = false; // Reset offline status upon success
        return response;
      }
    } catch (err: any) {
      lastError = err;
      console.error(`[SentinelNOC AI] Error/timeout with model ${model}:`, err?.message || err);
      
      // If it is a fatal non-transient error or a timeout, fast-fail the chain immediately
      if (isFatalGeminiError(err)) {
        console.log(`[SentinelNOC AI] Fast-failing fallback chain due to error/timeout: "${err.message || err}". Marking Gemini offline.`);
        isGeminiOffline = true; // Mark as offline to short-circuit future calls
        throw err;
      }
    }
  }

  throw lastError || new Error("All fallback models failed.");
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // API endpoints

  // 1. Get current simulated network state
  app.get("/api/state", (req, res) => {
    updateSimulation(); // tick on fetch
    
    // Nodes state update based on links
    const currentNodes = INITIAL_NODES.map(node => {
      let status: "healthy" | "warning" | "critical" = "healthy";
      
      // Determine node status based on its active links
      if (activeFault === "congestion" && (node.id === "BranchA" || node.id === "Hub")) {
        const lastP = telemetryHistory["BranchA-Hub"][telemetryHistory["BranchA-Hub"].length - 1];
        status = lastP.utilization > 85 ? "critical" : "warning";
      } else if (activeFault === "route_flap" && (node.id === "Hub" || node.id === "DC")) {
        status = "critical";
      } else if (activeFault === "tunnel_failure" && (node.id === "BranchB" || node.id === "Hub")) {
        const lastP = telemetryHistory["BranchB-Hub"][telemetryHistory["BranchB-Hub"].length - 1];
        status = lastP.packetLoss > 10 ? "critical" : "warning";
      } else if (activeFault === "qos_misconfig" && (node.id === "BranchC" || node.id === "Hub")) {
        const lastP = telemetryHistory["BranchC-Hub"][telemetryHistory["BranchC-Hub"].length - 1];
        status = lastP.jitter > 25 ? "warning" : "healthy";
      }
      return { ...node, status };
    });

    // Links state
    const currentLinks = Object.keys(LINK_METRIC_BASES).map(linkId => {
      const history = telemetryHistory[linkId];
      const metrics = history[history.length - 1];
      const baseInfo = LINK_METRIC_BASES[linkId];
      
      let source = "Hub";
      let target = "DC";
      let name = "";
      
      if (linkId === "BranchA-Hub") { source = "BranchA"; target = "Hub"; name = "Branch A to Hub MPLS Link"; }
      else if (linkId === "BranchB-Hub") { source = "BranchB"; target = "Hub"; name = "Branch B to Hub Tunnel"; }
      else if (linkId === "BranchC-Hub") { source = "BranchC"; target = "Hub"; name = "Branch C to Hub MPLS Link"; }
      else if (linkId === "Hub-DC") { source = "Hub"; target = "DC"; name = "Core Regional Hub to DC Link"; }
      else if (linkId === "BranchB-BranchC") { source = "BranchB"; target = "BranchC"; name = "Branch B to C Backup Path"; }

      return {
        id: linkId,
        source,
        target,
        name,
        type: linkId === "BranchB-BranchC" ? "backup" : (linkId === "BranchB-Hub" ? "broadband" : "mpls"),
        metrics
      };
    });

    const predictions = getPredictions();

    res.json({
      nodes: currentNodes,
      links: currentLinks,
      history: telemetryHistory,
      activeFault,
      predictions,
      logs: customLogs.slice(0, 35) // send top 35 logs
    });
  });

  // 2. Inject specific fault
  app.post("/api/inject-fault", (req, res) => {
    const { fault } = req.body;
    if (["congestion", "route_flap", "tunnel_failure", "qos_misconfig", "none"].includes(fault)) {
      activeFault = fault;
      addLog("WARN", `Fault injection event: [${fault.toUpperCase()}] triggered by NOC Admin.`, "SIMULATOR");
      
      // Reset history baseline slightly to accelerate the visual trend change
      for (const linkId of Object.keys(LINK_METRIC_BASES)) {
        const history = telemetryHistory[linkId];
        const last = history[history.length - 1];
        if (fault === "congestion" && linkId === "BranchA-Hub") {
          last.utilization = 60; // kickstart rise
        } else if (fault === "route_flap" && linkId === "Hub-DC") {
          last.packetLoss = 20;
        } else if (fault === "tunnel_failure" && linkId === "BranchB-Hub") {
          last.jitter = 15;
        } else if (fault === "qos_misconfig" && linkId === "BranchC-Hub") {
          last.jitter = 12;
        }
      }

      res.json({ success: true, activeFault });
    } else {
      res.status(400).json({ error: "Invalid fault type" });
    }
  });

  // 3. Resolve all faults
  app.post("/api/resolve-faults", (req, res) => {
    activeFault = "none";
    addLog("INFO", "NOC Admin executed global fault clearance sequence. Recalibrating state.", "SIMULATOR");
    res.json({ success: true, activeFault });
  });

  // 4. NOC Runbooks retrieval
  app.get("/api/runbooks", (req, res) => {
    res.json(RUNBOOKS);
  });

  // 5. Copilot AI chat proxy (utilizing the pre-seeded Runbooks & current real-time state)
  app.post("/api/copilot", async (req, res) => {
    const { message, chatHistory, networkState } = req.body;
    let matchedRb: Runbook | null = null;
    const textLower = (message || "").toLowerCase();

    // Check if the user wants to retry/reconnect online mode
    if (textLower.includes("retry api") || textLower.includes("retry online") || textLower.includes("reconnect")) {
      console.log("[SentinelNOC AI] Manual API reconnection request received. Attempting to bring Gemini online...");
      isGeminiOffline = false;
    }

    // Standard RAG Search to find matching runbooks (used for both online and local offline fallback)
    if (textLower.includes("congest") || textLower.includes("utiliz") || textLower.includes("slow") || textLower.includes("traffic") || textLower.includes("branch a")) {
      matchedRb = RUNBOOKS[0];
    } else if (textLower.includes("bgp") || textLower.includes("flap") || textLower.includes("peer") || textLower.includes("converge")) {
      matchedRb = RUNBOOKS[1];
    } else if (textLower.includes("vpn") || textLower.includes("tunnel") || textLower.includes("crypto") || textLower.includes("rekey") || textLower.includes("esp") || textLower.includes("branch b")) {
      matchedRb = RUNBOOKS[2];
    } else if (textLower.includes("qos") || textLower.includes("jitter") || textLower.includes("voice") || textLower.includes("dsc") || textLower.includes("starv") || textLower.includes("branch c")) {
      matchedRb = RUNBOOKS[3];
    }

    if (isGeminiOffline) {
      console.log("[SentinelNOC AI] Gemini is marked offline. Skipping API call to prevent hang, returning high-fidelity local RAG response immediately.");
      const activeFault = networkState?.activeFault || "none";
      const fallbackText = getLocalNocResponse(message, activeFault, networkState);
      return res.json({ 
        response: fallbackText, 
        matchedRunbook: matchedRb,
        isFallback: true,
        errorDetails: "Gemini is marked offline due to previous network timeouts."
      });
    }

    try {
      // Basic Local RAG Search based on message content
      let matchedRunbookContext = "";

      if (matchedRb) {
        matchedRunbookContext = `
[RELEVANT RUNBOOK RETRIEVED (LOCAL KNOWLEDGE BASE RAG)]:
ID: ${matchedRb.id}
Title: ${matchedRb.title}
Symptoms: ${matchedRb.symptoms.join(", ")}
Standard Recommended Steps:
${matchedRb.steps.map((s, idx) => `${idx + 1}. ${s}`).join("\n")}
`;
      } else {
        matchedRunbookContext = `
[NO EXPLICIT MATCHING RUNBOOK FOUND FOR THREAT CLASS]
Please cross-reference current live telemetry metrics to deduce root-cause. Standard WAN failover practices apply.
`;
      }

      const activePreds = networkState?.predictions || [];
      const currentMetricsStr = JSON.stringify(networkState?.links?.map((l: any) => ({
        link: l.name,
        type: l.type,
        utilization: `${l.metrics?.utilization}%`,
        latency: `${l.metrics?.latency}ms`,
        jitter: `${l.metrics?.jitter}ms`,
        packetLoss: `${l.metrics?.packetLoss}%`
      })) || []);

      const activeFaultStr = networkState?.activeFault || "none";

      const systemInstruction = `You are "SentinelNOC Copilot", an air-gapped, security-compliant, predictive AI Network Operations Center (NOC) assistant.
You sit directly on a local air-gapped machine with zero outbound internet access.
Your primary mandate is to aid NOC engineers with three critical, human-readable answers in real time:
1. WHAT is likely to fail next and when (with risk score, confidence, and ETA).
2. WHY the risk is elevated (explaining telemetry anomalies simply and tracing root-cause).
3. WHAT corrective steps should be applied based strictly on local runbooks.

Always keep your tone highly professional, precise, direct, and slightly technical (cyber/network NOC theme).
Do NOT apologize excessively or state that you are an AI. Speak like a senior NOC network reliability expert.
Use Markdown formatting beautifully, incorporating code segments, bold labels, and neat bullet lists.

Below is the CURRENT LIVE TELEMETRY AND TOPOLOGY STATE:
- Active Fault Mode Injected: ${activeFaultStr.toUpperCase()}
- Current Link Metrics: ${currentMetricsStr}
- Currently Active Predictive Alerts: ${JSON.stringify(activePreds)}

${matchedRunbookContext}

Use the above real-time data and retrieved runbooks to ground your response completely. Do NOT make up metrics or IP addresses. If the user asks why a risk is high or what to do, refer directly to the live values and standard steps in the retrieved runbook.`;

      // Build chat contents format compatible with @google/genai chats
      const promptText = `User Engineer Query: "${message}"\n\nPlease answer the query using the system instructions, matching metrics, and retrieved runbooks above. Always be clear and actionable.`;

      const contents: any[] = [];
      // Append some previous chat history if available
      if (chatHistory && Array.isArray(chatHistory)) {
        for (const turn of chatHistory.slice(-4)) { // last 4 turns
          contents.push({
            role: turn.role === "user" ? "user" : "model",
            parts: [{ text: turn.content }]
          });
        }
      }
      contents.push({
        role: "user",
        parts: [{ text: promptText }]
      });

      const response = await generateContentWithFallback(contents, systemInstruction, 0.2);

      const textOutput = response.text || "Could not retrieve automated copilot analysis.";
      res.json({ response: textOutput, matchedRunbook: matchedRb });
    } catch (err: any) {
      console.error("Gemini Copilot Error:", err);
      const errMsg = err?.message || String(err);
      
      try {
        console.log("[SentinelNOC AI] Initiating high-fidelity local RAG rule-based fallback...");
        const activeFault = networkState?.activeFault || "none";
        const fallbackText = getLocalNocResponse(message, activeFault, networkState);
        
        res.json({ 
          response: fallbackText, 
          matchedRunbook: matchedRb,
          isFallback: true,
          errorDetails: errMsg
        });
      } catch (fallbackErr) {
        console.error("Critical fallback failure:", fallbackErr);
        res.status(500).json({ 
          error: "Failed to generate AI Copilot response.",
          details: errMsg,
          isOverloaded: errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("high demand") || errMsg.includes("TEMPORARY")
        });
      }
    }
  });

  // Vite development integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SentinelNOC full-stack backend running on port ${PORT}`);
  });
}

startServer();
