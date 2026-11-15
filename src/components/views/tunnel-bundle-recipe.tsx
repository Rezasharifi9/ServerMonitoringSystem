"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { downloadText } from "@/lib/utils";
import { getTunnelBundleRecipe } from "@/services/backend";

export function TunnelBundleRecipeCard({ tunnelId, forwarder }: { tunnelId: string; forwarder: boolean }) {
  const { t, copy } = useI18n();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const recipe = await getTunnelBundleRecipe(tunnelId);
      downloadText("nodeguard-tunnel-recipe.json", JSON.stringify(recipe, null, 2) + "\n", "application/json");
      toast.success(t("tunnels.recipe.downloaded"));
    } catch (error) {
      toast.error(error instanceof Error ? copy(error.message) : t("tunnels.recipe.failed"));
    } finally {
      setBusy(false);
    }
  }

  return <Card>
    <CardHeader><CardTitle>{t("tunnels.recipe.title")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>{forwarder ? t("tunnels.recipe.forwarder") : t("tunnels.recipe.interface")}</p>
      <pre className="tech overflow-auto rounded-lg bg-muted p-3 text-xs">{forwarder
        ? "python3 agent/build_service_bundle.py forwarder nodeguard-tunnel-recipe.json approved-inputs.json tunnel-bundles"
        : "python3 agent/build_tunnel_bundle.py nodeguard-tunnel-recipe.json tunnel-bundles"}</pre>
      <Button variant="outline" onClick={() => void download()} disabled={busy}>{busy ? t("tunnels.recipe.downloading") : t("tunnels.recipe.download")}</Button>
    </CardContent>
  </Card>;
}
