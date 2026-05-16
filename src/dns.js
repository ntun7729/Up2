import { connect } from "cloudflare:sockets";
import { DNS_CACHE_LIMIT } from "./constants.js";
import { concat, hostPort, log, message, timeout } from "./utils.js";

const dnsCache = new Map();
let preferredDoh = "";

export function dnsStatus() {
  return { preferredDoh: preferredDoh || null, dnsCacheEntries: dnsCache.size };
}

export function dnsUdpWriter(webSocket, responseHeader, cfg) {
  let header = responseHeader;
  return async (chunk) => {
    for (const query of udpFrames(chunk, cfg)) {
      let answer;
      try {
        answer = await resolveDns(query, cfg);
      } catch (err) {
        log(cfg, "dns_error", { message: message(err) });
        answer = dnsError(query);
      }
      if (!answer || webSocket.readyState !== 1) continue;
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
  const frames = [];
  let offset = 0;
  while (offset + 2 <= data.byteLength) {
    const len = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    if (len <= 0 || offset + len > data.byteLength) {
      log(cfg, "udp_bad_len", { len });
      break;
    }
    frames.push(data.slice(offset, offset + len));
    offset += len;
  }
  if (!frames.length && data.byteLength) frames.push(data);
  return frames;
}

async function resolveDns(query, cfg) {
  const q = query instanceof Uint8Array ? query : new Uint8Array(query);
  if (!isDnsQuery(q)) return dnsError(q);

  const key = btoa(String.fromCharCode(...q));
  const cached = cacheGet(key);
  if (cached) return cached;

  let answer = cfg.dohStrategy === "race" ? await dohRace(q, cfg) : await dohSequential(q, cfg);
  if (!answer && cfg.dnsTcpFallback) answer = await dnsTcp(q, cfg);
  if (!answer) throw new Error("DNS query failed");

  cachePut(key, answer, cfg);
  return answer;
}

function isDnsQuery(query) {
  if (!query || query.byteLength < 12) return false;
  const flags = (query[2] << 8) | query[3];
  const questions = (query[4] << 8) | query[5];
  return !(flags & 0x8000) && questions > 0;
}

async function dohRace(query, cfg) {
  const controllers = [];
  try {
    return await new Promise((resolve) => {
      let remaining = cfg.doh.length;
      let settled = false;
      for (const endpoint of dohOrder(cfg)) {
        const controller = new AbortController();
        controllers.push(controller);
        const started = Date.now();
        timeout(fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/dns-message", accept: "application/dns-message" },
          body: query,
          signal: controller.signal,
        }), cfg.dnsTimeout, "DNS query timeout")
          .then(async (res) => {
            if (!res.ok) throw new Error(`DoH returned ${res.status}`);
            const body = await res.arrayBuffer();
            if (!settled) {
              settled = true;
              preferredDoh = endpoint;
              log(cfg, "doh_win", { endpoint, latencyMs: Date.now() - started });
              resolve(body);
            }
          })
          .catch((err) => log(cfg, "doh_fail", { endpoint, message: message(err) }))
          .finally(() => {
            remaining -= 1;
            if (remaining === 0 && !settled) {
              settled = true;
              resolve(null);
            }
          });
      }
    });
  } finally {
    for (const controller of controllers) {
      try { controller.abort(); } catch {}
    }
  }
}

async function dohSequential(query, cfg) {
  for (const endpoint of dohOrder(cfg)) {
    try {
      const response = await timeout(fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/dns-message", accept: "application/dns-message" },
        body: query,
      }), cfg.dnsTimeout, "DNS query timeout");
      if (!response.ok) throw new Error(`DoH returned ${response.status}`);
      preferredDoh = endpoint;
      return await response.arrayBuffer();
    } catch (err) {
      log(cfg, "doh_fail", { endpoint, message: message(err) });
    }
  }
  return null;
}

function dohOrder(cfg) {
  return preferredDoh && cfg.doh.includes(preferredDoh)
    ? [preferredDoh, ...cfg.doh.filter((endpoint) => endpoint !== preferredDoh)]
    : cfg.doh;
}

async function dnsTcp(query, cfg) {
  let lastError;
  for (const server of cfg.dnsTcp) {
    const target = hostPort(server, 53);
    try {
      const socket = connect({ hostname: target.host, port: target.port });
      if (socket.opened) await timeout(socket.opened, cfg.dnsTimeout, "DNS TCP connect timeout");
      const writer = socket.writable.getWriter();
      await writer.write(new Uint8Array([(query.byteLength >> 8) & 255, query.byteLength & 255]));
      await writer.write(query);
      writer.releaseLock();
      const answer = await timeout(readDnsTcp(socket), cfg.dnsTimeout, "DNS TCP read timeout");
      try { socket.close(); } catch {}
      return answer;
    } catch (err) {
      lastError = err;
      log(cfg, "dns_tcp_fail", { server, message: message(err) });
    }
  }
  throw lastError || new Error("DNS TCP fallback failed");
}

async function readDnsTcp(socket) {
  const reader = socket.readable.getReader();
  const chunks = [];
  let total = 0;
  let expected = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        chunks.push(value);
        total += value.byteLength;
      }
      const merged = concat(chunks, total);
      if (expected === null && merged.byteLength >= 2) expected = ((merged[0] << 8) | merged[1]) + 2;
      if (expected !== null && merged.byteLength >= expected) return merged.slice(2, expected).buffer;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("DNS TCP response ended early");
}

function cacheGet(key) {
  const item = dnsCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    dnsCache.delete(key);
    return null;
  }
  return item.value.slice(0);
}

function cachePut(key, value, cfg) {
  if (cfg.dnsCacheTtl <= 0) return;
  if (dnsCache.size >= DNS_CACHE_LIMIT) dnsCache.delete(dnsCache.keys().next().value);
  dnsCache.set(key, { expires: Date.now() + cfg.dnsCacheTtl * 1000, value: value.slice(0) });
}

function dnsError(query) {
  const q = query instanceof Uint8Array ? query : new Uint8Array(query || []);
  const response = new Uint8Array(12);
  response[0] = q[0] || 0;
  response[1] = q[1] || 0;
  response[2] = 0x81;
  response[3] = 0x82;
  return response.buffer;
}
