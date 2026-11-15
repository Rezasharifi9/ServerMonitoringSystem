import assert from "node:assert/strict";
import { agentIsSilent, failoverCause, hostSilenceFailover } from "../src/server/failover-silence.ts";

const now = 1_000_000;
const windowMs = 300_000;
const silent = now - windowMs - 1;
const fresh = now - 10_000;
const down = agentIsSilent({ now, windowMs, heartbeatAt: silent, latestReportAt: silent });
const up = agentIsSilent({ now, windowMs, heartbeatAt: fresh, latestReportAt: fresh });

assert.equal(down, true);
assert.equal(up, false);
assert.equal(failoverCause({ tunnelStatus: "offline", packetLoss: 0, lossThreshold: 50, agentSilent: false }), "offline");
assert.equal(failoverCause({ tunnelStatus: "healthy", packetLoss: 50, lossThreshold: 50, agentSilent: false }), "loss");
assert.equal(failoverCause({ tunnelStatus: "healthy", packetLoss: 0, lossThreshold: 50, agentSilent: true }), "agent");
assert.equal(failoverCause({ tunnelStatus: "healthy", packetLoss: 0, lossThreshold: 50, agentSilent: false }), null);
assert.equal(hostSilenceFailover({ now, windowMs, heartbeatAt: silent, latestReportAt: silent, ping: "reachable" }), false);
console.log("PASS: failover uses tunnel offline, packet loss, or a silent agent.");
