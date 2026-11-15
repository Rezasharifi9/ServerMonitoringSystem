"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fingerprint } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { adminPasskeysQueryKey, listAdminPasskeys, registerAdminPasskey, removeAdminPasskey } from "@/services/backend";

export function AdminPasskeySettings() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const queryClient = useQueryClient();
  const passkeys = useQuery({ queryKey: adminPasskeysQueryKey, queryFn: listAdminPasskeys });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function update(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: adminPasskeysQueryKey });
      toast.success(message);
    } catch (cause) {
      setError(cause instanceof Error ? copy(cause.message) : t("settings.passkey.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>{t("settings.passkey.title")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("settings.passkey.body")}</p>
        <form className="max-w-md space-y-3" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void update(async () => {
            await registerAdminPasskey(String(data.get("name")), String(data.get("password")));
            form.reset();
          }, t("settings.passkey.registered"));
        }}>
          <fieldset className="grid gap-3" disabled={busy || passkeys.isPending}>
            <div className="grid gap-1">
              <Label htmlFor="passkey-name">{t("settings.passkey.name")}</Label>
              <Input id="passkey-name" name="name" placeholder={t("settings.passkey.placeholder")} maxLength={64} required />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="passkey-password">{t("settings.passkey.password")}</Label>
              <Input id="passkey-password" name="password" type="password" autoComplete="current-password" maxLength={256} dir="ltr" required />
            </div>
            <Button type="submit" className="justify-self-start"><Fingerprint aria-hidden /> {t("settings.passkey.register")}</Button>
          </fieldset>
        </form>
        {error && <p role="alert" className="text-sm text-destructive">{copy(error)}</p>}
        {passkeys.isError && <p role="alert" className="text-sm text-destructive">{copy(passkeys.error.message)}</p>}
        {passkeys.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("settings.passkey.empty")}</p>}
        {!!passkeys.data?.length && <ul className="divide-y rounded-md border">
          {passkeys.data.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="break-words text-sm font-medium">{key.name}</div>
                <div className="tech text-xs text-muted-foreground">{format.formatDateTime(key.createdAt)}</div>
              </div>
              <Button variant="outline" size="sm" disabled={busy} aria-label={t("settings.passkey.removeNamed", { name: key.name })}
                onClick={() => void update(() => removeAdminPasskey(key.id), t("settings.passkey.removed"))}>{t("settings.passkey.remove")}</Button>
            </li>
          ))}
        </ul>}
      </CardContent>
    </Card>
  );
}
