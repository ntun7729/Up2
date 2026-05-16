export const VERSION = "up2-vless-worker-adaptive-ip-2026-05-16";

export const CF_IPS = [
  "104.16.0.0",
  "104.17.0.0",
  "104.18.0.0",
  "104.19.0.0",
  "104.20.0.0",
  "104.21.0.0",
  "172.64.0.0",
  "172.65.0.0",
  "172.66.0.0",
  "172.67.0.0",
];

export const DEFAULT_DOH = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/dns-query",
  "https://dns.quad9.net/dns-query",
];

export const DEFAULT_DNS_TCP = ["1.1.1.1:53", "8.8.8.8:53", "9.9.9.9:53"];

export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const DNS_CACHE_LIMIT = 256;
