"use client";

import { useI18n } from "@/i18n/provider";
import type { Locale } from "@/i18n/config";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="sr-only">{t("common.language")}</span>
      <select
        aria-label={t("common.language")}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className="h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="en-US">{t("common.english")}</option>
        <option value="fa-IR">{t("common.persian")}</option>
      </select>
    </label>
  );
}
