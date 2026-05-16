import { connect } from "cloudflare:sockets";
import { hostPort, timeout } from "./utils.js";

export function parseSocks5(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `socks5://${raw}`;
    const url = new URL(text);
    if (!["socks5:", "socks:", "socks4:"].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 1080);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      host,
      port,
      username: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
    };
  } catch {
    const target = hostPort(raw, 1080);
    return target.host ? { host: target.host, port: target.port || 1080, username: "", password: "" } : null;
  }
}

export async function connectViaSocks5(socks, targetHost, targetPort, firstPayload, cfg) {
  if (!socks?.host || !socks?.port) throw new Error("SOCKS5 is not configured");

  const socket = connect({ hostname: socks.host, port: socks.port });
  if (socket.opened) await timeout(socket.opened, cfg.connectTimeout, "SOCKS5 connect timeout");

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  try {
    const hasAuth = Boolean(socks.username || socks.password);
    await writer.write(hasAuth ? new Uint8Array([0x05, 0x02, 0x00, 0x02]) : new Uint8Array([0x05, 0x01, 0x00]));

    const method = await readAtLeast(reader, 2, cfg.connectTimeout, "SOCKS5 method timeout");
    if (method[0] !== 0x05) throw new Error("Invalid SOCKS5 method response");
    if (method[1] === 0xff) throw new Error("SOCKS5 has no acceptable auth method");

    if (method[1] === 0x02) {
      const username = new TextEncoder().encode(socks.username || "");
      const password = new TextEncoder().encode(socks.password || "");
      if (username.byteLength > 255 || password.byteLength > 255) throw new Error("SOCKS5 credentials are too long");
      const auth = new Uint8Array(3 + username.byteLength + password.byteLength);
      auth[0] = 0x01;
      auth[1] = username.byteLength;
      auth.set(username, 2);
      auth[2 + username.byteLength] = password.byteLength;
      auth.set(password, 3 + username.byteLength);
      await writer.write(auth);

      const authReply = await readAtLeast(reader, 2, cfg.connectTimeout, "SOCKS5 auth timeout");
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) throw new Error("SOCKS5 authentication failed");
    } else if (method[1] !== 0x00) {
      throw new Error(`Unsupported SOCKS5 auth method ${method[1]}`);
    }

    const request = buildConnectRequest(targetHost, targetPort);
    await writer.write(request);

    const head = await readAtLeast(reader, 5, cfg.connectTimeout, "SOCKS5 reply timeout");
    if (head[0] !== 0x05) throw new Error("Invalid SOCKS5 connect response");
    if (head[1] !== 0x00) throw new Error(`SOCKS5 connect failed with code ${head[1]}`);

    const atyp = head[3];
    let rest = 0;
    if (atyp === 0x01) rest = 4 + 2;
    else if (atyp === 0x04) rest = 16 + 2;
    else if (atyp === 0x03) rest = head[4] + 2;
    else throw new Error("Invalid SOCKS5 reply address type");
    const already = head.byteLength - 4;
    if (rest > already) await readAtLeast(reader, rest - already, cfg.connectTimeout, "SOCKS5 reply address timeout");

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

function buildConnectRequest(host, port) {
  const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff]);
  const ipv4 = ipv4Bytes(host);
  if (ipv4) {
    const out = new Uint8Array(4 + 4 + 2);
    out.set([0x05, 0x01, 0x00, 0x01], 0);
    out.set(ipv4, 4);
    out.set(portBytes, 8);
    return out;
  }

  const encoded = new TextEncoder().encode(String(host || ""));
  if (!encoded.byteLength || encoded.byteLength > 255) throw new Error("Invalid target host for SOCKS5");
  const out = new Uint8Array(4 + 1 + encoded.byteLength + 2);
  out.set([0x05, 0x01, 0x00, 0x03, encoded.byteLength], 0);
  out.set(encoded, 5);
  out.set(portBytes, 5 + encoded.byteLength);
  return out;
}

function ipv4Bytes(host) {
  const parts = String(host || "").split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return new Uint8Array(nums);
}

async function readAtLeast(reader, size, ms, label) {
  let out = new Uint8Array(0);
  while (out.byteLength < size) {
    const result = await timeout(reader.read(), ms, label);
    if (result.done) throw new Error(`${label}: socket closed`);
    const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value || 0);
    if (!chunk.byteLength) continue;
    const merged = new Uint8Array(out.byteLength + chunk.byteLength);
    merged.set(out, 0);
    merged.set(chunk, out.byteLength);
    out = merged;
  }
  return out;
}
