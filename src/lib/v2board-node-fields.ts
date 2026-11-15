export const panelNodeTypes = ["vmess", "vless", "shadowsocks", "trojan", "hysteria"] as const;
export type PanelNodeType = (typeof panelNodeTypes)[number];
export type PanelField = {
  key: string;
  label: string;
  kind?: "number" | "ids" | "tags" | "groups" | "routes" | "parent" | "json";
  required?: boolean;
  initial?: string;
  choices?: readonly string[];
  subfields?: readonly { key: string; label: string; choices?: readonly string[]; numeric?: boolean }[];
};

const networks = ["tcp", "kcp", "ws", "http", "domainsocket", "quic", "grpc", "httpupgrade", "splithttp"];
const network = { key: "network", label: "nodes.panel.network", required: true, initial: "tcp", choices: networks };
const serverName = { key: "server_name", label: "nodes.panel.sni" };
const insecure = { key: "insecure", label: "nodes.panel.allowInsecure", kind: "number", choices: ["0", "1"], initial: "0" } as const;

const common: PanelField[] = [
  { key: "name", label: "nodes.panel.name", required: true },
  { key: "location", label: "nodes.panel.location" },
  { key: "host", label: "nodes.panel.host", required: true },
  { key: "port", label: "nodes.panel.port", required: true, initial: "443" },
  { key: "server_port", label: "nodes.panel.serverPort", required: true, initial: "443" },
  { key: "group_id", label: "nodes.panel.groups", kind: "groups", required: true },
  { key: "route_id", label: "nodes.panel.routes", kind: "routes" },
  { key: "parent_id", label: "nodes.panel.parent", kind: "parent" },
  { key: "rate", label: "nodes.panel.rate", kind: "number", required: true, initial: "1" },
  { key: "tags", label: "nodes.panel.tags", kind: "tags" },
  { key: "show", label: "nodes.panel.show", kind: "number", choices: ["0", "1"], initial: "0" },
];

const protocolFields: Record<PanelNodeType, PanelField[]> = {
  vmess: [network,
    { key: "tls", label: "nodes.panel.tls", kind: "number", required: true, choices: ["0", "1"], initial: "0" },
    { key: "networkSettings", label: "nodes.panel.transfer", kind: "json" },
    { key: "tlsSettings", label: "nodes.panel.tlsSettings", kind: "json" },
    { key: "ruleSettings", label: "nodes.panel.rules", kind: "json" },
    { key: "dnsSettings", label: "nodes.panel.dnsSettings", kind: "json" },
  ],
  vless: [network,
    { key: "tls", label: "nodes.panel.tlsReality", kind: "number", required: true, choices: ["0", "1", "2"], initial: "0" },
    { key: "flow", label: "nodes.panel.flow", choices: ["xtls-rprx-vision"] },
    { key: "encryption", label: "nodes.panel.vlessEncryption", choices: ["mlkem768x25519plus"] },
    { key: "network_settings", label: "nodes.panel.transfer", kind: "json" },
    { key: "tls_settings", label: "nodes.panel.tlsRealitySettings", kind: "json", subfields: [
      { key: "server_name", label: "nodes.panel.sni" }, { key: "dest", label: "nodes.panel.realityDest" },
      { key: "server_port", label: "nodes.panel.realityPort" }, { key: "xver", label: "nodes.panel.proxyProtocol", choices: ["0", "1", "2"], numeric: true },
      { key: "private_key", label: "nodes.panel.realityPrivate" }, { key: "public_key", label: "nodes.panel.realityPublic" },
      { key: "short_id", label: "nodes.panel.shortId" }, { key: "fingerprint", label: "nodes.panel.fingerprint" },
      { key: "allow_insecure", label: "nodes.panel.allowInsecure", choices: ["0", "1"] },
    ] },
    { key: "encryption_settings", label: "nodes.panel.vlessKeys", kind: "json", subfields: [
      { key: "mode", label: "nodes.panel.encMode", choices: ["native", "xorpub", "random"] },
      { key: "ticket", label: "nodes.panel.ticket" }, { key: "rtt", label: "nodes.panel.handshake", choices: ["1rtt", "0rtt"] },
      { key: "private_key", label: "nodes.panel.privateSeed" }, { key: "public_key", label: "nodes.panel.publicClient" },
      { key: "server_padding", label: "nodes.panel.serverPadding" }, { key: "client_padding", label: "nodes.panel.clientPadding" },
    ] },
    { key: "sort", label: "nodes.panel.sort", kind: "number" },
  ],
  shadowsocks: [
    { key: "cipher", label: "nodes.panel.cipher", required: true, initial: "aes-256-gcm", choices: [
      "aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm",
    ] },
    { key: "obfs", label: "nodes.panel.obfs", choices: ["http"] },
    { key: "obfs_settings", label: "nodes.panel.obfsSettings", kind: "json", subfields: [
      { key: "host", label: "nodes.panel.obfsHost" }, { key: "path", label: "nodes.panel.obfsPath" },
    ] },
  ],
  trojan: [network, serverName,
    { ...insecure, key: "allow_insecure" },
    { key: "network_settings", label: "nodes.panel.transfer", kind: "json" },
  ],
  hysteria: [
    { key: "version", label: "nodes.panel.hysteriaVersion", kind: "number", required: true, choices: ["1", "2"], initial: "2" },
    serverName, { ...insecure, required: true },
    { key: "up_mbps", label: "nodes.panel.up", kind: "number", required: true, initial: "100" },
    { key: "down_mbps", label: "nodes.panel.down", kind: "number", required: true, initial: "100" },
    { key: "obfs", label: "nodes.panel.obfs" },
    { key: "obfs_password", label: "nodes.panel.obfsPassword" },
  ],
};

export const panelNodeFields = (type: PanelNodeType) => [...common, ...protocolFields[type]];

export type PanelAdminNode = {
  id: number;
  type: PanelNodeType;
  fields: Record<string, unknown>;
  revision: string;
};

export type PanelAdminNodes = {
  nodes: PanelAdminNode[];
  groups: { id: number; name: string }[];
  routes: { id: number; name: string }[];
};
