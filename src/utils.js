import { WS_CLOSING, WS_OPEN } from "./constants.js";

export function val(url, key) {
  return (url.searchParams.get(key) || "").trim();
}

export function first(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

export function csv(value, fallback = []) {
  const parsed = String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
  return parsed.length ? parsed : [...fallback];
}

export function int(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function bool(value, fallback) {
  if (value === "" || value === undefined || value === null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

export function uuidNorm(value) {
  const s = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : "";
}

export function policyNorm(value, fallback) {
  const s = String(value || "").trim().toLowerCase();
  return ["direct-first", "proxy-first", "proxy-only"].includes(s) ? s : fallback;
}

export function dohStrategyNorm(value, fallback) {
  const s = String(value || "").trim().toLowerCase();
  return ["race", "sequential"].includes(s) ? s : fallback;
}

export function portNum(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

export function hostPort(value, fallbackPort) {
  const s = String(value || "").trim();
  if (!s) return { host: "", port: fallbackPort };

  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 0) {
      return {
        host: s.slice(1, end),
        port: s[end + 1] === ":" ? portNum(s.slice(end + 2), fallbackPort) : fallbackPort,
      };
    }
  }

  const i = s.lastIndexOf(":");
  if (i > 0 && !s.slice(0, i).includes(":")) {
    const p = portNum(s.slice(i + 1), null);
    if (p) return { host: s.slice(0, i), port: p };
  }
  return { host: s, port: fallbackPort };
}

export function bytesToUuid(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function normPath(path) {
  let p = path || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

export function closeWs(ws) {
  try {
    if (ws.readyState === WS_OPEN || ws.readyState === WS_CLOSING) ws.close(1000, "closed");
  } catch {}
}

export function timeout(promise, ms, message) {
  let timer;
  const timerPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timerPromise]).finally(() => clearTimeout(timer));
}

export function txt(body, status = 200, headers = {}, head = false) {
  return new Response(head ? null : body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function json(body, status = 200, head = false) {
  return new Response(head ? null : JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function html(body, status = 200, head = false) {
  return new Response(head ? null : body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function message(err) {
  return err?.message || String(err);
}

export function log(cfg, event, data = {}) {
  if (!cfg?.logs) return;
  try {
    console.log(JSON.stringify({ event, ...data, time: new Date().toISOString() }));
  } catch {}
}
