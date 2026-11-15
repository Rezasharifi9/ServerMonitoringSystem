import { t } from "@/i18n/runtime";

/**
 * Versioned integration adapters.
 * V2Board and V2bX do not share one stable admin API across releases.
 * These interfaces are the extension point for a real backend.
 */

export interface PanelNode {
  id: string;
  name: string;
  host: string;
  protocol: string;
}

export interface V2BoardAdapter {
  id: string;
  version: string;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  syncNodes(): Promise<{ imported: number; nodes: PanelNode[] }>;
}

export interface V2bXAdapter {
  id: string;
  version: string;
  readSharedLog(serverId: string): Promise<string[]>;
  readNodeLog(serverId: string, nodeId: string): Promise<string[]>;
}

export const v2boardAdminV1: V2BoardAdapter = {
  id: "v2board-admin-v1",
  version: "v2board admin v1 (demo)",
  async testConnection() {
    return { ok: true, message: t("integrations.demoAdapterSample") };
  },
  async syncNodes() {
    return { imported: 24, nodes: [] };
  },
};

export const v2bxLegacy: V2bXAdapter = {
  id: "v2bx-0.8-demo",
  version: "V2bX 0.8 demo",
  async readSharedLog() {
    return ["[V2bX] shared service log"];
  },
  async readNodeLog(_serverId: string, nodeId: string) {
    return [`[V2bX] node ${nodeId} log`];
  },
};
