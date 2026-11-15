import type { MessageTree } from "./translate";
import enCommon from "./locales/en-US/common.json";
import faCommon from "./locales/fa-IR/common.json";
import enDashboard from "./locales/en-US/dashboard.json";
import faDashboard from "./locales/fa-IR/dashboard.json";
import enMonitoring from "./locales/en-US/monitoring.json";
import faMonitoring from "./locales/fa-IR/monitoring.json";
import enErrors from "./locales/en-US/errors.json";
import faErrors from "./locales/fa-IR/errors.json";
import enNodes from "./locales/en-US/nodes.json";
import faNodes from "./locales/fa-IR/nodes.json";
import enServers from "./locales/en-US/servers.json";
import faServers from "./locales/fa-IR/servers.json";
import enTunnels from "./locales/en-US/tunnels.json";
import faTunnels from "./locales/fa-IR/tunnels.json";
import enDns from "./locales/en-US/dns.json";
import faDns from "./locales/fa-IR/dns.json";
import enDeployments from "./locales/en-US/deployments.json";
import faDeployments from "./locales/fa-IR/deployments.json";
import enSettings from "./locales/en-US/settings.json";
import faSettings from "./locales/fa-IR/settings.json";
import enIntegrations from "./locales/en-US/integrations.json";
import faIntegrations from "./locales/fa-IR/integrations.json";
import enAlerts from "./locales/en-US/alerts.json";
import faAlerts from "./locales/fa-IR/alerts.json";
import enLogs from "./locales/en-US/logs.json";
import faLogs from "./locales/fa-IR/logs.json";
import enReports from "./locales/en-US/reports.json";
import faReports from "./locales/fa-IR/reports.json";
import enSpeedtest from "./locales/en-US/speedtest.json";
import faSpeedtest from "./locales/fa-IR/speedtest.json";

type Mirror<T> = { [K in keyof T]: T[K] extends string ? string : T[K] extends Record<string, unknown> ? Mirror<T[K]> : never };

function sameShape<T>(messages: Mirror<T>): Mirror<T> {
  return messages;
}

export const enUS = {
  common: enCommon,
  dashboard: enDashboard,
  monitoring: enMonitoring,
  errors: enErrors,
  nodes: enNodes,
  servers: enServers,
  tunnels: enTunnels,
  dns: enDns,
  deployments: enDeployments,
  settings: enSettings,
  integrations: enIntegrations,
  alerts: enAlerts,
  logs: enLogs,
  reports: enReports,
  speedtest: enSpeedtest,
} satisfies MessageTree;

export const faIR = {
  common: sameShape<typeof enCommon>(faCommon),
  dashboard: sameShape<typeof enDashboard>(faDashboard),
  monitoring: sameShape<typeof enMonitoring>(faMonitoring),
  errors: sameShape<typeof enErrors>(faErrors),
  nodes: sameShape<typeof enNodes>(faNodes),
  servers: sameShape<typeof enServers>(faServers),
  tunnels: sameShape<typeof enTunnels>(faTunnels),
  dns: sameShape<typeof enDns>(faDns),
  deployments: sameShape<typeof enDeployments>(faDeployments),
  settings: sameShape<typeof enSettings>(faSettings),
  integrations: sameShape<typeof enIntegrations>(faIntegrations),
  alerts: sameShape<typeof enAlerts>(faAlerts),
  logs: sameShape<typeof enLogs>(faLogs),
  reports: sameShape<typeof enReports>(faReports),
  speedtest: sameShape<typeof enSpeedtest>(faSpeedtest),
} satisfies MessageTree;

export type Catalog = typeof enUS;
