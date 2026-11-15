"use client";

import { POLLING } from "@/lib/polling";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Input } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { getGmailSettings, saveGmailSettings } from "@/services/backend";

export function GmailSettings() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["gmail-settings"], queryFn: getGmailSettings, staleTime: POLLING.configuration });
  const save = useMutation({ mutationFn: saveGmailSettings, onSuccess: (data) => {
    client.setQueryData(["gmail-settings"], data);
    toast.success(t("settings.gmail.saved"));
  }, onError: (error) => toast.error(copy(error.message)) });
  if (query.isPending) return <p>{t("settings.gmail.loading")}</p>;
  if (query.isError) return <p className="text-destructive">{copy(query.error.message)}</p>;
  return <section className="space-y-2 border-t pt-4">
    <h3 className="font-medium">{t("settings.gmail.title")}</h3>
    <form key={`${query.data.sender}/${query.data.recipient}`} className="grid gap-2 md:grid-cols-3" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      save.mutate({ sender: String(data.get("sender")), recipient: String(data.get("recipient")), appPassword: String(data.get("appPassword")) }, {
        onSuccess: () => { (form.elements.namedItem("appPassword") as HTMLInputElement).value = ""; },
      });
    }}>
      <label>{t("settings.gmail.sender")}<Input dir="ltr" name="sender" type="email" required defaultValue={query.data.sender} /></label>
      <label>{t("settings.gmail.recipient")}<Input dir="ltr" name="recipient" type="email" required defaultValue={query.data.recipient} /></label>
      <label>{t("settings.gmail.appPassword")}<Input dir="ltr" name="appPassword" type="password" autoComplete="new-password" maxLength={32} required /></label>
      <Button type="submit" disabled={save.isPending}>{t("settings.gmail.save")}</Button>
    </form>
    {query.data.history.map((row, index) => <p className="text-xs text-muted-foreground" key={`${row.createdAt}-${index}`}>
      <span className="tech">{format.formatDateTime(new Date(row.createdAt).toISOString())}</span> · {deliveryStatus(t, row.status)}</p>)}
  </section>;
}

function deliveryStatus(t: (key: string) => string, status: string) {
  const key = `settings.delivery.${status}`;
  const label = t(key);
  return label === key ? status : label;
}
