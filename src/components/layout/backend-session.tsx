"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button, Input, Label, Select } from "@/components/ui/kit";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { connectBackend } from "@/services/backend";
import { useI18n } from "@/i18n/provider";
import type { DemoUser } from "@/types";

export function BackendSession({ open, onOpenChange, users }: { open: boolean; onOpenChange: (open: boolean) => void; users: DemoUser[] }) {
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const { t, copy } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("common.auth.backendTitle")}>
        <p className="text-sm text-muted-foreground">{t("common.auth.backendBody")}</p>
        <form className="mt-3 grid gap-3" onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          try {
            await connectBackend(userId, token);
            setToken("");
            onOpenChange(false);
            toast.success(t("common.auth.connected"));
          } catch (error) {
            toast.error(error instanceof Error ? copy(error.message) : t("common.auth.connectFailed"));
          } finally {
            setPending(false);
          }
        }}>
          <Label htmlFor="backend-user">{t("common.auth.user")}</Label>
          <Select id="backend-user" value={userId} onChange={(event) => setUserId(event.target.value)}>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </Select>
          <Label htmlFor="backend-token">{t("common.auth.token")}</Label>
          <Input id="backend-token" type="password" className="tech" required minLength={32} maxLength={256} value={token} onChange={(event) => setToken(event.target.value)} />
          <Button type="submit" disabled={pending}>{pending ? t("common.auth.connecting") : t("common.auth.signIn")}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
