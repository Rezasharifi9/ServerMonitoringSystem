import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const temp = await mkdtemp(join(tmpdir(), "nodeguard-polling-"));
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("hex");
const salt = randomBytes(16);
const app = spawn(process.execPath, ["server.js"], {
  cwd: resolve(process.argv[3]), windowsHide: true,
  env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port), NODEGUARD_DB_PATH: join(temp, "fixture.sqlite"),
    NODEGUARD_WORKSPACE_MODE: "monitor", NODEGUARD_INVENTORY_PATH: resolve("inventory.example.json"),
    NODEGUARD_ORIGIN: base, NODEGUARD_SECURE_COOKIE: "0", NODEGUARD_ADMIN_USER: "polling-fixture",
    NODEGUARD_ADMIN_PASSWORD_HASH: `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}` },
});
let output = "";
app.stdout.on("data", (data) => { output += data; });
app.stderr.on("data", (data) => { output += data; });
let browser;
try {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(base + "/api/v1/status").catch(() => null))?.ok) break;
    if (app.exitCode !== null) throw Error(output);
    await delay(200);
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext();
  const login = await context.request.post(base + "/api/v1/session", { headers: { Origin: base }, data: { username: "polling-fixture", password } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  await page.clock.install();
  const requests = [];
  let pingReads = 0;
  let fail = false;
  await page.route("**/api/v1/workspace", async (route) => {
    requests.push(page.clock ? await page.evaluate(() => Date.now()) : Date.now());
    if (fail) await route.fulfill({ status: 503, json: { error: { message: "Fixture unavailable" } } });
    else await route.continue();
  });
  await page.route("**/api/v1/servers/*/ping", (route) => {
    pingReads++;
    return route.fulfill({ json: { data: { status: "reachable", checkedAt: new Date().toISOString(), rttMs: 10 } } });
  });
  await page.goto(base + "/servers");
  await page.locator("#main-content").waitFor();
  await delay(300);
  const initialPings = pingReads;
  assert.ok(initialPings > 0, "the fixture must render monitored server ping badges");
  assert.equal(requests.length, 1);
  await page.clock.fastForward(14000);
  assert.equal(requests.length, 1, "workspace must not poll before 15 seconds");
  await page.clock.fastForward(1500);
  await delay(300);
  assert.equal(requests.length, 2);
  assert.equal(pingReads, initialPings, "workspace updates must not trigger early ping requests");
  fail = true;
  await page.clock.fastForward(15500);
  await delay(300);
  assert.equal(requests.length, 3);
  assert.equal(pingReads, initialPings * 2, "each visible server must ping once per 30-second cycle");
  await page.clock.fastForward(29000);
  assert.equal(requests.length, 3, "failure must back off to 30 seconds");
  await page.clock.fastForward(2000);
  await delay(300);
  assert.equal(requests.length, 4);
  await page.clock.fastForward(59000);
  assert.equal(requests.length, 4, "repeated failure must back off to 60 seconds");
  fail = false;
  await page.clock.fastForward(2000);
  await delay(300);
  assert.equal(requests.length, 5);
  await page.clock.fastForward(15500);
  await delay(300);
  assert.equal(requests.length, 6, "success must restore the normal cadence");
  await context.setOffline(true);
  await page.clock.fastForward(45000);
  assert.equal(requests.length, 6, "offline pages must stop workspace polling");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await context.setOffline(false);
  await page.clock.fastForward(45000);
  assert.equal(requests.length, 6, "hidden pages must stop workspace polling");
  console.log("Browser polling: 15-second cadence, 30/60-second error backoff, recovery, offline and hidden-page suppression passed.");
} finally {
  await browser?.close();
  app.kill();
  if (app.exitCode === null) await new Promise((done) => app.once("exit", done));
  await rm(temp, { recursive: true, force: true });
}

