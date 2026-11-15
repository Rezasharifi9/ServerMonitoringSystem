import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const temp = await mkdtemp(join(tmpdir(), "nodeguard-dashboard-"));
const output = resolve(".nodeguard/dashboard-ui");
await mkdir(output, { recursive: true });
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const base = `http://127.0.0.1:${port}`;
const salt = randomBytes(16);
const password = "dashboard-fixture-password";
const dbPath = join(temp, "dashboard.sqlite");
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  windowsHide: true, env: { ...process.env, NODEGUARD_DB_PATH: dbPath, NODEGUARD_WORKSPACE_MODE: "monitor",
    NODEGUARD_INVENTORY_PATH: resolve("inventory.example.json"), NODEGUARD_ORIGIN: base, NODEGUARD_SECURE_COOKIE: "0",
    NODEGUARD_ADMIN_USER: "fixture-admin", NODEGUARD_ADMIN_PASSWORD_HASH: `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}` },
});
let serverOutput = "";
child.stdout.on("data", (data) => { serverOutput += data; });
child.stderr.on("data", (data) => { serverOutput += data; });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if ((await fetch(base + "/api/v1/status").catch(() => null))?.ok) break;
    if (child.exitCode !== null) throw new Error(serverOutput);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
  for (const locale of ["fa-IR", "en-US"]) {
    const common = JSON.parse(await readFile(resolve(`src/i18n/locales/${locale}/common.json`), "utf8"));
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 1050 } });
    await context.addCookies([{ name: "nodeguard-locale", value: locale, url: base }]);
    const login = await context.request.post(base + "/api/v1/session", { headers: { Origin: base }, data: { username: "fixture-admin", password } });
    assert.equal(login.status(), 200);
    const database = new DatabaseSync(dbPath);
    const row = database.prepare("SELECT snapshot,revision FROM workspace").get();
    const snapshot = JSON.parse(row.snapshot);
    snapshot.settings.telemetryIntervals = { ...snapshot.settings.telemetryIntervals, traffic: 300, tunnelProbe: 300 };
    snapshot.alerts = [{ id: "dashboard-ui-event", title: "Dashboard fixture event", detail: "Archive this event", category: "high-loss", severity: "warning", createdAt: new Date().toISOString(), resolved: false, acked: false }];
    database.prepare("UPDATE workspace SET snapshot=?,revision=?").run(JSON.stringify(snapshot), row.revision + 1);
    database.close();
    let reads = 0;
    const chartStart = Math.floor(Date.now() / 60000) * 60000 - 20 * 60000;
    const chartData = Array.from({ length: 21 }, (_, i) => ({ ts: chartStart + i * 60000, label: String(i),
      bandwidth: i === 0 ? 0 : i === 4 ? 55 : i === 15 ? 60 : null,
      loss: i === 0 ? 0 : i === 4 ? 5 : i === 15 ? 10 : null }));
    await context.route("**/api/v1/metrics/iran-bandwidth?*", (route) => route.fulfill({ json: { data: chartData } }));
    await context.route("**/api/v1/metrics?*", (route) => route.fulfill({ json: { data: chartData } }));
    let failOnline = false;
    const entries = Array.from({ length: 12 }, (_, i) => ({ key: `vmess:${i + 1}`, name: `Dashboard node ${i + 1}`, host: "node.example", port: 443, type: "vmess", fingerprint: "a".repeat(64), nodeId: i === 0 ? snapshot.nodes[0]?.id : undefined }));
    await context.route("**/api/v1/providers/v2board/catalog", (route) => route.fulfill({ json: { data: { enabled: true, syncedAt: new Date().toISOString(), nodes: entries, automatic: false } } }));
    await context.route("**/api/v1/providers/v2board/online", (route) => {
      reads++;
      return route.fulfill(failOnline ? { status: 502, json: { error: { message: "Fixture failure" } } } : { json: { data: { fetchedAt: new Date().toISOString(), nodes: entries.map((entry, i) => ({ key: entry.key, name: entry.name, online: i === 1 ? undefined : i === 0 ? 0 : i })) } } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByText("Dashboard node 1", { exact: true }).waitFor();
    const chart = page.locator(".recharts-wrapper").first();
    await chart.locator(".recharts-area-dot").nth(2).waitFor({ state: "attached" });
    await page.waitForFunction(() => {
      const path = document.querySelector(".recharts-wrapper .recharts-area-curve");
      return (path?.getAttribute("d")?.match(/M/g) ?? []).length === 2;
    });
    assert.equal(await chart.locator(".recharts-area-dot").count(), 3, "Only real samples get dots, including true zero");
    const secondDot = await chart.locator(".recharts-area-dot").nth(1).boundingBox();
    await page.mouse.move(secondDot.x + secondDot.width / 2, secondDot.y + secondDot.height / 2);
    await chart.locator(".recharts-tooltip-wrapper").getByText(`Mbps: ${new Intl.NumberFormat(locale).format(55)}`, { exact: true }).waitFor();
    if (process.argv.includes("--charts-only")) {
      assert.deepEqual(errors, []);
      await context.close();
      continue;
    }
    assert.equal(await page.locator("tbody tr").count(), 8);
    await page.getByRole("button", { name: common.next, exact: true }).click();
    await page.getByText("Dashboard node 12", { exact: true }).waitFor();
    assert.equal(await page.locator("tbody tr").count(), 4);
    await page.getByRole("button", { name: common.previous, exact: true }).click();
    const event = page.locator("button").filter({ hasText: "Dashboard fixture event" });
    await event.click();
    await event.waitFor({ state: "detached" });
    await page.reload();
    await page.getByText("Dashboard node 1", { exact: true }).waitFor();
    assert.equal(await page.getByText("Dashboard fixture event", { exact: true }).count(), 0);
    assert.ok(reads >= 2, "Each dashboard entry must fetch fresh online data");
    assert.equal(await page.locator("html").getAttribute("dir"), locale === "fa-IR" ? "rtl" : "ltr");
    await page.screenshot({ path: join(output, `${locale}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, `${locale}-mobile.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-level mobile overflow");
    await page.goto(base + "/alerts?scope=archived");
    await page.getByText("Dashboard fixture event", { exact: true }).first().waitFor();
    failOnline = true;
    await page.goto(base);
    await page.getByRole("alert").filter({ has: page.getByRole("button") }).waitFor();
    const retries = page.getByRole("button", { name: common.retry, exact: true });
    failOnline = false;
    await retries.click();
    await page.getByText("Dashboard node 1", { exact: true }).waitFor();
    await retries.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(process.argv.includes("--charts-only")
    ? "PASS: Persian/English chart gaps, real zero samples, actual-sample dots and tooltip values."
    : "PASS: Persian/English desktop/mobile layouts, 12-node pagination, fresh online reads, error/retry and durable click-to-archive with archive link.");
} finally {
  await browser?.close();
  if (child.exitCode === null) { child.kill(); await new Promise((done) => child.once("exit", done)); }
  await rm(temp, { recursive: true, force: true });
}
