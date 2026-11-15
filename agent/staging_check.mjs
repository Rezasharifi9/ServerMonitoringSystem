import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: { node: { type: "string" }, since: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    console.log("node agent/staging_check.mjs --node NODE_ID [--since ISO_TIME]");
    console.log("Set NODEGUARD_CONTROL_URL and NODEGUARD_STAGING_TOKEN to a read-only NodeGuard operator token.");
    return 0;
  }
  const id = values.node;
  if (!id || !/^[a-z\d][a-z\d_.:-]{0,95}$/i.test(id)) throw new Error("Set --node to the canary node ID");
  const endpoint = URL.parse(process.env.NODEGUARD_CONTROL_URL ?? "http://127.0.0.1:3000");
  const local = endpoint && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (!endpoint || !(endpoint.protocol === "https:" || (local && endpoint.protocol === "http:")) ||
      endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Set NODEGUARD_CONTROL_URL to the HTTPS control plane origin");
  }
  const token = process.env.NODEGUARD_STAGING_TOKEN ?? "";
  if (!/^[^\s]{32,256}$/.test(token)) throw new Error("Set NODEGUARD_STAGING_TOKEN to a read-only operator token");
  const url = new URL("/api/v1/staging/readiness", endpoint);
  url.searchParams.set("nodeId", id);
  if (values.since) url.searchParams.set("since", values.since);
  const response = await fetch(url, {
    method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(12000),
  }).catch(() => null);
  if (!response) throw new Error("The NodeGuard staging endpoint could not be reached");
  if (!response.ok) throw new Error("The NodeGuard staging endpoint returned HTTP " + response.status);
  const data = (await response.json().catch(() => null))?.data;
  if (typeof data?.ready !== "boolean" || (values.since && typeof data.evidence?.complete !== "boolean")) {
    throw new Error("Unexpected staging report");
  }
  console.log(JSON.stringify(data, null, 2));
  return data.ready && (!values.since || data.evidence.complete) ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
