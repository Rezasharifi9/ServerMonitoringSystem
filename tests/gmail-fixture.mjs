import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Duplex } from "node:stream";
import tls from "node:tls";

const file = process.env.NODEGUARD_GMAIL_TEST_STATE;
const connect = tls.connect;
if (file) {
  tls.connect = (options, ...args) => {
    if (options.host !== "smtp.gmail.com") return connect(options, ...args);
    assert.equal(options.port, 465);
    assert.equal(options.servername, "smtp.gmail.com");
    let step = 0;
    const answers = ["250-fixture\r\n250 AUTH PLAIN", "235 accepted", "250 sender", "250 recipient", "354 continue", "250 queued"];
    const expected = [/^EHLO /, /^AUTH PLAIN /, /^MAIL FROM:<sender@gmail\.com>/,
      /^RCPT TO:<receiver@example\.com>/, /^DATA\r\n$/, /^From: sender@gmail\.com\r\n/];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        const value = chunk.toString();
        assert.match(value, expected[step]);
        if (step === 5) {
          assert.match(value, /\r\n\.\r\n$/);
          const encoded = value.split("\r\n\r\n")[1].split("\r\n.")[0];
          assert.match(Buffer.from(encoded, "base64").toString(), /CPU fixture/);
          writeFileSync(file, "accepted\n");
        }
        this.push(answers[step++] + "\r\n");
        done();
      },
    });
    setImmediate(() => socket.push("220 fixture SMTP\r\n"));
    return socket;
  };
  syncBuiltinESMExports();
}
