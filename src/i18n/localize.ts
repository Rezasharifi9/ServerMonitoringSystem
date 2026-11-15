import type { Locale } from "./config";
import health from "./phrases/health.en.json";
import nodes from "./phrases/nodes.en.json";
import servers from "./phrases/servers.en.json";
import operations from "./phrases/operations.en.json";
import platform from "./phrases/platform.en.json";

const phrases: Record<string, string> = { ...health, ...nodes, ...servers, ...operations, ...platform };

const patterns: Array<{ test: RegExp; format: (match: RegExpMatchArray) => string }> = [
  { test: /^تنظیمات سامانه ذخیره شد \(([^)]+)\)\.$/, format: (match) => `System settings were saved (${match[1]}).` },
  { test: /^مصرف منابع به (\d+)٪ رسیده و نیاز به توجه دارد\.$/, format: (match) => `Resource usage reached ${match[1]}% and needs attention.` },
  { test: /^کاوش HTTPS از مسیر هدایت پورت در (\d+) میلی‌ثانیه پاسخ داد\.$/, format: (match) => `The HTTPS probe through the port forwarder responded in ${match[1]} ms.` },
  { test: /^RTT (\d+)ms و اتلاف ([\d.]+)٪ از آستانه فراتر است\.$/, format: (match) => `RTT ${match[1]} ms and packet loss ${match[2]}% exceed the threshold.` },
  { test: /^RTT (\d+)ms و اتلاف ([\d.]+)٪ در محدوده قبول است\.$/, format: (match) => `RTT ${match[1]} ms and packet loss ${match[2]}% are within the accepted range.` },
];

/** Translates stored Persian diagnostics when the UI language is English. Technical values stay ASCII. */
export function localizeText(text: string, locale: Locale): string {
  if (!text || locale !== "en-US") return text;
  const exact = phrases[text];
  if (exact) return exact;
  for (const pattern of patterns) {
    const match = text.match(pattern.test);
    if (match) return pattern.format(match);
  }
  return text;
}
