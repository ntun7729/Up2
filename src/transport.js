import { connect } from "cloudflare:sockets";
import { WS_OPEN } from "./constants.js";
import { dnsUdpWriter } from "./dns.js";
import { connectViaHttpProxy } from "./httpProxy.js";
import { resolveHostIps } from "./resolve.js";
import { connectViaSocks5 } from "./socks5.js";
import { parseVless } from "./vless.js";
import { closeWs, concat, hostPort, log, message, timeout } from "./utils.js";

const unavailableUntil = new Map();
const MIN_VLESS_HEADER = 24;

export async function handleWebSocket(request, cfg) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const input = webSocketReadable(server, request.headers.get("sec-websocket-protocol") || "", cfg);
  const remote = { socket: null, target: null, closed: false };
  let writeUdp = null;
  let pendingHeader = null;
  let label = "";

  input.pipeTo(new WritableStream({
    async write(chunk) {
      if (writeUdp) return writeUdp(chunk);

      if (remote.socket) {
        const data = toBytes(chunk);
        if (!data.byteLength) return;
        if (remote.closed) {
          log(cfg, "late_client_write_ignored", { ...(remote.target || {}), bytes: data.byteLength });
          closeWs(server);
          return;
        }
        let writer;
        try {
          writer = remote.socket.writable.getWriter();
          await writer.write(data);
        } catch (err) {
          if (isClosedWriteError(err)) {
            log(cfg, "late_client_write_ignored", { ...(remote.target || {}), bytes: data.byteLength, message: message(err) });
            closeWs(server);
            return;
          }
          log(cfg, "remote_write_error", { ...(remote.target || {}), bytes: data.byteLength, message: message(err) });
          throw err;
        } finally {
          try { writer?.releaseLock(); } catch {}
        }
        return;
      }

      let data = toBytes(chunk);
      if (!data.byteLength) {
        log(cfg, "empty_ws_frame_ignored");
        return;
      }

      if (pendingHeader) {
        data = concat([pendingHeader, data], pendingHeader.byteLength + data.byteLength);
        pendingHeader = null;
      }

      if (data.byteLength < MIN_VLESS_HEADER) {
        pendingHeader = data;
        log(cfg, "vless_wait_header", { bytes: data.byteLength });
        return;
      }

      const parsed = parseVless(data, cfg.uuid);
      if (parsed.error) throw new Error(parsed.message);
      label = `${parsed.host}:${parsed.port}/${parsed.udp ? "udp" : "tcp"}`;

      const replyHeader = new Uint8Array([parsed.version[0], 0]);
      const firstPayload = data.slice(parsed.offset);

      if (parsed.udp) {
        if (parsed.port !== 53) throw new Error("UDP is only supported for DNS on port 53");
        writeUdp = dnsUdpWriter(server, replyHeader, cfg);
        return writeUdp(firstPayload);
      }

      return openRemote(remote, parsed.host, parsed.port, firstPayload, server, replyHeader, cfg);
    },
    close() {
      closeWs(server);
    },
    abort(reason) {
      log(cfg, "ws_abort", { label, reason: String(reason) });
      closeWs(server);
    },
  })).catch((err) => {
    log(cfg, "ws_error", { label, message: message(err) });
    closeWs(server);
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function openRemote(remote, host, port, firstPayload, webSocket, replyHeader, cfg) {
  let lastError;
  for (const target of await routeCandidates(host, port, cfg)) {
    const started = Date.now();
    try {
      const safeTarget = publicTarget(target);
      log(cfg, "tcp_try", safeTarget);
      let socket;
      if (target.kind === "socks5") {
        socket = await connectViaSocks5(cfg.socks5, host, port, firstPayload, cfg);
      } else if (target.kind === "http-proxy") {
        socket = await connectViaHttpProxy(cfg.httpProxy, host, port, firstPayload, cfg);
      } else {
        socket = connect({ hostname: target.host, port: target.port });
        if (socket.opened) await timeout(socket.opened, cfg.connectTimeout, "TCP connect timeout");
        const writer = socket.writable.getWriter();
        if (firstPayload?.byteLength) await writer.write(firstPayload);
        writer.releaseLock();
      }

      remote.socket = socket;
      remote.target = safeTarget;
      remote.closed = false;
      log(cfg, "tcp_connected", { ...safeTarget, latencyMs: Date.now() - started });

      socket.closed
        .then(() => log(cfg, "remote_socket_closed", safeTarget))
        .catch((err) => log(cfg, "remote_socket_closed", { ...safeTarget, message: message(err) }))
        .finally(() => {
          remote.closed = true;
          closeWs(webSocket);
        });
      pipeBack(socket, webSocket, replyHeader, cfg, safeTarget, remote);
      return;
    } catch (err) {
      lastError = err;
      const msg = message(err);
      if (cfg.proxyCooldown > 0 && shouldCooldown(target, msg)) {
        unavailableUntil.set(target.id, Date.now() + cfg.proxyCooldown);
        log(cfg, "tcp_cooldown", { ...publicTarget(target), cooldownMs: cfg.proxyCooldown, reason: cooldownReason(target) });
      }
      log(cfg, "tcp_fail", { ...publicTarget(target), latencyMs: Date.now() - started, message: msg });
      try { remote.socket?.close(); } catch {}
      remote.socket = null;
      remote.target = null;
      remote.closed = false;
    }
  }
  throw lastError || new Error("All connection attempts failed");
}

async function routeCandidates(host, port, cfg) {
  const direct = { kind: "direct", host, port, id: `d:${host}:${port}` };
  const relays = cfg.proxies.map((value) => {
    const target = hostPort(value, port);
    return { kind: "relay", host: target.host, port: target.port, id: `r:${target.host}:${target.port}` };
  }).filter((target) => target.host);
  const socks = cfg.socks5 ? [{ kind: "socks5", host: cfg.socks5.host, port: cfg.socks5.port, id: `s:${cfg.socks5.host}:${cfg.socks5.port}` }] : [];
  const httpProxies = cfg.httpProxy ? [{ kind: "http-proxy", host: cfg.httpProxy.host, port: cfg.httpProxy.port, id: `h:${cfg.httpProxy.host}:${cfg.httpProxy.port}` }] : [];

  const usableRelays = relays.filter((target) => !isUnavailable(target.id));
  const availableRelays = usableRelays.length ? usableRelays : relays;
  const usableSocks = socks.filter((target) => !isUnavailable(target.id));
  const availableSocks = usableSocks.length ? usableSocks : socks;
  const usableHttp = httpProxies.filter((target) => !isUnavailable(target.id));
  const availableHttp = usableHttp.length ? usableHttp : httpProxies;
  const fallbackCount = availableSocks.length + availableHttp.length + availableRelays.length;
  const directList = isUnavailable(direct.id) && fallbackCount ? [] : [direct];
  const ipDirectList = await ipCandidates(host, port, cfg, fallbackCount > 0);

  if (cfg.policy === "proxy-only") return [...availableSocks, ...availableHttp, ...availableRelays];
  if (cfg.policy === "proxy-first") return [...availableSocks, ...availableHttp, ...availableRelays, ...directList, ...ipDirectList];
  return [...directList, ...ipDirectList, ...availableSocks, ...availableHttp, ...availableRelays];
}

async function ipCandidates(host, port, cfg, hasFallback) {
  if (!hasFallback) return [];
  if (!isUnavailable(`d:${host}:${port}`)) return [];
  const ips = await resolveHostIps(host, cfg);
  const out = [];
  for (const ip of ips.slice(0, 4)) {
    const id = `ip:${ip}:${port}`;
    if (!isUnavailable(id)) out.push({ kind: "direct-ip", host: ip, port, id, originalHost: host });
  }
  if (out.length) log(cfg, "tcp_ip_candidates", { host, port, count: out.length });
  return out;
}

function shouldCooldown(target, msg) {
  if (target.kind === "relay" || target.kind === "socks5" || target.kind === "http-proxy") return true;
  const lower = String(msg || "").toLowerCase();
  return lower.includes("consider using fetch") || lower.includes("cannot connect to the specified address");
}

function cooldownReason(target) {
  if (target.kind === "direct" || target.kind === "direct-ip") return "direct-restricted";
  return `${target.kind}-failed`;
}

function publicTarget(target) {
  if (target.kind !== "socks5" && target.kind !== "http-proxy") return target;
  return { kind: target.kind, host: target.host, port: target.port, id: target.id };
}

function isUnavailable(id) {
  const until = unavailableUntil.get(id) || 0;
  if (!until) return false;
  if (Date.now() > until) {
    unavailableUntil.delete(id);
    return false;
  }
  return true;
}

function pipeBack(socket, webSocket, replyHeader, cfg, target = {}, remote = null) {
  let header = replyHeader;
  let downstreamBytes = 0;
  socket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const data = toBytes(chunk);
      downstreamBytes += data.byteLength;
      if (webSocket.readyState !== WS_OPEN) throw new Error("WebSocket is not open");
      if (header) {
        webSocket.send(await new Blob([header, data]).arrayBuffer());
        header = null;
      } else {
        webSocket.send(data);
      }
    },
  })).catch((err) => {
    log(cfg, "pipe_error", { ...target, downstreamBytes, message: message(err) });
    closeWs(webSocket);
  }).finally(() => {
    if (remote) remote.closed = true;
    log(cfg, "pipe_done", { ...target, downstreamBytes });
    closeWs(webSocket);
  });
}

function isClosedWriteError(err) {
  const msg = message(err).toLowerCase();
  return msg.includes("writablestream has been closed") || msg.includes("stream has been closed") || msg.includes("socket closed");
}

function webSocketReadable(webSocket, earlyHeader, cfg) {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", async (event) => {
        if (cancelled) return;
        try {
          controller.enqueue(await eventDataToBytes(event.data));
        } catch (err) {
          controller.error(err);
        }
      });
      webSocket.addEventListener("close", () => {
        closeWs(webSocket);
        if (!cancelled) controller.close();
      });
      webSocket.addEventListener("error", (event) => controller.error(event));

      const early = decodeEarlyData(earlyHeader, cfg);
      if (early) controller.enqueue(early);
    },
    cancel(reason) {
      cancelled = true;
      log(cfg, "read_cancel", { reason: String(reason) });
      closeWs(webSocket);
    },
  });
}

async function eventDataToBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(0);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
}

function decodeEarlyData(value, cfg) {
  if (!value) return null;
  try {
    const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "===".slice((normalized.length + 3) % 4);
    const binary = atob(padded);
    const data = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    if (data.byteLength < MIN_VLESS_HEADER) {
      log(cfg, "early_data_ignored", { bytes: data.byteLength });
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
