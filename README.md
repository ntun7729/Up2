# Up2 VLESS Worker

A clean Cloudflare Worker implementation for VLESS over WebSocket with TLS termination at Cloudflare. This repo replaces the old two-file obfuscated layout with one readable Worker entrypoint and a small helper module.

## What is included

- VLESS TCP over WebSocket
- UDP/53 DNS handling through DNS-over-HTTPS
- DNS-over-TCP fallback
- Direct, proxy-first, proxy-only, and direct-first outbound policies
- Proxy cooldown after failed connection attempts
- `/health`, `/status`, and subscription routes
- Query-customizable subscription generation
- Node unit tests for the parser and subscription helpers

## Required setup

Install dependencies:

```bash
npm install
```

Set your UUID as a Cloudflare secret. Do not commit your UUID into the repository.

```bash
wrangler secret put UUID
```

Deploy:

```bash
npm run deploy
```

Run locally:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

## Routes

- `/health` returns a small health JSON response.
- `/status` returns runtime configuration without exposing the UUID.
- `/` returns a small status page.
- `/<UUID>/sub` returns a base64 VLESS subscription.
- `/sub/<UUID>` is also supported.

## Subscription options

You can customize generated subscription links with query parameters:

| Parameter | Purpose | Example |
| --- | --- | --- |
| `host` | WebSocket host/SNI default base | `host=example.com` |
| `sni` | TLS SNI | `sni=example.com` |
| `fp` | Client fingerprint | `fp=chrome` |
| `alpn` | ALPN list, or `off` | `alpn=h3,h2,http/1.1` |
| `ips` / `ip` | Comma-separated outbound addresses in generated links | `ips=104.16.0.0,104.17.0.0` |
| `ports` / `port` | Comma-separated ports | `ports=443,8443` |
| `count` | Number of addresses to include, 1 to 30 | `count=10` |
| `name` | Subscription node name prefix | `name=Up2` |
| `ed` | Early data value inserted into the WS path | `ed=2048` |
| `wspath` | Explicit WebSocket path | `wspath=/UUID?ed=2048` |

Example:

```text
https://your-worker.example.workers.dev/<UUID>/sub?host=your-worker.example.workers.dev&fp=chrome&alpn=h3,h2,http/1.1&count=6&ports=443
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `UUID` | required | VLESS UUID. Use `wrangler secret put UUID`. |
| `PROXY_HOSTS` | empty | Comma-separated proxy fallback hosts, optionally with ports. |
| `PROXY_POLICY` | `direct-first` | `direct-first`, `proxy-first`, or `proxy-only`. |
| `PROXY_FAIL_COOLDOWN_MS` | `120000` | How long to skip a failed proxy candidate. |
| `CONNECT_TIMEOUT_MS` | `6000` | TCP connection timeout. |
| `DOH_ENDPOINTS` | Cloudflare, Google, Quad9 | Comma-separated DoH endpoints. |
| `DOH_STRATEGY` | `race` | `race` or `sequential`. |
| `DNS_TIMEOUT_MS` | `5000` | DNS timeout. |
| `DNS_CACHE_TTL_SECONDS` | `60` | DNS cache TTL. Set `0` to disable. |
| `DNS_TCP_FALLBACK` | `true` | Enable DNS-over-TCP fallback. |
| `DNS_TCP_SERVERS` | `1.1.1.1:53,8.8.8.8:53,9.9.9.9:53` | TCP DNS fallback servers. |
| `ENABLE_LOGS` | `false` | Emit JSON logs to Cloudflare logs. |

## Client notes

Use VLESS with WebSocket transport and TLS. The Worker only supports UDP for DNS on port 53. Other UDP targets are rejected intentionally.
