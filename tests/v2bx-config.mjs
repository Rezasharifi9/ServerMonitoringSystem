import assert from "node:assert/strict";
import { v2bxBackendSettings, v2bxCertificate } from "../src/lib/v2bx-node-config.ts";

const node = (type, fields = {}) => ({ type, id: 286, revision: "fixture", fields: { host: "node.example.org", ...fields } });
const cert = (n, remote) => v2bxCertificate(n, v2bxBackendSettings.parse({ server_port: 443, ...remote }), "");
for (const type of ["vmess", "vless"]) {
  for (const network of ["tcp", "ws", "grpc", "httpupgrade", "splithttp"]) {
    assert.deepEqual(cert(node(type), { tls: 0, network }), { CertMode: "none" });
    assert.equal(cert(node(type), { tls: 1, network }).CertMode, "http");
  }
}
assert.equal(cert(node("vless"), { tls: 2 }).CertMode, "none");
assert.equal(cert(node("shadowsocks"), {}).CertMode, "none");
for (const type of ["trojan", "hysteria"]) {
  assert.equal(cert(node(type), {}).CertMode, "http");
  assert.equal(cert(node(type, { insecure: 1 }), {}).CertMode, "self");
}
const vmess = node("vmess", { host: "192.0.2.1", tlsSettings: { serverName: "sni.example.org", allowInsecure: 0 } });
assert.equal(cert(vmess, { tls: 1 }).CertDomain, "sni.example.org");
assert.equal(cert(node("vmess", { tlsSettings: { allowInsecure: true } }), { tls: 1 }).CertMode, "self");
assert.equal(cert(node("vless", { tls_settings: { allow_insecure: "1" } }), { tls: "1" }).CertMode, "self");
assert.equal(cert(vmess, { tls: 1, tls_settings: { server_name: "remote.example.org" } }).CertDomain, "remote.example.org");
assert.equal(cert(vmess, { tls: 1, tlsSettings: { server_name: "camel.example.org" }, tls_settings: { server_name: "snake.example.org" } }).CertDomain, "camel.example.org");
assert.throws(() => cert(node("vless", { host: "192.0.2.1" }), { tls: 1 }), /PANEL_NODE_CERT_DOMAIN/);
assert.throws(() => v2bxBackendSettings.parse({ server_port: 70000, tls: 1 }));
assert.throws(() => v2bxBackendSettings.parse({ server_port: 443, tls: 3 }));
console.log("PASS: V2Board certificate selection across protocols, transports, TLS, Reality, and API naming variants");
