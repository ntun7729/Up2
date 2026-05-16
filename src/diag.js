import { connect } from "cloudflare:sockets";
import { hostPort, timeout } from "./utils.js";

export async function checkTcpTarget(targetText, timeoutMs = 6000) {
  const target = hostPort(targetText || "cloudflare.com:443", 443);
  const started = Date.now();
  try {
    const socket = connect({ hostname: target.host, port: target.port });
    if (socket.opened) await timeout(socket.opened, timeoutMs, "TCP connect timeout");
    try { socket.close(); } catch {}
    return { ok: true, target: `${target.host}:${target.port}`, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, target: `${target.host}:${target.port}`, latencyMs: Date.now() - started, error: err?.message || String(err) };
  }
}
