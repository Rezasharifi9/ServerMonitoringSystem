"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, Select } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { saveGreTransport, syncBackend } from "@/services/backend";

export function GreTransportSettings({ tunnelId, transport, disabled, onSaving }: {
  tunnelId: string; transport: "native" | "udp"; disabled: boolean; onSaving: (saving: boolean) => void;
}) {
  const { t, copy } = useI18n();
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  return <Card><CardHeader><CardTitle>{t("tunnels.greTransport.title")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>{t("tunnels.greTransport.description")}</p>
      <label className="grid max-w-sm gap-2">
        {t("tunnels.greTransport.label")}
        <Select value={transport} disabled={disabled || saving} onChange={async (event) => {
          const next = event.target.value as "native" | "udp";
          setSaving(true);
          onSaving(true);
          try {
            await saveGreTransport(tunnelId, next);
            await syncBackend();
            await client.invalidateQueries({ queryKey: ["tunnel-deployments"] });
            toast.success(t("tunnels.greTransport.saved"));
          } catch (error) { toast.error(copy(error instanceof Error ? error.message : t("tunnels.greTransport.failed"))); }
          finally { setSaving(false); onSaving(false); }
        }}>
          <option value="native">{t("tunnels.greTransport.native")}</option>
          <option value="udp">{t("tunnels.greTransport.udp")}</option>
        </Select>
      </label>
      <p className="text-muted-foreground" role="status">{saving ? t("tunnels.greTransport.saving") : t("tunnels.greTransport.hint")}</p>
    </CardContent>
  </Card>;
}
