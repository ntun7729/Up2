import { connect } from "cloudflare:sockets";
import { WS_OPEN } from "./constants.js";
import { dnsUdpWriter } from "./dns.js";
import { parseVless } from "./vless.js";
import { closeWs, hostPort, log, message, timeout } from "./utils.js";

const unavailableUntil = new Map();

export async function handleWebSocket(request, cfg) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const input = webSocketReadable(server, request.headers.get("sec-websocket-protocol") || "", cfg);
  const remote = { socket: null };
  let writeUdp = null;
  let label = "";

  input.pipeTo(new WritableStream({
    async write(chunk) {
      if (writeUdp) return writeUdp(chunk);

      if (remote.socket) {
        const writer = remote.socket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const parsed = parseVless(chunk, cfg.uuid);
      if (parsed.error) throw new Error(parsed.message);
      label = `${parsed.host}:${parsed.port}/${parsed.udp ? "udp" : "tcp"}`;

      const replyHeader = new Uint8Array([parsed.version[0], 0]);
      const firstPayload = chunk.slice(parsed.offset);

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
  for (const target of routeCandidates(host, port, cfg)) {
    const started = Date.now();
    try {
      log(cfg, "tcp_try", target);
      const socket = connect({ hostname: target.host, port: target.port });
      if (socket.opened) await timeout(socket.opened, cfg.connectTimeout, "TCP connect timeout");
      remote.socket = socket;
      log(cfg, "tcp_connected", { ...target, latencyMs: Date.now() - started });

      const writer = socket.writable.getWriter();
      if (firstPayload?.byteLength) await writer.write(firstPayload);
      writer.releaseLock();

      socket.closed.catch(() => {}).finally(() => closeWs(webSocket));
      pipeBack(socket, webSocket, replyHeader, cfg);
      return;
    } catch (err) {
      lastError = err;
      if (target.kind === "relay" && cfg.proxyCooldown > 0) unavailableUntil.set(target.id, Date.now() + cfg.proxyCooldown);
      log(cfg, "tcp_fail", { ...target, latencyMs: Date.now() - started, message: message(err) });
      try { remote.socket?.close(); } catch {}
      remote.socket = null;
    }
  }
  throw lastError || new Error("All connection attempts failed");
}

function routeCandidates(host, port, cfg) {
  const direct = [{ kind: "direct", host, port, id: `d:${host}:${port}` }];
  const relays = cfg.proxies.map((value) => {
    const target = hostPort(value, port);
    return { kind: "relay", host: target.host, port: target.port, id: `r:${target.host}:${target.port}` };
  }).filter((target) => target.host);

  const usableRelays = relays.filter((target) => !isUnavailable(target.id));
  const availableRelays = usableRelays.length ? usableRelays : relays;

  if (cfg.policy === "proxy-only") return availableRelays;
  if (cfg.policy === "proxy-first") return [...availableRelays, ...direct];
  return [...direct, ...availableRelays];
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

function pipeBack(socket, webSocket, replyHeader, cfg) {
  let header = replyHeader;
  socket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (webSocket.readyState !== WS_OPEN) throw new Error("WebSocket is not open");
      if (header) {
        webSocket.send(await new Blob([header, chunk]).arrayBuffer());
        header = null;
      } else {
        webSocket.send(chunk);
      }
    },
  })).catch((err) => {
    log(cfg, "pipe_error", { message: message(err) });
    closeWs(webSocket);
  }).finally(() => closeWs(webSocket));
}

function webSocketReadable(webSocket, earlyHeader, cfg) {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", (event) => {
        if (cancelled) return;
        controller.enqueue(typeof event.data === "string" ? new TextEncoder().encode(event.data) : event.data);
      });
      webSocket.addEventListener("close", () => {
        closeWs(webSocket);
        if (!cancelled) controller.close();
      });
      webSocket.addEventListener("error", (event) => controller.error(event));

      const early = decodeEarlyData(earlyHeader);
      if (early) controller.enqueue(early);
    },
    cancel(reason) {
      cancelled = true;
      log(cfg, "read_cancel", { reason: String(reason) });
      closeWs(webSocket);
    },
  });
}

function decodeEarlyData(value) {
  if (!value) return null;
  try {
    const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "===".slice((normalized.length + 3) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0)).buffer;
  } catch {
    return null;
  }
}
