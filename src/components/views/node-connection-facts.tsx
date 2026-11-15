"use client";

import { Tech } from "@/components/shared/chrome";
import { useI18n } from "@/i18n/provider";
import type { V2BoardCatalogEntry } from "@/types";

type Facts = {
  name: string;
  domain: string;
  port?: number | string;
  protocol?: string;
  tls?: V2BoardCatalogEntry["tls"];
  transport?: string;
};

export function NodeConnectionFacts({ name, domain, port, protocol, tls, transport }: Facts) {
  const { t } = useI18n();
  const missing = t("nodes.unknown");
  const facts = [
    [t("nodes.facts.name"), name],
    [t("nodes.facts.domain"), <Tech key="domain">{domain || missing}</Tech>],
    [t("nodes.facts.tls"), tls === "none" ? t("nodes.facts.noTls") : tls ? <Tech key="tls">{tls}</Tech> : undefined],
    [t("nodes.facts.port"), port === undefined ? undefined : <Tech key="port">{port}</Tech>],
    [t("nodes.facts.transport"), transport ? <Tech key="transport">{transport}</Tech> : undefined],
    [t("nodes.facts.protocol"), protocol ? <Tech key="protocol">{protocol}</Tech> : undefined],
  ] as const;
  return <dl className="grid gap-3 sm:grid-cols-2">
    {facts.map(([label, value]) => <div key={label} className="rounded-lg border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm font-medium">{value || missing}</dd>
    </div>)}
  </dl>;
}
