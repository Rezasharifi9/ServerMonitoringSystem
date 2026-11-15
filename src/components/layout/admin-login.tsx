"use client";

import { useContext, useState, type FormEvent } from "react";
import { Fingerprint, ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, Input, Label } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { signInAdmin, signInWithPasskey } from "@/services/backend";
import { AdminMode } from "./session-mode";

export function AdminLogin() {
  const adminMode = useContext(AdminMode);
  const { t, copy } = useI18n();
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await signIn("password", () => signInAdmin(String(data.get("username")), String(data.get("password"))));
  }

  async function signIn(method: NonNullable<typeof pending>, authenticate: () => Promise<void>) {
    if (pending) return;
    setError("");
    setPending(method);
    try {
      await authenticate();
      window.location.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? copy(cause.message) : t("common.auth.failed"));
      setPending(null);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-6 p-6 md:p-8">
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="size-6" aria-hidden />
            </div>
            <div>
              <h1 className="text-xl font-semibold">{t("common.auth.title")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("common.auth.subtitle")}</p>
            </div>
          </div>
          <form className="grid gap-4" method="post" onSubmit={submit}>
            <div className="grid gap-2">
              <Label htmlFor="username">{t("common.auth.username")}</Label>
              <Input id="username" name="username" dir="ltr" autoComplete="username" maxLength={64} autoCapitalize="none" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">{t("common.auth.password")}</Label>
              <Input id="password" name="password" dir="ltr" type="password" autoComplete="current-password" maxLength={256} required />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={pending !== null} className="w-full">{pending === "password" ? t("common.auth.signingIn") : t("common.auth.signIn")}</Button>
            {adminMode && <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void signIn("passkey", signInWithPasskey)}>
              <Fingerprint aria-hidden />
              {pending === "passkey" ? t("common.auth.passkeyWaiting") : t("common.auth.passkey")}
            </Button>}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
