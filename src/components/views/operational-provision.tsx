"use client";
import { useQuery } from "@tanstack/react-query";
import { listProvisionJobs, syncBackend } from "@/services/backend";
import { AgentProvisionForm } from "./ssh-provision-form";
export function OperationalProvisionView() {
  const query = useQuery({ queryKey: ["provision-availability"], queryFn: listProvisionJobs });
  return <AgentProvisionForm enabled={Boolean(query.data?.enabled)} onDone={() => { void syncBackend(); }} />;
}
