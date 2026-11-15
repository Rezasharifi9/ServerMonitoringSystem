import { enUS, faIR, type Catalog } from "./catalog";
import { DEFAULT_LOCALE, directionFor, type Locale } from "./config";
import { translate, type Vars } from "./translate";

export type I18nApi = {
  locale: Locale;
  dir: "ltr" | "rtl";
  t: (key: string, vars?: Vars) => string;
};

const catalogs: Record<Locale, Catalog> = { "en-US": enUS, "fa-IR": faIR };

function apiFor(locale: Locale): I18nApi {
  return {
    locale,
    dir: directionFor(locale),
    t: (key, vars) => translate(catalogs[locale], key, vars, enUS),
  };
}

let current = apiFor(DEFAULT_LOCALE);

export function bindI18n(api: I18nApi) {
  current = api;
}

export function getI18n() {
  return current;
}

/** Locale-aware translator for non-React modules. The provider binds the active locale on each render. */
export function t(key: string, vars?: Vars) {
  return current.t(key, vars);
}
