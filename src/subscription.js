import { CF_IPS } from "./constants.js";
import { clamp, csv, int, portNum, val } from "./utils.js";

const DEFAULT_ALPN = "http/1.1";

export function buildSubscription(url, cfg) {
  if (!cfg.uuid) throw new Error("UUID is required");

  const host = val(url, "host") || url.hostname;
  const sni = val(url, "sni") || host;
  const fp = normalizeFingerprint(val(url, "fp") || "chrome");
  const alpn = normalizeAlpn(val(url, "alpn") || DEFAULT_ALPN);
  const ed = String(int(val(url, "ed"), 2048));
  const name = val(url, "name") || "Up2-VLESS";
  const count = clamp(int(val(url, "count"), 10), 1, 30);
  const addresses = csv(val(url, "ips") || val(url, "ip"), [host, ...CF_IPS]).slice(0, count);
  const ports = csv(val(url, "ports") || val(url, "port"), ["443"]).map((p) => portNum(p, null)).filter(Boolean);
  const path = buildClientPath(url, cfg.uuid, ed);

  const lines = [];
  for (const address of addresses) {
    for (const port of ports) {
      const params = new URLSearchParams({
        encryption: "none",
        security: "tls",
        sni,
        fp,
        type: "ws",
        host,
        path,
      });
      if (alpn) params.set("alpn", alpn);
      lines.push(`vless://${cfg.uuid}@${address}:${port}?${params.toString()}#${encodeURIComponent(`${name}-${address}-${port}`)}`);
    }
  }

  return btoa(lines.join("\n"));
}

export function buildClientPath(url, uuid, ed) {
  const explicit = val(url, "wspath") || val(url, "ws_path") || val(url, "path");
  if (explicit) return explicit;

  const params = new URLSearchParams({ ed });
  for (const key of [
    "proxyip",
    "proxy_ips",
    "proxy",
    "proxyPolicy",
    "proxy_policy",
    "policy",
    "doh",
    "dohs",
    "dohStrategy",
    "dnsTcp",
    "timeout",
    "connectTimeout",
    "dnsTimeout",
    "cache",
    "dnsCache",
  ]) {
    const value = val(url, key);
    if (value) params.set(key, value);
  }
  return `/${uuid}?${params.toString()}`;
}

function normalizeFingerprint(value) {
  const fp = String(value || "chrome").trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(fp) ? fp : "chrome";
}

function normalizeAlpn(value) {
  const alpn = String(value || "").trim().toLowerCase();
  if (!alpn || ["0", "false", "off", "none", "disable", "disabled"].includes(alpn)) return "";
  return /^[a-z0-9.,/_-]{1,64}$/.test(alpn) ? alpn : DEFAULT_ALPN;
}
