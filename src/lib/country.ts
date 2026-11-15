export function countryPresentation(value: string | undefined, locale: string) {
  const code = value?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const name = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(code);
  if (!name || name === code || code === "ZZ") return null;
  return { code, name, flag: String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65)) };
}
