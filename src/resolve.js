const ipCache = new Map();
const CACHE_TTL_MS = 120000;

export async function resolveHostIps(host, cfg) {
  if (!host || isIpLiteral(host)) return [];

  const key = host.toLowerCase();
  const cached = ipCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.ips.slice();

  const ips = [];
  for (const type of ["A", "AAAA"]) {
    try {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
      const res = await fetch(url, { headers: { accept: "application/dns-json" } });
      if (!res.ok) continue;
      const body = await res.json();
      for (const ans of body.Answer || []) {
        if (ans && typeof ans.data === "string" && isIpLiteral(ans.data)) ips.push(ans.data);
      }
    } catch {
      // Ignore resolver failures. The caller will continue to proxy fallback.
    }
  }

  const unique = [...new Set(ips)];
  ipCache.set(key, { expires: Date.now() + CACHE_TTL_MS, ips: unique });
  return unique;
}

function isIpLiteral(value) {
  const host = String(value || "").trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  return /^[0-9a-f:]+$/i.test(host) && host.includes(":");
}
