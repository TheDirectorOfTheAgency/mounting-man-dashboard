# Installation-post remote MCP adapter

Private transport adapter for THE-144. It exposes the exact eight installation-post tools over stateless Streamable HTTP and forwards them to the existing dashboard queue through an HMAC-authenticated internal request. The VPS live unit is a parallel copy and does not replace the M1/Codex or Discord routes.

## Required deployment configuration

- `INSTALL_POST_MCP_OAUTH_ISSUER`
- `INSTALL_POST_MCP_OAUTH_JWKS_URL`
- `INSTALL_POST_MCP_OAUTH_AUDIENCE`
- `INSTALL_POST_MCP_RESOURCE_URL`
- `INSTALL_POST_MCP_ALLOWED_HOST`
- `INSTALL_POST_MCP_BACKEND_URL`
- `INSTALL_POST_MCP_BACKEND_TOKEN`
- `PORT`

The service refuses to start when OAuth/resource configuration is incomplete. The dashboard backend separately requires the same internal token. Tool scopes are `installation-posts:read`, `installation-posts:write`, and `installation-posts:publish`.

The development plugin remains private and unlisted. The current Quick Tunnel is a temporary operator canary; production requires a stable HTTPS endpoint and OAuth.

## Production-disabled tunnel shadow

`synthetic-shadow.mjs` is a stdio-only canary for a private Secure MCP Tunnel.
It reuses the production tool definitions, contains only synthetic records, and
hard-blocks publish and retry effects. It refuses to start unless
`INSTALL_POST_MCP_SYNTHETIC_ONLY=1` is set. This launcher is for developer-mode
transport, tool-discovery, and file-envelope proof only; it does not fetch or
validate attached file bytes and is not the authenticated production adapter.

For an isolated always-on host canary, `synthetic-http-shadow.mjs` exposes the
same production-disabled tools on loopback only. It also requires
`INSTALL_POST_MCP_SYNTHETIC_ONLY=1` and refuses a non-loopback bind. This is a
compute/runtime proof for a VPS; it is not a public endpoint, OAuth deployment,
or production publishing service.

The hardened VPS unit template is
`systemd/mounting-man-install-post-shadow.service`. It runs as a dynamic user,
has no writable filesystem path, is memory-capped by the host, and listens only
on `127.0.0.1:3137`.

`systemd/mounting-man-install-post-cloudflare-shadow.service` is an optional,
ephemeral Cloudflare Quick Tunnel canary for that loopback service. It exposes
only the synthetic, production-disabled adapter and carries no Cloudflare
account credential. Its generated hostname can change after a restart, so it
is transport evidence only—not the stable OAuth endpoint or a production
cutover mechanism.
