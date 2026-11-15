import type { Locale } from "@/i18n/config";
import { t as runtimeT } from "@/i18n/runtime";
import type { Vars } from "@/i18n/translate";

type Translator = (key: string, vars?: Vars) => string;

const dateTimeCache = new Map<string, Intl.DateTimeFormat>();
const dateOnlyCache = new Map<string, Intl.DateTimeFormat>();

function dateOptions(locale: Locale, withTime: boolean): Intl.DateTimeFormatOptions {
  return {
    timeZone: "Asia/Tehran",
    calendar: locale === "fa-IR" ? "persian" : "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "short",
    day: "numeric",
    hourCycle: "h23",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  };
}

function formatter(cache: Map<string, Intl.DateTimeFormat>, locale: Locale, withTime: boolean) {
  const key = `${locale}:${withTime}`;
  let format = cache.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, dateOptions(locale, withTime));
    cache.set(key, format);
  }
  return format;
}

export function formatDateTime(input?: string | number | Date, locale: Locale = "en-US") {
  if (!input) return "—";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  return formatter(dateTimeCache, locale, true).format(date);
}

export function formatDate(input?: string | number | Date, locale: Locale = "en-US") {
  if (!input) return "—";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  return formatter(dateOnlyCache, locale, false).format(date);
}

export function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    numberingSystem: "latn",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(value: number, digits = 1, locale: Locale = "en-US") {
  const suffix = locale === "fa-IR" ? "٪" : "%";
  return `${formatNumber(value, digits)}${suffix}`;
}

export function formatMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${formatNumber(value, value < 10 ? 1 : 0)} ms`;
}

export function formatMbps(value: number) {
  return `${formatNumber(value, value >= 100 ? 0 : 1)} Mbps`;
}

export function formatGiB(bytes?: number) {
  return bytes === undefined ? "—" : `${formatNumber(bytes / 1024 ** 3, 1)} GiB`;
}

export function timeAgo(input?: string | number | Date, translate: Translator = runtimeT) {
  if (!input) return "—";
  const date = new Date(input);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return "—";
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) return translate("common.justNow");
  if (Math.abs(minutes) < 60) {
    return translate(minutes >= 0 ? "common.minutesAgo" : "common.minutesAhead", { count: Math.abs(minutes) });
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    return translate(hours >= 0 ? "common.hoursAgo" : "common.hoursAhead", { count: Math.abs(hours) });
  }
  const days = Math.round(hours / 24);
  return translate(days >= 0 ? "common.daysAgo" : "common.daysAhead", { count: Math.abs(days) });
}

export function formatUptime(seconds: number, translate: Translator = runtimeT) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return translate("common.uptimeDays", { days, hours });
  const minutes = Math.floor((seconds % 3600) / 60);
  return translate("common.uptimeHours", { hours, minutes });
}

export function chartLabel(ts: number, spanMs: number, locale: Locale = "en-US") {
  const date = new Date(ts);
  const options: Intl.DateTimeFormatOptions = spanMs <= 48 * 3600 * 1000
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", numberingSystem: "latn", timeZone: "Asia/Tehran" }
    : { month: "2-digit", day: "2-digit", numberingSystem: "latn", timeZone: "Asia/Tehran", calendar: locale === "fa-IR" ? "persian" : "gregory" };
  return date.toLocaleString(locale, options);
}
