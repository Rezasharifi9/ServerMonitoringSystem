export type MessageTree = { [key: string]: string | MessageTree };

export type Vars = Record<string, string | number | boolean | null | undefined>;

const missing = new Set<string>();

const pluralPattern = /\{(\w+),\s*plural,\s*((?:one|other)\s*\{[^{}]*\}(?:\s+(?:one|other)\s*\{[^{}]*\})*)\}/g;

export function lookup(tree: MessageTree | undefined, key: string): string | undefined {
  if (!tree) return undefined;
  let node: string | MessageTree | undefined = tree;
  for (const part of key.split(".")) {
    if (!node || typeof node === "string" || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(template: string, vars: Vars = {}): string {
  const pluralized = template.replace(pluralPattern, (_, name: string, body: string) => {
    const count = Number(vars[name] ?? 0);
    const forms = [...body.matchAll(/(one|other)\s*\{([^{}]*)\}/g)];
    const selected = (count === 1 ? forms.find((form) => form[1] === "one") : undefined) ?? forms.find((form) => form[1] === "other");
    return (selected?.[2] ?? "").replaceAll("#", String(count));
  });
  return pluralized.replace(/\{(\w+)\}/g, (token, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? token : String(value);
  });
}

export function translate(messages: MessageTree, key: string, vars?: Vars, fallback?: MessageTree): string {
  const value = lookup(messages, key) ?? lookup(fallback, key);
  if (value === undefined) {
    if (process.env.NODE_ENV !== "production" && !missing.has(key)) {
      missing.add(key);
      console.warn(`[i18n] Missing translation: ${key}`);
    }
    return key;
  }
  return interpolate(value, vars);
}

export function resetMissingTranslations() {
  missing.clear();
}
