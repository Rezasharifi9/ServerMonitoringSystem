"use client";

import {
  Activity,
  Cable,
  Gauge,
  Globe,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  Shield,
  Siren,
  Workflow,
} from "lucide-react";

export const NAV = [
  { href: "/", labelKey: "common.nav.dashboard", icon: LayoutDashboard },
  { href: "/nodes", labelKey: "common.nav.nodes", icon: Workflow },
  { href: "/servers", labelKey: "common.nav.servers", icon: Server },
  { href: "/tunnels", labelKey: "common.nav.tunnels", icon: Cable },
  { href: "/speedtest", labelKey: "common.nav.speedtest", icon: Gauge },
  { href: "/logs", labelKey: "common.nav.logs", icon: ScrollText },
  { href: "/dns", labelKey: "common.nav.dns", icon: Globe },
  { href: "/health", labelKey: "common.nav.health", icon: Activity },
  { href: "/alerts", labelKey: "common.nav.alerts", icon: Siren },
  { href: "/monitoring", labelKey: "common.nav.monitoring", icon: Activity },
  { href: "/reports", labelKey: "common.nav.reports", icon: Shield },
  { href: "/settings", labelKey: "common.nav.settings", icon: Settings },
];

export function crumbsFor(pathname: string) {
  const map: Record<string, string> = {
    "/": "common.nav.dashboard",
    "/nodes": "common.nav.nodes",
    "/servers": "common.nav.servers",
    "/tunnels": "common.nav.tunnels",
    "/tunnels/new": "common.nav.newTunnel",
    "/speedtest": "common.nav.speedtest",
    "/logs": "common.nav.logs",
    "/dns": "common.nav.dns",
    "/deployments": "common.nav.deployments",
    "/health": "common.nav.health",
    "/alerts": "common.nav.alerts",
    "/monitoring": "common.nav.monitoring",
    "/reports": "common.nav.reports",
    "/integrations": "common.nav.integrations",
    "/settings": "common.nav.settings",
  };
  if (map[pathname]) return [{ href: pathname, labelKey: map[pathname] }];
  if (pathname.startsWith("/nodes/")) return [{ href: "/nodes", labelKey: "common.nav.nodes" }, { href: pathname, labelKey: "common.nav.nodeDetails" }];
  if (pathname.startsWith("/servers/")) return [{ href: "/servers", labelKey: "common.nav.servers" }, { href: pathname, labelKey: "common.nav.serverDetails" }];
  if (pathname.startsWith("/tunnels/")) return [{ href: "/tunnels", labelKey: "common.nav.tunnels" }, { href: pathname, labelKey: "common.nav.tunnelDetails" }];
  if (pathname.startsWith("/dns/")) return [{ href: "/dns", labelKey: "common.nav.dns" }, { href: pathname, labelKey: "common.nav.dnsDetails" }];
  return [{ href: "/", labelKey: "common.nav.dashboard" }];
}
