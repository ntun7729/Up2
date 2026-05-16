# Up2 VLESS Worker

Up2 is a readable Cloudflare Worker for **VLESS over WebSocket**.

It is designed for this routing style:

```text
normal sites                  -> direct Worker TCP
Cloudflare/blocked TCP sites  -> SOCKS5 or HTTP CONNECT fallback
last-resort fallback          -> proxyip / relay host
```

The goal is not to send everything through a proxy. The goal is to keep normal traffic direct and only use fallback upstreams when Cloudflare Workers refuses `connect()` for some destinations.

---

## Features

- VLESS over WebSocket
- TLS handled by Cloudflare
- Base64 subscription route
- Direct outbound TCP using `cloudflare:sockets`
- Adaptive cooldown for blocked direct targets
- Optional SOCKS5 upstream fallback
- Optional HTTP CONNECT upstream fallback
- Optional proxyip / relay fallback
- UDP/53 DNS handling
- DNS-over-HTTPS and DNS-over-TCP fallback
- `/health`, `/status`, and `/diag/tcp` diagnostic routes
- Modular source layout under `src/`

---

## Files

```text
src/main.js          Worker entrypoint and HTTP routes
src/transport.js     VLESS WebSocket transport and routing
src/vless.js         VLESS request parser
src/subscription.js  Subscription generator
src/config.js        Environment and URL config loader
src/dns.js           UDP/53 DNS handling
src/socks5.js        SOCKS5 upstream connector
src/httpProxy.js     HTTP CONNECT upstream connector
src/resolve.js       Hostname-to-IP retry helper
src/diag.js          TCP diagnostic route
src/utils.js         Shared helpers
```

---

## 1. Install

```bash
cd ~/Up2
npm install
```

Use local Wrangler through `npx` or npm scripts. You do **not** need global Wrangler.

```bash
npx wrangler --version
```

If `wrangler` alone says `command not found`, use:

```bash
npx wrangler ...
```

or:

```bash
npm run deploy
```

---

## 2. Set UUID secret

Generate or choose your VLESS UUID, then store it as a Cloudflare secret:

```bash
npx wrangler secret put UUID
```

Do not put your real UUID directly into `wrangler.toml` or commit it to GitHub.

---

## 3. Basic deploy

This is the simplest deployment:

```bash
npm test
npm run deploy
```

The npm scripts use `src/main.js` directly:

```json
{
  "dev": "wrangler dev src/main.js",
  "deploy": "wrangler deploy src/main.js",
  "test": "node --check src/main.js"
}
```

---

## 4. Recommended deploy

Use this when you have a SOCKS5 fallback and a proxyip fallback:

```bash
npx wrangler deploy \
  --var ENABLE_LOGS:false \
  --var PROXY_POLICY:direct-first \
  --var SOCKS5:user:pass@socks.example.com:1080 \
  --var PROXY_HOSTS:pyip.ygkkk.dpdns.org \
  --var PROXY_FAIL_COOLDOWN_MS:120000
```

For testing, set logs on:

```bash
npx wrangler deploy \
  --var ENABLE_LOGS:true \
  --var PROXY_POLICY:direct-first \
  --var SOCKS5:user:pass@socks.example.com:1080 \
  --var PROXY_HOSTS:pyip.ygkkk.dpdns.org \
  --var PROXY_FAIL_COOLDOWN_MS:120000
```

Then watch logs:

```bash
npx wrangler tail
```

---

## 5. Recommended routing mode

Use:

```text
PROXY_POLICY=direct-first
```

This means:

```text
1. Try direct Worker TCP first.
2. If Cloudflare blocks that host, remember it for cooldown period.
3. Try direct IP retry when useful.
4. Try SOCKS5 fallback if configured.
5. Try HTTP CONNECT fallback if configured.
6. Try proxyip fallback if configured.
```

Avoid `proxy-only` for normal use. `proxy-only` sends everything through fallback and can break sites that work fine with direct mode.

---

## 6. Why fallback is needed

Cloudflare Workers direct TCP works for many destinations, for example GitHub, YouTube, and many normal HTTPS hosts.

But Workers can reject some HTTP/TLS destinations with an error like:

```text
proxy request failed, cannot connect to the specified address.
It looks like you might be trying to connect to a HTTP-based service - consider using fetch instead
```

For a VLESS tunnel we cannot replace raw TCP with `fetch()`, because VLESS needs a bidirectional TCP stream. So Up2 falls back to SOCKS5, HTTP CONNECT, or proxyip only for those restricted destinations.

This is also why SOCKS5 data usage can be very small. With `direct-first`, only blocked/restricted destinations use SOCKS5. Normal traffic stays direct.

---

## 7. Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `UUID` | required | VLESS UUID. Set with `npx wrangler secret put UUID`. |
| `PROXY_POLICY` | `direct-first` | `direct-first`, `proxy-first`, or `proxy-only`. |
| `PROXY_FAIL_COOLDOWN_MS` | `120000` | How long to remember failed direct/fallback targets. |
| `SOCKS5` | empty | Optional SOCKS5 fallback, for example `user:pass@host:1080` or `socks5://user:pass@host:1080`. |
| `SOCKS5_PROXY` | empty | Alternative name for `SOCKS5`. |
| `SOCKS_PROXY` | empty | Alternative name for `SOCKS5`. |
| `HTTP_PROXY` | empty | Optional plain HTTP CONNECT fallback, for example `http://user:pass@host:8080`. |
| `CONNECT_PROXY` | empty | Alternative name for HTTP CONNECT fallback. |
| `PROXY_HOSTS` | empty | Comma-separated proxyip / relay hosts. Example: `host1.example.com,host2.example.com:443`. |
| `PROXY_IPS` | empty | Alternative name for `PROXY_HOSTS`. |
| `PROXYIP` | empty | Alternative name for `PROXY_HOSTS`. |
| `CONNECT_TIMEOUT_MS` | `6000` | TCP connect timeout. |
| `ENABLE_LOGS` | `false` | Enable JSON logs for `wrangler tail`. |
| `DOH_ENDPOINTS` | Cloudflare, Google, Quad9 | Comma-separated DoH endpoints. |
| `DOH_STRATEGY` | `race` | `race` or `sequential`. |
| `DNS_TIMEOUT_MS` | `5000` | DNS timeout. |
| `DNS_CACHE_TTL_SECONDS` | `60` | DNS cache TTL. Use `0` to disable. |
| `DNS_TCP_FALLBACK` | `true` | Enable DNS-over-TCP fallback. |
| `DNS_TCP_SERVERS` | `1.1.1.1:53,8.8.8.8:53,9.9.9.9:53` | DNS-over-TCP fallback servers. |
| `DISABLE_DIRECT` | `false` | If true, forces `proxy-only`. Not recommended for normal use. |

### Notes about upstream formats

SOCKS5 examples:

```text
SOCKS5=sg.example.com:1080
SOCKS5=user:pass@sg.example.com:1080
SOCKS5=socks5://user:pass@sg.example.com:1080
```

HTTP CONNECT examples:

```text
HTTP_PROXY=http://proxy.example.com:8080
HTTP_PROXY=http://user:pass@proxy.example.com:8080
```

`HTTP_PROXY=https://...` is not supported yet. Use plain `http://...` for HTTP CONNECT upstreams.

---

## 8. Routes

| Route | Purpose |
| --- | --- |
| `/` | Plain status page with subscription hint. |
| `/health` | Small health JSON. |
| `/status` | Runtime config without exposing UUID or credentials. |
| `/diag/tcp?target=host:port` | Test Worker direct TCP to a target. |
| `/<UUID>/sub` | Base64 VLESS subscription. |
| `/sub/<UUID>` | Alternative subscription route. |

---

## 9. Generate subscription

Basic subscription:

```bash
curl "https://YOUR_DOMAIN/YOUR_UUID/sub" | base64 -d
```

No ALPN, early data off:

```bash
curl "https://YOUR_DOMAIN/YOUR_UUID/sub?alpn=off&ed=0" | base64 -d
```

With proxyip in the WebSocket path:

```bash
curl "https://YOUR_DOMAIN/YOUR_UUID/sub?alpn=off&ed=0&proxyip=pyip.ygkkk.dpdns.org&policy=direct-first" | base64 -d
```

With SOCKS5 in the WebSocket path:

```bash
curl "https://YOUR_DOMAIN/YOUR_UUID/sub?alpn=off&ed=0&socks5=user:pass@socks.example.com:1080&policy=direct-first" | base64 -d
```

With HTTP CONNECT in the WebSocket path:

```bash
curl "https://YOUR_DOMAIN/YOUR_UUID/sub?alpn=off&ed=0&httpProxy=http://user:pass@proxy.example.com:8080&policy=direct-first" | base64 -d
```

For most clients, start with:

```text
Network: WebSocket
TLS: on
Host: YOUR_DOMAIN
SNI: YOUR_DOMAIN
Path: /YOUR_UUID?ed=0
ALPN: empty/off or http/1.1
```

---

## 10. Subscription query parameters

| Parameter | Purpose | Example |
| --- | --- | --- |
| `host` | Host used in generated VLESS link. | `host=dn.clans.bond` |
| `sni` | TLS SNI. Defaults to host. | `sni=dn.clans.bond` |
| `fp` | TLS fingerprint. | `fp=chrome` |
| `alpn` | ALPN value. Use `off` to omit. | `alpn=off` |
| `ed` | Early data value in WebSocket path. | `ed=0` |
| `wspath` | Explicit WebSocket path. | `wspath=/UUID?ed=0` |
| `proxyip` | proxyip / relay host in WS path. | `proxyip=pyip.ygkkk.dpdns.org` |
| `policy` | Runtime policy in WS path. | `policy=direct-first` |
| `socks5` | SOCKS5 fallback in WS path. | `socks5=user:pass@host:1080` |
| `httpProxy` | HTTP CONNECT fallback in WS path. | `httpProxy=http://user:pass@host:8080` |
| `ips` / `ip` | Addresses generated as VLESS server address. | `ips=104.16.0.0,104.17.0.0` |
| `ports` / `port` | Ports generated in subscription. | `ports=443,8443` |
| `count` | Number of generated address entries. | `count=10` |
| `name` | Node name prefix. | `name=Up2` |

---

## 11. Diagnostics

Check status:

```bash
curl https://YOUR_DOMAIN/status
```

You want to see something like:

```json
{
  "ok": true,
  "uuidConfigured": true,
  "proxyPolicy": "direct-first",
  "socks5Configured": true,
  "httpProxyConfigured": false,
  "proxyFailCooldownMs": 120000
}
```

Test direct TCP from Worker:

```bash
curl "https://YOUR_DOMAIN/diag/tcp?target=www.google.com:443"
curl "https://YOUR_DOMAIN/diag/tcp?target=api.ip.sb:443"
```

`www.google.com:443` often works direct. Some Cloudflare-hosted HTTP/TLS targets may fail direct and require fallback.

Watch logs:

```bash
npx wrangler tail
```

Useful log events:

| Event | Meaning |
| --- | --- |
| `tcp_try` | Up2 is trying a route candidate. |
| `tcp_connected` | TCP/SOCKS/HTTP proxy connection succeeded. |
| `tcp_fail` | Candidate failed. |
| `tcp_cooldown` | Candidate is temporarily skipped after failure. |
| `tcp_ip_candidates` | Hostname resolved to direct-IP retry candidates. |
| `pipe_done` | Downstream pipe finished. Shows `downstreamBytes`. |
| `late_client_write_ignored` | Client sent a tiny packet after upstream closed; usually harmless. |
| `remote_socket_closed` | Upstream socket closed. |
| `pipe_error` | Error while sending upstream data back to client. |
| `ws_error` | WebSocket-level error. |

Example healthy fallback:

```text
tcp_try direct api.ip.sb:443
tcp_cooldown direct api.ip.sb:443
tcp_fail direct api.ip.sb:443
tcp_try socks5 sg.example.com:1080
tcp_connected socks5 sg.example.com:1080
pipe_done downstreamBytes=2173
```

---

## 12. Troubleshooting

### `wrangler: command not found`

Use `npx`:

```bash
npx wrangler deploy
npx wrangler tail
```

or npm scripts:

```bash
npm run deploy
```

### `git pull` fails because of local changes

Save local changes, pull, then redeploy:

```bash
git status
git stash push -m "local changes before pull"
git pull
npm test
npm run deploy
```

### Subscription has `path=%252F...`

That is double encoding and means you are running an old build. Pull and redeploy:

```bash
git pull
npm test
npm run deploy
```

Correct path looks like:

```text
path=%2FUUID%3Fed%3D0
```

Wrong old path looks like:

```text
path=%252FUUID%253Fed%253D0
```

### Client connects but no internet

Run:

```bash
npx wrangler tail
```

If you see:

```text
Invalid VLESS header
```

make sure you pulled the latest build.

If you see:

```text
proxy request failed ... consider using fetch instead
```

that target is blocked by Workers direct TCP. Use `direct-first` with SOCKS5, HTTP CONNECT, or proxyip fallback.

If you see:

```text
tcp_connected socks5 ...
pipe_done downstreamBytes > 0
```

fallback is working and data came back.

If you see:

```text
pipe_done downstreamBytes=0
```

the fallback connected but did not return data. Try a better SOCKS5/HTTP/proxyip host.

### Cloudflare-related websites do not open

This is expected with pure direct mode on some destinations. Use:

```bash
npx wrangler deploy \
  --var ENABLE_LOGS:false \
  --var PROXY_POLICY:direct-first \
  --var SOCKS5:user:pass@socks.example.com:1080 \
  --var PROXY_FAIL_COOLDOWN_MS:120000
```

### SOCKS5 traffic usage is tiny

That is normal with `direct-first`. Only restricted destinations use SOCKS5. Normal destinations stay direct.

---

## 13. Production recommendation

Stable normal setup:

```bash
npx wrangler deploy \
  --var ENABLE_LOGS:false \
  --var PROXY_POLICY:direct-first \
  --var SOCKS5:user:pass@socks.example.com:1080 \
  --var PROXY_HOSTS:pyip.ygkkk.dpdns.org \
  --var PROXY_FAIL_COOLDOWN_MS:120000
```

Debug setup:

```bash
npx wrangler deploy \
  --var ENABLE_LOGS:true \
  --var PROXY_POLICY:direct-first \
  --var SOCKS5:user:pass@socks.example.com:1080 \
  --var PROXY_HOSTS:pyip.ygkkk.dpdns.org \
  --var PROXY_FAIL_COOLDOWN_MS:120000

npx wrangler tail
```

Direct-only setup:

```bash
npx wrangler deploy \
  --var ENABLE_LOGS:false \
  --var PROXY_POLICY:direct-first \
  --var PROXY_FAIL_COOLDOWN_MS:120000
```

Use direct-only only if you accept that some Cloudflare-hosted / HTTP-like targets may fail.

---

## 14. Security notes

- Keep `UUID`, `SOCKS5`, and proxy credentials private.
- Prefer `wrangler secret put UUID` for UUID.
- Avoid putting credentials into subscription URLs unless you trust the client and storage location.
- Turn off logs in production because logs can reveal target hostnames.

---

## 15. Quick copy/paste

```bash
cd ~/Up2
git pull
npm install
npm test
npx wrangler secret put UUID
npx wrangler deploy \
  --var ENABLE_LOGS:false \
  --var PROXY_POLICY:direct-first \
  --var SOCKS5:user:pass@socks.example.com:1080 \
  --var PROXY_HOSTS:pyip.ygkkk.dpdns.org \
  --var PROXY_FAIL_COOLDOWN_MS:120000
curl https://YOUR_DOMAIN/status
curl "https://YOUR_DOMAIN/YOUR_UUID/sub?alpn=off&ed=0" | base64 -d
```
