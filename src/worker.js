import { connect } from "cloudflare:sockets";

const VERSION = "up2-vless-worker-2026-05-16";
const CF_IPS = ["104.16.0.0", "104.17.0.0", "104.18.0.0", "104.19.0.0", "104.20.0.0", "104.21.0.0", "172.64.0.0", "172.65.0.0", "172.66.0.0", "172.67.0.0"];
const DOH = ["https://cloudflare-dns.com/dns-query", "https://dns.google/dns-query", "https://dns.quad9.net/dns-query"];
const DNS_TCP = ["1.1.1.1:53", "8.8.8.8:53", "9.9.9.9:53"];
const WS_OPEN = 1;
const WS_CLOSING = 2;
const DNS_CACHE_LIMIT = 256;
const dnsCache = new Map();
const badProxyUntil = new Map();
let preferredDoh = "";

export default {
  async fetch(request, env = {}, ctx) {
    let cfg;
    try {
      const url = new URL(request.url);
      cfg = config(env, url, request);
      if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
        if (!cfg.uuid) return txt("Missing UUID secret", 500);
        return ws(request, cfg);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return txt("Method Not Allowed", 405, { Allow: "GET, HEAD" });
      return http(request, url, cfg);
    } catch (err) {
      log(cfg, "fetch_error", { message: message(err) });
      return txt("Internal Server Error", 500);
    }
  },
};

function http(request, url, cfg) {
  const path = normPath(url.pathname);
  const head = request.method === "HEAD";
  const uuidBase = cfg.uuid ? `/${cfg.uuid}` : "";

  if (path === "/health") return json({ ok: true, service: "up2-vless-worker", version: VERSION, time: new Date().toISOString() }, 200, head);
  if (path === "/status") return json({ ok: true, version: VERSION, uuidConfigured: Boolean(cfg.uuid), proxyPolicy: cfg.policy, proxyCount: cfg.proxies.length, proxyFailCooldownMs: cfg.proxyCooldown, doh: cfg.doh, dohStrategy: cfg.dohStrategy, preferredDoh: preferredDoh || null, dnsCacheEntries: dnsCache.size, dnsCacheTtlSeconds: cfg.dnsCacheTtl, dnsTcpFallback: cfg.dnsTcpFallback, dnsTcpServers: cfg.dnsTcp, connectTimeoutMs: cfg.connectTimeout, dnsTimeoutMs: cfg.dnsTimeout, time: new Date().toISOString() }, 200, head);
  if (path === "/" || (uuidBase && path === uuidBase)) return html(home(url, cfg), 200, head);
  if (cfg.uuid && (path === `${uuidBase}/sub` || path === `/sub/${cfg.uuid}`)) return txt(subscription(url, cfg), 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, head);
  return txt("Not Found", 404, {}, head);
}

async function ws(request, cfg) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const readable = wsReadable(server, request.headers.get("sec-websocket-protocol") || "", cfg);
  const remote = { socket: null };
  let udpWrite = null;
  let label = "";

  readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (udpWrite) return udpWrite(chunk);
      if (remote.socket) {
        const writer = remote.socket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const parsed = parseVless(chunk, cfg.uuid);
      if (parsed.error) throw new Error(parsed.message);
      label = `${parsed.host}:${parsed.port}/${parsed.udp ? "udp" : "tcp"}`;
      const responseHeader = new Uint8Array([parsed.version[0], 0]);
      const payload = chunk.slice(parsed.offset);
      if (parsed.udp) {
        if (parsed.port !== 53) throw new Error("UDP is only supported for DNS on port 53");
        udpWrite = dnsUdpWriter(server, responseHeader, cfg);
        return udpWrite(payload);
      }
      return tcpConnect(remote, parsed.host, parsed.port, payload, server, responseHeader, cfg);
    },
    close() { closeWs(server); },
    abort(reason) { log(cfg, "ws_abort", { label, reason: String(reason) }); closeWs(server); },
  })).catch((err) => {
    log(cfg, "ws_error", { label, message: message(err) });
    closeWs(server);
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function tcpConnect(remote, host, port, firstPayload, webSocket, responseHeader, cfg) {
  let last;
  for (const target of candidates(host, port, cfg)) {
    try {
      log(cfg, "tcp_try", target);
      const socket = connect({ hostname: target.host, port: target.port });
      if (socket.opened) await timeout(socket.opened, cfg.connectTimeout, "TCP connect timeout");
      remote.socket = socket;
      const writer = socket.writable.getWriter();
      if (firstPayload?.byteLength) await writer.write(firstPayload);
      writer.releaseLock();
      socket.closed.catch(() => {}).finally(() => closeWs(webSocket));
      pipeRemote(socket, webSocket, responseHeader, cfg);
      return;
    } catch (err) {
      last = err;
      if (target.kind === "proxy" && cfg.proxyCooldown > 0) badProxyUntil.set(target.id, Date.now() + cfg.proxyCooldown);
      log(cfg, "tcp_fail", { ...target, message: message(err) });
      try { remote.socket?.close(); } catch {}
      remote.socket = null;
    }
  }
  throw last || new Error("All TCP connection attempts failed");
}

function candidates(host, port, cfg) {
  const direct = [{ kind: "direct", host, port, id: `d:${host}:${port}` }];
  const proxies = cfg.proxies.map((value) => {
    const p = hostPort(value, port);
    return { kind: "proxy", host: p.host, port: p.port, id: `p:${p.host}:${p.port}` };
  }).filter((p) => p.host);
  const usable = proxies.filter((p) => !cooling(p.id));
  const p = usable.length ? usable : proxies;
  if (cfg.policy === "proxy-only") return p;
  if (cfg.policy === "proxy-first") return [...p, ...direct];
  return [...direct, ...p];
}

function cooling(id) {
  const until = badProxyUntil.get(id) || 0;
  if (!until) return false;
  if (Date.now() > until) { badProxyUntil.delete(id); return false; }
  return true;
}

function pipeRemote(socket, webSocket, responseHeader, cfg) {
  let header = responseHeader;
  socket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (webSocket.readyState !== WS_OPEN) throw new Error("WebSocket is not open");
      if (header) { webSocket.send(await new Blob([header, chunk]).arrayBuffer()); header = null; }
      else webSocket.send(chunk);
    },
  })).catch((err) => {
    log(cfg, "pipe_error", { message: message(err) });
    closeWs(webSocket);
  }).finally(() => closeWs(webSocket));
}

function dnsUdpWriter(webSocket, responseHeader, cfg) {
  let header = responseHeader;
  return async (chunk) => {
    for (const query of udpFrames(chunk, cfg)) {
      let answer;
      try { answer = await resolveDns(query, cfg); }
      catch (err) { log(cfg, "dns_error", { message: message(err) }); answer = dnsError(query); }
      if (!answer || webSocket.readyState !== WS_OPEN) continue;
      const bytes = answer instanceof Uint8Array ? answer : new Uint8Array(answer);
      const len = new Uint8Array([(bytes.byteLength >> 8) & 255, bytes.byteLength & 255]);
      const frame = header ? await new Blob([header, len, bytes]).arrayBuffer() : await new Blob([len, bytes]).arrayBuffer();
      header = null;
      webSocket.send(frame);
    }
  };
}

function udpFrames(chunk, cfg) {
  const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  const out = [];
  let off = 0;
  while (off + 2 <= data.byteLength) {
    const len = (data[off] << 8) | data[off + 1];
    off += 2;
    if (len <= 0 || off + len > data.byteLength) { log(cfg, "udp_bad_len", { len }); break; }
    out.push(data.slice(off, off + len));
    off += len;
  }
  if (!out.length && data.byteLength) out.push(data);
  return out;
}

async function resolveDns(query, cfg) {
  const q = query instanceof Uint8Array ? query : new Uint8Array(query);
  if (!isDnsQuery(q)) return dnsError(q);
  const key = btoa(String.fromCharCode(...q));
  const cached = cacheGet(key);
  if (cached) return cached;
  let answer = cfg.dohStrategy === "race" ? await dohRace(q, cfg) : await dohSeq(q, cfg);
  if (!answer && cfg.dnsTcpFallback) answer = await dnsTcp(q, cfg);
  if (!answer) throw new Error("DNS query failed");
  cachePut(key, answer, cfg);
  return answer;
}

function isDnsQuery(q) {
  if (!q || q.byteLength < 12) return false;
  const flags = (q[2] << 8) | q[3];
  const qd = (q[4] << 8) | q[5];
  return !(flags & 0x8000) && qd > 0;
}

async function dohRace(query, cfg) {
  const controllers = [];
  try {
    return await new Promise((resolve) => {
      let remaining = cfg.doh.length;
      let done = false;
      for (const endpoint of dohOrder(cfg)) {
        const controller = new AbortController();
        controllers.push(controller);
        const started = Date.now();
        timeout(fetch(endpoint, { method: "POST", headers: { "content-type": "application/dns-message", accept: "application/dns-message" }, body: query, signal: controller.signal }), cfg.dnsTimeout, "DNS query timeout")
          .then(async (res) => {
            if (!res.ok) throw new Error(`DoH returned ${res.status}`);
            const body = await res.arrayBuffer();
            if (!done) { done = true; preferredDoh = endpoint; log(cfg, "doh_win", { endpoint, latencyMs: Date.now() - started }); resolve(body); }
          })
          .catch((err) => log(cfg, "doh_fail", { endpoint, message: message(err) }))
          .finally(() => { remaining -= 1; if (remaining === 0 && !done) { done = true; resolve(null); } });
      }
    });
  } finally {
    for (const controller of controllers) try { controller.abort(); } catch {}
  }
}

async function dohSeq(query, cfg) {
  for (const endpoint of dohOrder(cfg)) {
    try {
      const res = await timeout(fetch(endpoint, { method: "POST", headers: { "content-type": "application/dns-message", accept: "application/dns-message" }, body: query }), cfg.dnsTimeout, "DNS query timeout");
      if (!res.ok) throw new Error(`DoH returned ${res.status}`);
      preferredDoh = endpoint;
      return await res.arrayBuffer();
    } catch (err) { log(cfg, "doh_fail", { endpoint, message: message(err) }); }
  }
  return null;
}

function dohOrder(cfg) {
  return preferredDoh && cfg.doh.includes(preferredDoh) ? [preferredDoh, ...cfg.doh.filter((x) => x !== preferredDoh)] : cfg.doh;
}

async function dnsTcp(query, cfg) {
  let last;
  for (const server of cfg.dnsTcp) {
    const hp = hostPort(server, 53);
    try {
      const socket = connect({ hostname: hp.host, port: hp.port });
      if (socket.opened) await timeout(socket.opened, cfg.dnsTimeout, "DNS TCP connect timeout");
      const writer = socket.writable.getWriter();
      await writer.write(new Uint8Array([(query.byteLength >> 8) & 255, query.byteLength & 255]));
      await writer.write(query);
      writer.releaseLock();
      const answer = await timeout(readDnsTcp(socket), cfg.dnsTimeout, "DNS TCP read timeout");
      try { socket.close(); } catch {}
      return answer;
    } catch (err) { last = err; log(cfg, "dns_tcp_fail", { server, message: message(err) }); }
  }
  throw last || new Error("DNS TCP fallback failed");
}

async function readDnsTcp(socket) {
  const reader = socket.readable.getReader();
  const chunks = [];
  let total = 0, expected = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) { chunks.push(value); total += value.byteLength; }
      const merged = concat(chunks, total);
      if (expected === null && merged.byteLength >= 2) expected = ((merged[0] << 8) | merged[1]) + 2;
      if (expected !== null && merged.byteLength >= expected) return merged.slice(2, expected).buffer;
    }
  } finally { reader.releaseLock(); }
  throw new Error("DNS TCP response ended early");
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function cacheGet(key) {
  const item = dnsCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { dnsCache.delete(key); return null; }
  return item.value.slice(0);
}

function cachePut(key, value, cfg) {
  if (cfg.dnsCacheTtl <= 0) return;
  if (dnsCache.size >= DNS_CACHE_LIMIT) dnsCache.delete(dnsCache.keys().next().value);
  dnsCache.set(key, { expires: Date.now() + cfg.dnsCacheTtl * 1000, value: value.slice(0) });
}

function dnsError(query) {
  const q = query instanceof Uint8Array ? query : new Uint8Array(query || []);
  const r = new Uint8Array(12);
  r[0] = q[0] || 0;
  r[1] = q[1] || 0;
  r[2] = 0x81;
  r[3] = 0x82;
  return r.buffer;
}

function wsReadable(webSocket, earlyDataHeader, cfg) {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", (event) => {
        if (cancelled) return;
        controller.enqueue(typeof event.data === "string" ? new TextEncoder().encode(event.data) : event.data);
      });
      webSocket.addEventListener("close", () => { closeWs(webSocket); if (!cancelled) controller.close(); });
      webSocket.addEventListener("error", (event) => controller.error(event));
      const early = earlyData(earlyDataHeader);
      if (early) controller.enqueue(early);
    },
    cancel(reason) { cancelled = true; log(cfg, "read_cancel", { reason: String(reason) }); closeWs(webSocket); },
  });
}

function earlyData(value) {
  if (!value) return null;
  try {
    const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "===".slice((normalized.length + 3) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0)).buffer;
  } catch { return null; }
}

function parseVless(chunk, expectedUuid) {
  const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  if (data.byteLength < 24) return { error: true, message: "Invalid VLESS header" };
  const version = data.slice(0, 1);
  const uuid = bytesToUuid(data.slice(1, 17));
  if (uuid !== expectedUuid) return { error: true, message: "Invalid UUID" };
  const optLen = data[17];
  const cmdOff = 18 + optLen;
  if (data.byteLength < cmdOff + 4) return { error: true, message: "Invalid VLESS header length" };
  const cmd = data[cmdOff];
  if (cmd !== 1 && cmd !== 2) return { error: true, message: `Unsupported VLESS command: ${cmd}` };
  const udp = cmd === 2;
  const port = new DataView(data.buffer, data.byteOffset + cmdOff + 1, 2).getUint16(0);
  const atype = data[cmdOff + 3];
  let off = cmdOff + 4;
  let host = "";
  if (atype === 1) { if (data.byteLength < off + 4) return { error: true, message: "Bad IPv4" }; host = [...data.slice(off, off + 4)].join("."); off += 4; }
  else if (atype === 2) { const len = data[off++]; if (data.byteLength < off + len) return { error: true, message: "Bad domain" }; host = new TextDecoder().decode(data.slice(off, off + len)); off += len; }
  else if (atype === 3) { if (data.byteLength < off + 16) return { error: true, message: "Bad IPv6" }; const v = new DataView(data.buffer, data.byteOffset + off, 16); const g = []; for (let i = 0; i < 8; i++) g.push(v.getUint16(i * 2).toString(16)); host = g.join(":"); off += 16; }
  else return { error: true, message: `Invalid address type: ${atype}` };
  return host ? { error: false, version, host, port, udp, offset: off } : { error: true, message: "Empty remote address" };
}

function subscription(url, cfg) {
  if (!cfg.uuid) throw new Error("UUID is required");
  const host = val(url, "host") || url.hostname;
  const sni = val(url, "sni") || host;
  const fp = /^[a-z0-9_-]{1,32}$/.test((val(url, "fp") || "chrome").toLowerCase()) ? (val(url, "fp") || "chrome").toLowerCase() : "chrome";
  const alpnRaw = (val(url, "alpn") || "h3,h2,http/1.1").toLowerCase();
  const alpn = ["0", "false", "off", "none", "disable", "disabled"].includes(alpnRaw) ? "" : (/^[a-z0-9.,/_-]{1,64}$/.test(alpnRaw) ? alpnRaw : "h3,h2,http/1.1");
  const ed = String(int(val(url, "ed"), 2048));
  const name = val(url, "name") || "Up2-VLESS";
  const count = clamp(int(val(url, "count"), 10), 1, 30);
  const addresses = csv(val(url, "ips") || val(url, "ip"), [host, ...CF_IPS]).slice(0, count);
  const ports = csv(val(url, "ports") || val(url, "port"), ["443"]).map((p) => portNum(p, null)).filter(Boolean);
  const path = encodeURIComponent(clientPath(url, cfg.uuid, ed));
  const out = [];
  for (const addr of addresses) for (const port of ports) {
    const p = new URLSearchParams({ encryption: "none", security: "tls", sni, fp, type: "ws", host, path });
    if (alpn) p.set("alpn", alpn);
    out.push(`vless://${cfg.uuid}@${addr}:${port}?${p.toString()}#${encodeURIComponent(`${name}-${addr}-${port}`)}`);
  }
  return btoa(out.join("\n"));
}

function clientPath(url, uuid, ed) {
  const explicit = val(url, "wspath") || val(url, "ws_path") || val(url, "path");
  if (explicit) return explicit;
  const p = new URLSearchParams({ ed });
  for (const k of ["proxyip", "proxy_ips", "proxy", "proxyPolicy", "proxy_policy", "policy", "doh", "dohs", "dohStrategy", "dnsTcp", "timeout", "connectTimeout", "dnsTimeout", "cache", "dnsCache"]) {
    const v = val(url, k);
    if (v) p.set(k, v);
  }
  return `/${uuid}?${p.toString()}`;
}

function config(env, url, request) {
  const uuid = uuidNorm(first(env.UUID, env.uuid, env.USER_ID, env.userID));
  const proxies = csv(first(val(url, "proxyip"), val(url, "proxy_ips"), val(url, "proxy"), env.PROXY_HOSTS, env.PROXY_IPS, env.PROXYIP, env.proxyip), []);
  let policy = policyNorm(first(val(url, "proxyPolicy"), val(url, "proxy_policy"), val(url, "policy"), env.PROXY_POLICY), proxies.length ? "proxy-first" : "direct-first");
  if (bool(first(env.DISABLE_DIRECT, env.disableDirect), false)) policy = "proxy-only";
  return { uuid, proxies, policy, proxyCooldown: clamp(int(first(env.PROXY_FAIL_COOLDOWN_MS, env.proxyFailCooldownMs), 120000), 0, 900000), connectTimeout: clamp(int(first(val(url, "timeout"), val(url, "connectTimeout"), env.CONNECT_TIMEOUT_MS), 6000), 1000, 30000), dnsTimeout: clamp(int(first(val(url, "dnsTimeout"), env.DNS_TIMEOUT_MS), 5000), 1000, 30000), doh: csv(first(val(url, "doh"), val(url, "dohs"), env.DOH_ENDPOINTS), DOH), dohStrategy: dohStrategy(first(val(url, "dohStrategy"), env.DOH_STRATEGY), "race"), dnsCacheTtl: clamp(int(first(val(url, "cache"), val(url, "dnsCache"), env.DNS_CACHE_TTL_SECONDS), 60), 0, 3600), dnsTcpFallback: bool(first(val(url, "dnsTcp"), env.DNS_TCP_FALLBACK), true), dnsTcp: csv(first(env.DNS_TCP_SERVERS), DNS_TCP), logs: bool(first(env.ENABLE_LOGS), false), host: request.headers.get("Host") || url.host };
}

function home(url, cfg) {
  const sub = cfg.uuid ? `${url.origin}/${cfg.uuid}/sub` : "Set UUID first";
  const status = cfg.uuid ? "Ready" : "Needs UUID";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Up2 VLESS Worker</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1020;color:#e5e7eb;margin:0;padding:32px}main{max-width:780px;margin:auto;background:#111827;border:1px solid #263247;border-radius:16px;padding:28px;box-shadow:0 18px 60px rgba(0,0,0,.35)}h1{margin-top:0}.ok{color:#86efac}.warn{color:#fbbf24}code{background:#020617;border:1px solid #243244;border-radius:8px;padding:2px 6px;color:#93c5fd;word-break:break-all}.card{background:#0f172a;border:1px solid #243244;border-radius:12px;padding:14px;margin:14px 0}</style></head><body><main><h1><span class="${cfg.uuid ? "ok" : "warn"}">${esc(status)}</span> Up2 VLESS Worker</h1><div class="card"><b>UUID configured:</b> <code>${esc(String(Boolean(cfg.uuid)))}</code></div><div class="card"><b>Subscription:</b> <code>${esc(sub)}</code></div><div class="card"><b>Proxy policy:</b> <code>${esc(cfg.policy)}</code></div><div class="card"><b>Health:</b> <code>/health</code> | <b>Status:</b> <code>/status</code></div></main></body></html>`;
}

function bytesToUuid(bytes) { const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")); return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`; }
function uuidNorm(v) { const s = String(v || "").trim().toLowerCase(); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : ""; }
function hostPort(v, fallbackPort) { const s = String(v || "").trim(); if (!s) return { host: "", port: fallbackPort }; if (s.startsWith("[")) { const end = s.indexOf("]"); if (end > 0) return { host: s.slice(1, end), port: s[end + 1] === ":" ? portNum(s.slice(end + 2), fallbackPort) : fallbackPort }; } const i = s.lastIndexOf(":"); if (i > 0 && !s.slice(0, i).includes(":")) { const p = portNum(s.slice(i + 1), null); if (p) return { host: s.slice(0, i), port: p }; } return { host: s, port: fallbackPort }; }
function portNum(v, fallback) { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback; }
function val(url, key) { return (url.searchParams.get(key) || "").trim(); }
function first(...xs) { for (const x of xs) { if (typeof x === "string" && x.trim()) return x.trim(); if (typeof x === "number" || typeof x === "boolean") return String(x); } return ""; }
function csv(v, fallback) { const a = String(v || "").split(",").map((x) => x.trim()).filter(Boolean); return a.length ? a : [...fallback]; }
function int(v, fallback) { const n = Number(v); return Number.isInteger(n) ? n : fallback; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function bool(v, fallback) { if (v === "" || v === undefined || v === null) return fallback; const s = String(v).trim().toLowerCase(); if (["1", "true", "yes", "y", "on"].includes(s)) return true; if (["0", "false", "no", "n", "off"].includes(s)) return false; return fallback; }
function policyNorm(v, fallback) { const s = String(v || "").trim().toLowerCase(); return ["direct-first", "proxy-first", "proxy-only"].includes(s) ? s : fallback; }
function dohStrategy(v, fallback) { const s = String(v || "").trim().toLowerCase(); return ["race", "sequential"].includes(s) ? s : fallback; }
function normPath(p) { let s = p || "/"; if (!s.startsWith("/")) s = `/${s}`; if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1); return s; }
function closeWs(ws) { try { if (ws.readyState === WS_OPEN || ws.readyState === WS_CLOSING) ws.close(1000, "closed"); } catch {} }
function timeout(promise, ms, msg) { let t; const timeoutPromise = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(msg)), ms); }); return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(t)); }
function txt(body, status = 200, headers = {}, head = false) { return new Response(head ? null : body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } }); }
function json(body, status = 200, head = false) { return new Response(head ? null : JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function html(body, status = 200, head = false) { return new Response(head ? null : body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }); }
function esc(v) { return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function message(err) { return err?.message || String(err); }
function log(cfg, event, data = {}) { if (!cfg?.logs) return; try { console.log(JSON.stringify({ event, ...data, time: new Date().toISOString() })); } catch {} }
