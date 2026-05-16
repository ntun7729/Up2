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
        if (ans && typeof ans.data === "string" && isIpLiteral(ans.data) && !isLikelyCloudflareIp(ans.data)) {
          ips.push(ans.data);
        }
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

function isLikelyCloudflareIp(value) {
  const ip = String(value || "").trim().toLowerCase();
  if (ip.startsWith("2606:4700:") || ip.startsWith("2803:f800:") || ip.startsWith("2400:cb00:") || ip.startsWith("2405:8100:") || ip.startsWith("2a06:98c0:") || ip.startsWith("2c0f:f248:")) return true;

  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;

  if (a === 104 && b >= 16 && b <= 31) return true;
  if (a === 172 && b >= 64 && b <= 71) return true;
  if (a === 188 && b === 114) return true;
  if (a === 190 && b === 93) return true;
  if (a === 197 && b === 234) return true;
  if (a === 198 && (b === 41 || b === 51)) return true;
  if (a === 162 && b === 158) return true;
  if (a === 131 && b === 0) return true;
  if (a === 108 && b === 162) return true;
  return false;
}
