"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createInfraWorkflows, type InfraState } from "@/stores/infra-workflows";
import type { RuntimeBag } from "@/stores/runtime";

let localPersistence = true;

export function setLocalPersistence(enabled: boolean) {
  localPersistence = enabled;
}

export const useInfraStore = create<InfraState>()(
  persist(
    createInfraWorkflows(),
    {
      name: "nodeguard-demo-v1",
      storage: createJSONStorage(() => ({
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => { if (localPersistence) localStorage.setItem(key, value); },
        removeItem: (key) => localStorage.removeItem(key),
      })),
      version: 1,
      partialize: (state) => {
        const data: RuntimeBag = {
          nodes: state.nodes,
          servers: state.servers,
          tunnels: state.tunnels,
          dns: state.dns,
          alerts: state.alerts,
          incidents: state.incidents,
          failoverEvents: state.failoverEvents,
          policies: state.policies,
          audit: state.audit,
          deployments: state.deployments,
          speedtests: state.speedtests,
          logs: state.logs.slice(-250),
          integrations: state.integrations,
          settings: state.settings,
          users: state.users,
          currentUserId: state.currentUserId,
          failoverRun: state.failoverRun ? { ...state.failoverRun, running: false } : null,
        };
        return data as InfraState;
      },
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as InfraState),
        hydrated: true,
        speedtestRun: null,
        liveLogs: false,
        failoverRun: (persisted as InfraState | undefined)?.failoverRun
          ? { ...(persisted as InfraState).failoverRun!, running: false }
          : null,
      }),
    },
  ),
);

export function useCurrentUser() {
  return useInfraStore((state) => state.users.find((user) => user.id === state.currentUserId) ?? state.users[0]);
}
