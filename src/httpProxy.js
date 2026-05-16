import { connect } from "cloudflare:sockets";
import { timeout } from "./utils.js";

export function parseHttpProxy(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      host,
      port,
      tls: url.protocol === "https:",
      username: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
    };
  } catch {
    return null;
  }
}

export async function connectViaHttpProxy(proxy, targetHost, targetPort, firstPayload, cfg) {
  if (!proxy?.host || !proxy?.port) throw new Error("HTTP proxy is not configured");
  if (proxy.tls) throw new Error("HTTPS proxy upstream is configured but TLS-to-proxy is not supported yet; use http://host:port or SOCKS5");

  const socket = connect({ hostname: proxy.host, port: proxy.port });
  if (socket.opened) await timeout(socket.opened, cfg.connectTimeout, "HTTP proxy connect timeout");

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  try {
    const target = `${targetHost}:${targetPort}`;
    const headers = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      "Proxy-Connection: keep-alive",
    ];
    if (proxy.username || proxy.password) {
      const token = btoa(`${proxy.username || ""}:${proxy.password || ""}`);
      headers.push(`Proxy-Authorization: Basic ${token}`);
    }
    headers.push("", "");

    await writer.write(new TextEncoder().encode(headers.join("\r\n")));

    const response = await readHttpHeaders(reader, cfg.connectTimeout);
    const text = new TextDecoder().decode(response);
    const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(text)?.[1];
    if (status !== "200") throw new Error(`HTTP proxy CONNECT failed with status ${status || "unknown"}`);

    if (firstPayload?.byteLength) await writer.write(firstPayload);
    return socket;
  } catch (err) {
    try { socket.close(); } catch {}
    throw err;
  } finally {
    try { reader.releaseLock(); } catch {}
    try { writer.releaseLock(); } catch {}
  }
}

async function readHttpHeaders(reader, ms) {
  let out = new Uint8Array(0);
  while (out.byteLength < 16384) {
    const result = await timeout(reader.read(), ms, "HTTP proxy reply timeout");
    if (result.done) throw new Error("HTTP proxy closed before CONNECT response");
    const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value || 0);
    if (!chunk.byteLength) continue;
    const merged = new Uint8Array(out.byteLength + chunk.byteLength);
    merged.set(out, 0);
    merged.set(chunk, out.byteLength);
    out = merged;
    if (hasHeaderEnd(out)) return out;
  }
  throw new Error("HTTP proxy response headers too large");
}

function hasHeaderEnd(bytes) {
  for (let i = 3; i < bytes.byteLength; i++) {
    if (bytes[i - 3] === 13 && bytes[i - 2] === 10 && bytes[i - 1] === 13 && bytes[i] === 10) return true;
  }
  return false;
}
