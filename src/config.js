import { DEFAULT_DNS_TCP, DEFAULT_DOH } from "./constants.js";
import { parseHttpProxy } from "./httpProxy.js";
import { parseSocks5 } from "./socks5.js";
import { bool, clamp, csv, dohStrategyNorm, first, int, policyNorm, uuidNorm, val } from "./utils.js";

export function loadConfig(env = {}, url, request) {
  const uuid = uuidNorm(first(env.UUID, env.uuid, env.USER_ID, env.userID));
  const proxies = csv(first(
    val(url, "proxyip"),
    val(url, "proxy_ips"),
    val(url, "proxy"),
    env.PROXY_HOSTS,
    env.PROXY_IPS,
    env.PROXYIP,
    env.proxyip,
  ), []);

  const socks5 = parseSocks5(first(
    val(url, "socks5"),
    val(url, "socks"),
    env.SOCKS5,
    env.SOCKS5_PROXY,
    env.SOCKS_PROXY,
    env.socks5,
  ));

  const httpProxy = parseHttpProxy(first(
    val(url, "httpProxy"),
    val(url, "http_proxy"),
    val(url, "http"),
    env.HTTP_PROXY,
    env.HTTPS_PROXY,
    env.CONNECT_PROXY,
    env.httpProxy,
  ));

  let policy = policyNorm(
    first(val(url, "proxyPolicy"), val(url, "proxy_policy"), val(url, "policy"), env.PROXY_POLICY),
    "direct-first",
  );
  if (bool(first(env.DISABLE_DIRECT, env.disableDirect), false)) policy = "proxy-only";

  return {
    uuid,
    proxies,
    socks5,
    httpProxy,
    policy,
    proxyCooldown: clamp(int(first(env.PROXY_FAIL_COOLDOWN_MS, env.proxyFailCooldownMs), 120000), 0, 900000),
    connectTimeout: clamp(int(first(val(url, "timeout"), val(url, "connectTimeout"), env.CONNECT_TIMEOUT_MS), 6000), 1000, 30000),
    dnsTimeout: clamp(int(first(val(url, "dnsTimeout"), env.DNS_TIMEOUT_MS), 5000), 1000, 30000),
    doh: csv(first(val(url, "doh"), val(url, "dohs"), env.DOH_ENDPOINTS), DEFAULT_DOH),
    dohStrategy: dohStrategyNorm(first(val(url, "dohStrategy"), env.DOH_STRATEGY), "race"),
    dnsCacheTtl: clamp(int(first(val(url, "cache"), val(url, "dnsCache"), env.DNS_CACHE_TTL_SECONDS), 60), 0, 3600),
    dnsTcpFallback: bool(first(val(url, "dnsTcp"), env.DNS_TCP_FALLBACK), true),
    dnsTcp: csv(first(env.DNS_TCP_SERVERS), DEFAULT_DNS_TCP),
    logs: bool(first(env.ENABLE_LOGS), false),
    host: request.headers.get("Host") || url.host,
  };
}
