import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, Dispatcher1Wrapper } from "undici";
import { ApiError } from "./http";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix);
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(address, prefix, "ipv6");

export function publicIp(address: string) {
  const version = isIP(address);
  return version === 4 ? !blocked.check(address) :
    version === 6 && /^[23][a-f0-9]{3}:/i.test(address) && !blocked.check(address, "ipv6");
}

export function validatePublicHttps(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password ||
      (isIP(host) ? !publicIp(host) : !host.includes(".") || /(?:^|\.)(localhost|local|internal)\.?$/i.test(host))) {
    throw new ApiError(422, "PANEL_ADDRESS", "آدرس پنل باید یک نشانی عمومی HTTPS باشد.");
  }
}

export function publicDispatcher() {
  // The Node.js fetch API expects the legacy dispatcher handler contract.
  return new Dispatcher1Wrapper(new Agent({ connect: { lookup(hostname, options, callback) {
    // This lookup supplies the actual socket addresses, so DNS is not resolved again after validation.
    lookup(hostname, { all: true }, (error, records) => {
      if (error) return callback(error, "", 0);
      if (!records.length || records.some(({ address }) => !publicIp(address))) {
        return callback(new Error("Non-public panel address"), "", 0);
      }
      const usable = records.filter(({ family }) => !options.family || options.family === family);
      if (!usable.length) return callback(new Error("No compatible panel address"), "", 0);
      if (options.all) return callback(null, usable);
      return callback(null, usable[0].address, usable[0].family);
    });
  } } }));
}
