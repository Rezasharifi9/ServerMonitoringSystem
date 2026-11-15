"use client";

import Link from "next/link";
import { useI18n } from "@/i18n/provider";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-lg py-20 text-center">
      <h1 className="text-2xl font-semibold">{t("common.notFoundTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("common.notFoundBody")}</p>
      <Link href="/" className="mt-4 inline-block text-primary">{t("common.backToDashboard")}</Link>
    </div>
  );
}
