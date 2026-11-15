"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Input } from "@/components/ui/kit";
import { dnsProviderNames, type DnsProvider } from "@/lib/managed-dns";
import { useI18n } from "@/i18n/provider";
import { connectDnsProvider, listDnsProviderSettings } from "@/services/backend";

export function DnsProviderSettings() {
  const { t, copy } = useI18n();
  const query = useQuery({ queryKey: ["dns-provider-settings"], queryFn: listDnsProviderSettings, retry: false });
  const client = useQueryClient();
  if (query.isPending) return <p>{t("dns.settings.loading")}</p>;
  if (query.isError) return <p role="alert" className="text-destructive">{copy(query.error.message)}</p>;
  return <div className="space-y-3 md:col-span-2">
    {!query.data.canStore && <p className="text-destructive">{t("dns.settings.encryptionRequired")}</p>}
    {query.data.providers.map(({ provider, connected }) => <ProviderForm key={provider} provider={provider} connected={connected}
      enabled={query.data.canStore} onSaved={() => { void query.refetch(); void client.invalidateQueries({ queryKey: ["managed-domains"] }); }} />)}
  </div>;
}

function ProviderForm({ provider, connected, enabled, onSaved }: {
  provider: DnsProvider; connected: boolean; enabled: boolean; onSaved: () => void;
}) {
  const { t, copy } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const providerLabel = provider === "arvan" ? t("dns.provider.arvan") : dnsProviderNames[provider];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = String(new FormData(form).get("token") ?? "");
    setPending(true);
    setError("");
    try {
      const { count } = await connectDnsProvider(provider, token);
      form.reset();
      onSaved();
      toast.success(t("dns.settings.received", { count, provider: providerLabel }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("dns.settings.connectFailed")); }
    finally { setPending(false); }
  }

  return <form onSubmit={submit} className="space-y-2 rounded-lg border border-border p-3">
    <p className="font-medium">{providerLabel} · {connected ? t("dns.settings.keySet") : t("dns.settings.keyWaiting")}</p>
    <p className="text-muted-foreground">{provider === "cloudflare" ? t("dns.settings.cloudflareHelp") : t("dns.settings.arvanHelp")}</p>
    <fieldset disabled={!enabled || pending} className="flex flex-wrap items-end gap-2">
      <label className="grow">{t("dns.settings.apiKey")}<Input dir="ltr" name="token" type="password" autoComplete="new-password" required maxLength={263} /></label>
      <Button type="submit">{pending ? t("dns.settings.testing") : t("dns.settings.testSaveSync")}</Button>
    </fieldset>
    {error && <p role="alert" className="text-destructive">{copy(error)}</p>}
  </form>;
}
