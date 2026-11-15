import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const upstream = globalThis.fetch;
const filename = process.env.NODEGUARD_TELEGRAM_TEST_STATE;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "api.telegram.org") return upstream(input, init);
  assert.equal(url.pathname, "/bot100:fixture_test_token_abcdef/sendMessage");
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  assert.equal(body.chat_id, "-100123456789");
  assert.equal(typeof body.text, "string");
  let state = { calls: [] };
  try { state = JSON.parse(readFileSync(filename, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  state.calls.push(body.text);
  writeFileSync(filename, JSON.stringify(state));
  if (state.calls.length === 1) return Response.json({ ok: false, parameters: { retry_after: 20 } }, { status: 429 });
  if (state.calls.length === 3) throw new Error("Fixture lost Telegram response");
  return Response.json({ ok: true, result: { message_id: 500 + state.calls.length } });
};
