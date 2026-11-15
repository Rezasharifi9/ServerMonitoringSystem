export const LOCALES = ["en-US", "fa-IR"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en-US";

export const LOCALE_COOKIE = "nodeguard-locale";

export const LOCALE_STORAGE = "nodeguard-locale";

export function isLocale(value: unknown): value is Locale {
  return value === "en-US" || value === "fa-IR";
}

export function directionFor(locale: Locale): "ltr" | "rtl" {
  return locale === "fa-IR" ? "rtl" : "ltr";
}
