const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "check-host.net") {
    const nodes = { "a.node.check-host.net": ["de", "Germany", "Berlin"], "b.node.check-host.net": ["fi", "Finland", "Helsinki"] };
    if (url.pathname === "/check-ping" && url.searchParams.get("host") === "8.8.4.4") {
      return Promise.resolve(Response.json({ ok: 1, request_id: "fixture1", nodes }));
    }
    if (url.pathname === "/check-result/fixture1") {
      return Promise.resolve(Response.json({ "a.node.check-host.net": [[["OK", 0.04], ["TIMEOUT", 3]]], "b.node.check-host.net": [[null]] }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  }
  if (url.hostname !== "ipwho.is") return original(input, options);
  const ip = url.pathname.slice(1);
  const metadata = {
    "8.8.4.4": { country: "United States", country_code: "US", connection: { isp: "Google LLC" } },
    "1.0.0.1": { country: "Australia", country_code: "AU", connection: { isp: "Cloudflare, Inc." } },
  }[ip];
  return Promise.resolve(Response.json(metadata ? { success: true, ip, ...metadata } : { success: false }));
};
