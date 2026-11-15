"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Tech } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Textarea } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { importProvisionCatalog, previewProvisionCatalog } from "@/services/backend";
import type { ProvisionCatalogPreview } from "@/types";

const maxBytes = 64000;

export function ProvisionCatalogRegistration() {
  const { t, copy } = useI18n();
  const client = useQueryClient();
  const [source, setSource] = useState("");
  const [review, setReview] = useState<{ enrollment: unknown; preview: ProvisionCatalogPreview }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function edit(value: string) {
    setSource(value);
    setReview(undefined);
    setError("");
  }

  async function prepare() {
    setBusy(true);
    setError("");
    setReview(undefined);
    try {
      let enrollment: unknown;
      try {
        enrollment = JSON.parse(source);
      } catch {
        throw new Error(t("deployments.catalog.invalidJson"));
      }
      const preview = await previewProvisionCatalog(enrollment);
      setReview({ enrollment, preview });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("deployments.catalog.readFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!review) return;
    setBusy(true);
    setError("");
    try {
      const result = await importProvisionCatalog(review.enrollment, review.preview.fingerprint);
      edit("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["provision-jobs"] }),
        client.invalidateQueries({ queryKey: ["tunnel-deployments"] }),
      ]);
      toast.success(result.replay ? t("deployments.catalog.already") : t("deployments.catalog.saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("deployments.catalog.importFailed"));
      setReview(undefined);
    } finally {
      setBusy(false);
    }
  }

  return <Card>
    <CardHeader><CardTitle>{t("deployments.catalog.title")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>{t("deployments.catalog.body").split("enrollment.json")[0]}<Tech>enrollment.json</Tech>{t("deployments.catalog.body").split("enrollment.json")[1]}</p>
      <Input type="file" accept=".json,application/json" aria-label={t("deployments.catalog.file")} disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setReview(undefined);
          if (file.size > maxBytes) {
            setError(t("deployments.catalog.tooLarge"));
            return;
          }
          setBusy(true);
          void file.text().then(edit).catch(() => setError(t("deployments.catalog.fileReadFailed"))).finally(() => setBusy(false));
        }} />
      <Textarea aria-label={t("deployments.catalog.text")} dir="ltr" className="font-mono" value={source} maxLength={maxBytes}
        disabled={busy} onChange={(event) => edit(event.target.value)} placeholder="enrollment.json" />
      <Button variant="outline" disabled={busy || !source.trim()} onClick={() => void prepare()}>{t("deployments.catalog.preview")}</Button>
      {error && <p role="alert" className="text-destructive">{copy(error)}</p>}
      {review && <div className="space-y-3 rounded-lg border border-border p-3">
        <p>{t("deployments.catalog.summary", { added: review.preview.addedProfiles, updated: review.preview.updatedTunnels })}</p>
        <ul className="space-y-2">
          {review.preview.profiles.map((item) => <li key={item.serverId + "/" + item.id} className="rounded-lg bg-muted p-2">
            <p>{item.component} · <Tech>{item.serverId} / {item.id} / {item.version}</Tech></p>
            <p className="break-all">SHA-256 <Tech>{item.sha256}</Tech></p>
          </li>)}
        </ul>
        {review.preview.tunnels.map((link) => <div key={link.tunnelId}>
          <p>{t("deployments.catalog.tunnel")} <Tech>{link.tunnelId}</Tech> · {t("deployments.catalog.iran")} <Tech>{link.iranProfileId}</Tech> · {t("deployments.catalog.foreign")} <Tech>{link.foreignProfileId}</Tech></p>
          {link.previous && (link.previous.iranProfileId !== link.iranProfileId || link.previous.foreignProfileId !== link.foreignProfileId) &&
            <p className="text-muted-foreground">{t("deployments.catalog.currentMapping")} <Tech>{link.previous.iranProfileId} / {link.previous.foreignProfileId}</Tech></p>}
        </div>)}
        <Button disabled={busy} onClick={() => void commit()}>{t("deployments.catalog.commit")}</Button>
      </div>}
    </CardContent>
  </Card>;
}
