"use client";

import { POLLING, pollingInterval, jobActive } from "@/lib/polling";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/shared/chrome";
import { useFormat, useI18n } from "@/i18n/provider";
import { getTelegramConfig, listTelegramDeliveries, queueTelegramDelivery, updateTelegramConfig } from "@/services/backend";
import { Button, Input } from "@/components/ui/kit";
import { useCurrentUser } from "@/stores/infra-store";

export function TelegramDeliverySettings() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const client = useQueryClient();
  const user = useCurrentUser();
  const key = ["telegram-deliveries", user.id];
  const query = useQuery({ queryKey: key, queryFn: listTelegramDeliveries, refetchInterval: (query) => pollingInterval(query,
    query.state.data?.history.some(jobActive) ? POLLING.job : POLLING.idle) });
  const configKey = ["telegram-config", user.id];
  const config = useQuery({ queryKey: configKey, queryFn: getTelegramConfig });
  const save = useMutation({
    mutationFn: updateTelegramConfig,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: configKey });
      void client.invalidateQueries({ queryKey: key });
      toast.success(t("settings.telegram.saved"));
    },
    onError: (error) => toast.error(copy(error.message)),
  });
  const test = useMutation({
    mutationFn: queueTelegramDelivery,
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: key });
      if (result.status === "sent") toast.success(t("settings.telegram.sent"));
      else if (result.status === "failed" || result.status === "unknown") toast.error(t(`settings.telegram.errors.${result.detail ?? "telegram_rejected"}`));
    },
    onError: (error) => toast.error(copy(error.message)),
  });
  const logs = query.data?.history.filter((item) => ["sent", "failed", "unknown"].includes(item.status)) ?? [];
  return <div className="grid gap-2 rounded-lg border border-border p-3 text-sm">
    <strong>{t("settings.telegram.title")}</strong>
    {config.data && <form key={JSON.stringify(config.data)} className="grid gap-2 md:grid-cols-3" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      save.mutate({ token: String(data.get("token")).trim(), adminId: String(data.get("adminId")).trim(), botId: String(data.get("botId")).trim() });
      const token = form.elements.namedItem("token") as HTMLInputElement;
      token.value = "";
    }}>
      <label>{t("settings.telegram.token")}<Input name="token" type="password" dir="ltr" autoComplete="new-password" required placeholder={config.data.configured ? t("settings.telegram.tokenSaved") : undefined} /></label>
      <label>{t("settings.telegram.adminId")}<Input name="adminId" dir="ltr" required defaultValue={config.data.adminId} /></label>
      <label>{t("settings.telegram.botId")}<Input name="botId" dir="ltr" required defaultValue={config.data.botId} /></label>
      <Button type="submit" disabled={save.isPending}>{t("settings.telegram.save")}</Button>
    </form>}
    {config.isError && <p className="text-destructive">{copy(config.error.message)}</p>}
    {query.isPending && <p>{t("settings.telegram.loading")}</p>}
    {query.isError && <p className="text-destructive">{copy(query.error.message)}</p>}
    <p className="text-muted-foreground">{query.data?.enabled ? t("settings.telegram.enabled") : t("settings.telegram.disabled")}</p>
    <div><ConfirmButton confirmLabel={t("settings.confirmAction")} label={t("settings.telegram.test")} title={t("settings.telegram.testTitle")}
      description={t("settings.telegram.testBody")}
      disabled={!query.data?.enabled || test.isPending} onConfirm={() => test.mutate()} /></div>
    <strong className="mt-2">{t("settings.telegram.logs")}</strong>
    {query.data && !logs.length && <p>{t("settings.telegram.empty")}</p>}
    {logs.map((item) => <div key={item.id} className="flex justify-between gap-2">
      <span>{item.alertId ? t("settings.telegram.alert") : t("settings.telegram.testKind")} · <span className="tech">{format.formatDateTime(new Date(item.createdAt).toISOString())}</span></span>
      <span className={item.status === "sent" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>{deliveryStatus(t, item.status)}
        {(item.status === "failed" || item.status === "unknown") && <span className="block text-destructive">{t(`settings.telegram.errors.${item.detail ?? "telegram_rejected"}`)}</span>}
      </span>
    </div>)}
  </div>;
}

function deliveryStatus(t: (key: string) => string, status: string) {
  const key = `settings.delivery.${status}`;
  const label = t(key);
  return label === key ? status : label;
}
