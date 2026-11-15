import type { ForwarderSettings } from "./forwarder-config";

export type ForwarderListener = { host: string; port: number; protocol: "tcp" | "udp" };

function binding(address: string, protocol: "tcp" | "udp" = "tcp"): ForwarderListener {
  const match = /^(.*):(\d+)$/.exec(address);
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535) throw new Error("Invalid listener address");
  return { host: match[1].replace(/^\[|\]$/g, "").toLowerCase(), port, protocol };
}

export function forwarderListeners(settings: ForwarderSettings, side: "iran" | "foreign"): ForwarderListener[] {
  const listeners: ForwarderListener[] = [];
  if (settings.technology === "Rathole") {
    if (side === "iran") {
      listeners.push(binding(settings.iran.options.bind_addr));
      for (const service of Object.values(settings.iran.options.services)) listeners.push(binding(service.bind_addr, service.type));
    }
  } else {
    const options = settings[side].options;
    if (options.web_port) listeners.push({ host: "0.0.0.0", port: options.web_port, protocol: "tcp" });
    if (side === "iran") {
      listeners.push(binding(settings.iran.options.bind_addr));
      for (const mapping of settings.iran.options.ports) {
        let local = mapping.split("=", 1)[0].trim();
        // Backhaul also accepts a legacy local-range:destination-port form.
        if (/^\d+(?:-\d+)?:\d+$/.test(local)) local = local.split(":", 1)[0];
        const match = /^(?:(\[[^\]]+\]|[^:]+):)?(\d+)(?:-(\d+))?$/.exec(local);
        const first = Number(match?.[2]), last = Number(match?.[3] ?? first);
        if (!match || first < 1 || last < first || last > 65535) throw new Error("Invalid Backhaul port mapping");
        for (let port = first; port <= last; port++) {
          const listener = { host: (match[1] ?? "0.0.0.0").replace(/^\[|\]$/g, "").toLowerCase(), port, protocol: "tcp" as const };
          listeners.push(listener);
          if (settings.iran.options.accept_udp) listeners.push({ ...listener, protocol: "udp" });
        }
      }
    }
  }
  return listeners;
}

export function listenersOverlap(a: ForwarderListener, b: ForwarderListener) {
  return a.port === b.port && a.protocol === b.protocol &&
    (a.host === b.host || ["", "0.0.0.0", "::", "*"].includes(a.host) || ["", "0.0.0.0", "::", "*"].includes(b.host));
}

export function forwarderControlPort(settings: ForwarderSettings) {
  return binding(settings.iran.options.bind_addr).port;
}
