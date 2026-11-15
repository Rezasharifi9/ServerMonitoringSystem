"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmButton, Tech } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui/kit";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useFormat, useI18n } from "@/i18n/provider";
import { fetchAgentInstaller, getAgentRegistration, issueAgentInvitation, revokeAgentCredential, syncBackend } from "@/services/backend";
import type { AgentInvitation } from "@/types";

export function AgentRegistrationPanel({ serverId }: { serverId: string }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const status = useQuery({
    queryKey: ["agent-registration", serverId],
    queryFn: () => getAgentRegistration(serverId),
    refetchInterval: (query) => pollingInterval(query, POLLING.preview),
  });
  const [invitation, setInvitation] = useState<AgentInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const url = URL.createObjectURL(await fetchAgentInstaller(serverId));
      const link = document.createElement("a");
      link.href = url;
      link.download = "nodeguard-agent-install.py";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? copy(error.message) : t("nodes.agent.installerFailed"));
    } finally {
      setDownloading(false);
    }
  }

  async function change(action: "issue" | "revoke") {
    setBusy(true);
    try {
      if (action === "issue") {
        setInvitation(await issueAgentInvitation(serverId));
      } else {
        await revokeAgentCredential(serverId);
        setInvitation(null);
        toast.success(t("nodes.agent.revoked"));
      }
      await Promise.all([status.refetch(), syncBackend()]);
    } catch (error) {
      toast.error(error instanceof Error ? copy(error.message) : t("nodes.agent.backendFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <Card id="agent-registration" className="scroll-mt-24">
    <CardHeader><CardTitle>{t("nodes.agent.title")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      {status.isLoading && <p role="status" className="text-muted-foreground">{t("nodes.agent.loading")}</p>}
      {status.isError && <p role="alert" className="text-muted-foreground">{t("nodes.agent.failed")}</p>}
      {status.data && <>
        <p>{t(`nodes.agent.state.${status.data.state}`)} · {t(`nodes.agent.source.${status.data.source}`)}</p>
        {status.data.invitationExpiresAt && <p>{t("nodes.agent.expires", { time: format.formatDateTime(status.data.invitationExpiresAt) })}</p>}
      </>}
      <p className="text-muted-foreground">{t("nodes.agent.hint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !status.data} onClick={() => void change("issue")}>{t("nodes.agent.issue")}</Button>
        <ConfirmButton label={t("nodes.agent.revoke")} title={t("nodes.agent.revokeTitle")}
          description={t("nodes.agent.revokeBody")}
          confirmLabel={t("nodes.agent.revokeConfirm")} destructive
          disabled={busy || !status.data || (status.data.state !== "active" && !status.data.invitationExpiresAt)}
          onConfirm={() => void change("revoke")} />
      </div>
      <Dialog open={Boolean(invitation)} onOpenChange={(open) => { if (!open) setInvitation(null); }}>
        <DialogContent title={t("nodes.agent.codeTitle")}>
          {invitation && <div className="space-y-3 text-sm">
            <p>{t("nodes.agent.codeUntil", { time: format.formatDateTime(invitation.expiresAt) })} <Tech>{serverId}</Tech>{t("nodes.agent.codeHostSuffix")}</p>
            <Button variant="outline" disabled={downloading} onClick={() => void download()}>
              {downloading ? t("nodes.agent.downloading") : t("nodes.agent.download")}
            </Button>
            <p>{t("nodes.agent.transfer")}</p>
            <pre className="tech overflow-auto rounded-lg bg-muted p-2 text-xs" dir="ltr">sudo python3 -I nodeguard-agent-install.py --install --interface eth0</pre>
            <p className="text-muted-foreground">{t("nodes.agent.workersLead")} <Tech>--with-iperf</Tech> {t("nodes.agent.workersOr")} <Tech>--with-provision</Tech> {t("nodes.agent.workersMid")} <Tech>--sync-iperf-receivers</Tech>{t("nodes.agent.workersEnd")}</p>
            <Input aria-label={t("nodes.agent.codeLabel")} value={invitation.code} readOnly dir="ltr" className="tech font-mono" />
            <Button variant="outline" onClick={() => {
              if (!navigator.clipboard) {
                toast.error(t("nodes.agent.copyManual"));
                return;
              }
              void navigator.clipboard.writeText(invitation.code)
                .then(() => toast.success(t("nodes.agent.copied")))
                .catch(() => toast.error(t("nodes.agent.copyManual")));
            }}>{t("nodes.agent.copy")}</Button>
          </div>}
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
