import { VERSION } from "./constants.js";
import { loadConfig } from "./config.js";
import { checkTcpTarget } from "./diag.js";
import { dnsStatus } from "./dns.js";
import { buildSubscription } from "./subscription.js";
import { handleWebSocket } from "./transport.js";
import { json, log, message, normPath, txt } from "./utils.js";

export default {
  async fetch(request, env = {}) {
    let cfg;
    try {
      const url = new URL(request.url);
      cfg = loadConfig(env, url, request);

      if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
        if (!cfg.uuid) return txt("Missing UUID secret", 500);
        return handleWebSocket(request, cfg);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return txt("Method Not Allowed", 405, { Allow: "GET, HEAD" });
      }

      return handleHttp(request, url, cfg);
    } catch (err) {
      log(cfg, "fetch_error", { message: message(err) });
      return txt("Internal Server Error", 500);
    }
  },
};

async function handleHttp(request, url, cfg) {
  const path = normPath(url.pathname);
  const head = request.method === "HEAD";
  const uuidBase = cfg.uuid ? `/${cfg.uuid}` : "";

  if (path === "/health") {
    return json({ ok: true, service: "up2-worker", version: VERSION, time: new Date().toISOString() }, 200, head);
  }

  if (path === "/status") {
    const dns = dnsStatus();
    return json({
      ok: true,
      version: VERSION,
      uuidConfigured: Boolean(cfg.uuid),
      proxyPolicy: cfg.policy,
      proxyCount: cfg.proxies.length,
      socks5Configured: Boolean(cfg.socks5),
      socks5Host: cfg.socks5 ? `${cfg.socks5.host}:${cfg.socks5.port}` : null,
      proxyFailCooldownMs: cfg.proxyCooldown,
      doh: cfg.doh,
      dohStrategy: cfg.dohStrategy,
      preferredDoh: dns.preferredDoh,
      dnsCacheEntries: dns.dnsCacheEntries,
      dnsCacheTtlSeconds: cfg.dnsCacheTtl,
      dnsTcpFallback: cfg.dnsTcpFallback,
      dnsTcpServers: cfg.dnsTcp,
      connectTimeoutMs: cfg.connectTimeout,
      dnsTimeoutMs: cfg.dnsTimeout,
      time: new Date().toISOString(),
    }, 200, head);
  }

  if (path === "/diag/tcp") {
    return json(await checkTcpTarget(url.searchParams.get("target") || "cloudflare.com:443", cfg.connectTimeout), 200, head);
  }

  if (path === "/" || (uuidBase && path === uuidBase)) {
    const body = cfg.uuid
      ? `Up2 OK\nSubscription: ${url.origin}/${cfg.uuid}/sub\nDiagnostic: ${url.origin}/diag/tcp?target=cloudflare.com:443\n`
      : "Up2 OK\nSet UUID first\n";
    return txt(body, 200, {}, head);
  }

  if (cfg.uuid && (path === `${uuidBase}/sub` || path === `/sub/${cfg.uuid}`)) {
    return txt(buildSubscription(url, cfg), 200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    }, head);
  }

  return txt("Not Found", 404, {}, head);
}
