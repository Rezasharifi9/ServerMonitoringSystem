"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { enUS, faIR, type Catalog } from "./catalog";
import { DEFAULT_LOCALE, directionFor, isLocale, LOCALE_COOKIE, LOCALE_STORAGE, type Locale } from "./config";
import { localizeText } from "./localize";
import { bindI18n } from "./runtime";
import { translate, type Vars } from "./translate";
import {
  chartLabel as formatChartLabel,
  formatDate as formatDateValue,
  formatDateTime as formatDateTimeValue,
  formatGiB as formatGiBValue,
  formatMbps as formatMbpsValue,
  formatMs as formatMsValue,
  formatNumber as formatNumberValue,
  formatPercent as formatPercentValue,
  formatUptime as formatUptimeValue,
  timeAgo as formatTimeAgo,
} from "@/lib/format";

const catalogs: Record<Locale, Catalog> = { "en-US": enUS, "fa-IR": faIR };

type I18nContextValue = {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Vars) => string;
  copy: (text: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function persist(locale: Locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = directionFor(locale);
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; SameSite=Lax; Max-Age=31536000`;
  localStorage.setItem(LOCALE_STORAGE, locale);
}

export function I18nProvider({ initialLocale, children }: { initialLocale?: string; children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(isLocale(initialLocale) ? initialLocale : DEFAULT_LOCALE);
  const dir = directionFor(locale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persist(next);
  }, []);
  const value = useMemo<I18nContextValue>(() => {
    const api = {
      locale,
      dir,
      setLocale,
      t: (key: string, vars?: Vars) => translate(catalogs[locale], key, vars, enUS),
      copy: (text: string) => localizeText(text, locale),
    };
    bindI18n(api);
    return api;
  }, [dir, locale, setLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [dir, locale]);

  useEffect(() => {
    const hasCookie = new RegExp(`(?:^|; )${LOCALE_COOKIE}=`).test(document.cookie);
    const stored = localStorage.getItem(LOCALE_STORAGE);
    if (!hasCookie && isLocale(stored) && stored !== locale) setLocale(stored);
    else localStorage.setItem(LOCALE_STORAGE, locale);
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}

export function useFormat() {
  const { locale, t } = useI18n();
  return useMemo(() => ({
    formatDateTime: (input?: string | number | Date) => formatDateTimeValue(input, locale),
    formatDate: (input?: string | number | Date) => formatDateValue(input, locale),
    formatNumber: (value: number, digits = 0) => formatNumberValue(value, digits),
    formatPercent: (value: number, digits = 1) => formatPercentValue(value, digits, locale),
    formatMs: (value: number) => formatMsValue(value),
    formatMbps: (value: number) => formatMbpsValue(value),
    formatGiB: (bytes?: number) => formatGiBValue(bytes),
    timeAgo: (input?: string | number | Date) => formatTimeAgo(input, t),
    formatUptime: (seconds: number) => formatUptimeValue(seconds, t),
    chartLabel: (ts: number, spanMs: number) => formatChartLabel(ts, spanMs, locale),
  }), [locale, t]);
}
