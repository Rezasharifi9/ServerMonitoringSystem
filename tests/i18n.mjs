import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/i18n/locales");
const { translate } = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/i18n/translate.ts")).href);

function keysOf(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [next] : keysOf(child, next);
  });
}

const namespaces = (await readdir(path.join(root, "en-US"))).filter((name) => name.endsWith(".json")).sort();
const persian = (await readdir(path.join(root, "fa-IR"))).filter((name) => name.endsWith(".json")).sort();
assert.deepEqual(persian, namespaces, "Persian catalogs must match the English file set");

for (const name of namespaces) {
  const en = JSON.parse(await readFile(path.join(root, "en-US", name), "utf8"));
  const fa = JSON.parse(await readFile(path.join(root, "fa-IR", name), "utf8"));
  const enKeys = keysOf(en).sort();
  const faKeys = keysOf(fa).sort();
  assert.deepEqual(faKeys, enKeys, `${name} keys differ`);
  for (const [locale, tree] of [["en-US", en], ["fa-IR", fa]]) {
    for (const key of keysOf(tree)) {
      const parts = key.split(".");
      let node = tree;
      for (const part of parts) node = node[part];
      assert.equal(typeof node, "string", `${locale}/${name}:${key}`);
      assert.notEqual(node.trim(), "", `${locale}/${name}:${key} is empty`);
    }
  }
}

assert.equal(translate({ item: "{count, plural, one {# item} other {# items}}" }, "item", { count: 1 }), "1 item");
assert.equal(translate({ item: "{count, plural, one {# item} other {# items}}" }, "item", { count: 4 }), "4 items");
assert.equal(translate({ greet: "Hello, {name}" }, "greet", { name: "Het" }), "Hello, Het");
assert.equal(translate({}, "missing.key"), "missing.key");

const faCommon = JSON.parse(await readFile(path.join(root, "fa-IR", "common.json"), "utf8"));
assert.equal(faCommon.auth.signIn, "ورود");
assert.equal(faCommon.backendSignIn, "ورود به بک‌اند");
assert.equal(faCommon.backendMonitor, "بک‌اند · پایش");
assert.equal(faCommon.backendDemo, "بک‌اند · عملیات نمایشی");
assert.equal(faCommon.cancel, "انصراف");
const faDashboard = JSON.parse(await readFile(path.join(root, "fa-IR", "dashboard.json"), "utf8"));
assert.equal(faDashboard.observedAvailability, "دسترس‌پذیری مشاهده‌شده");
assert.match(faDashboard.probesSummary, /از \{samples\} کاوش موفق/);
const faMonitoring = JSON.parse(await readFile(path.join(root, "fa-IR", "monitoring.json"), "utf8"));
assert.equal(faMonitoring.activeProbes24h, "کاوش‌های مسیر فعال در ۲۴ ساعت اخیر");

console.log(`PASS: ${namespaces.length} catalogs have matching keys and interpolation works.`);
