"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Input } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { connectV2BoardAdmin } from "@/services/backend";

export function V2BoardAdminForm({ enabled }: { enabled: boolean }) {
  const { t, copy } = useI18n();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = form.elements.namedItem("password") as HTMLInputElement;
    password.value = "";
    setPending(true);
    try {
      const { count } = await connectV2BoardAdmin({
        address: String(fields.get("address") ?? ""), email: String(fields.get("email") ?? ""),
        password: String(fields.get("password") ?? ""),
      });
      toast.success(t("nodes.admin.imported", { count }));
    } catch (error) {
      toast.error(error instanceof Error ? copy(error.message) : t("nodes.admin.failed"));
    } finally {
      setPending(false);
    }
  }

  return <form method="post" onSubmit={submit} className="space-y-2 rounded-lg border border-border p-3 md:col-span-2">
    <h3 className="font-medium">{t("nodes.admin.title")}</h3>
    <p className="text-muted-foreground">{t("nodes.admin.body")}</p>
    {!enabled && <p className="text-destructive">{t("nodes.admin.encryption")}</p>}
    <fieldset className="grid gap-2 md:grid-cols-3" disabled={!enabled || pending}>
      <label>{t("nodes.admin.address")}<Input name="address" type="url" dir="ltr" placeholder="https://panel.example/admin-path" required /></label>
      <label>{t("nodes.admin.email")}<Input name="email" type="email" dir="ltr" autoComplete="username" required /></label>
      <label>{t("nodes.admin.password")}<Input name="password" type="password" dir="ltr" autoComplete="current-password" required /></label>
      <Button className="md:justify-self-start" type="submit">{pending ? t("nodes.admin.connecting") : t("nodes.admin.connect")}</Button>
    </fieldset>
  </form>;
}
