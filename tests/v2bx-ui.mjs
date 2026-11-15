import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const { port } = listener.address();
await new Promise((done) => listener.close(done));
const base = `http://127.0.0.1:${port}`;
const temp = await mkdtemp(resolve(".nodeguard/v2bx-ui-"));
const token = randomBytes(32).toString("hex");
const child = spawn(process.execPath, ["--import", "./tests/v2board-fixture.mjs", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  windowsHide: true,
  env: { ...process.env, NODEGUARD_DB_PATH: join(temp, "test.sqlite"), NODEGUARD_WORKSPACE_MODE: "monitor",
    NODEGUARD_INVENTORY_PATH: "inventory.example.json", NODEGUARD_USER_TOKENS: JSON.stringify({ "usr-reza": token }),
    NODEGUARD_CREDENTIAL_KEY: randomBytes(32).toString("hex"), NODEGUARD_SECURE_COOKIE: "0",
    NODEGUARD_V2BOARD_ENDPOINT: "https://panel.nodeguard.example/api/v1/fixture-admin/server/manage/getNodes",
    NODEGUARD_V2BOARD_AUTH: "Bearer fixture-panel-token", NODEGUARD_ENABLE_PROVISION: "1" },
  stdio: "ignore",
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if ((await fetch(base + "/api/v1/status").catch(() => null))?.ok) break;
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
  const context = await browser.newContext({ locale: "fa-IR" });
  await context.addCookies([{ name: "nodeguard-locale", value: "fa-IR", url: base }]);
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("nodeguard-locale", "fa-IR"));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  assert.equal((await page.request.post(base + "/api/v1/session", { data: { userId: "usr-reza", token } })).status(), 200);
  assert.equal((await page.request.post(base + "/api/v1/providers/v2board/sync")).status(), 200);
  await page.goto(base + "/nodes");
  await page.getByRole("row", { name: /Mapped V2Board node/ }).getByRole("button", { name: "ویرایش نود" }).waitFor();
  const removal = page.getByRole("button", { name: "حذف V2bX", exact: true });
  assert.equal(await removal.count(), 0);
  await page.goto(base + "/servers/exit-1");
  await removal.click();
  const dialog = page.getByRole("dialog", { name: "حذف V2bX" });
  await dialog.locator('option[value="vmess:7"]').waitFor({ state: "attached" });
  assert.equal(await dialog.locator("select").inputValue(), "");
  assert.equal(await dialog.locator('option[value="vless:8"]').count(), 0);
  await dialog.getByRole("button", { name: "نود V2Board", exact: true }).click();
  await page.getByRole("option", { name: "Mapped V2Board node (vmess:7)", exact: true }).click();
  assert.equal(await dialog.locator("select").inputValue(), "vmess:7");
  await dialog.getByRole("button", { name: "انصراف" }).click();
  await page.goto(base + "/servers/ir-main");
  await page.getByRole("heading", { name: "ارتباط Workerهای میزبان" }).waitFor();
  assert.equal(await removal.count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: nodes page loads without runtime errors; V2bX removal appears only on foreign server details with explicit node selection.");
} finally {
  await browser?.close();
  child.kill();
}
