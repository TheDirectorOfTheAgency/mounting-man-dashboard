# Installation-post remote MCP adapter

Private, production-disabled transport adapter for THE-144. It exposes the exact eight installation-post tools over stateless Streamable HTTP and forwards them to the existing dashboard queue through an HMAC-authenticated internal request.

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

The plugin manifest intentionally uses a reserved `.invalid` URL until a private endpoint, OAuth client/resource metadata, workspace entitlement, and admin publication are approved. Do not replace that URL, deploy, install, or enable production publishing as part of the local pilot.

## Production-disabled tunnel shadow

`synthetic-shadow.mjs` is a stdio-only canary for a private Secure MCP Tunnel.
It reuses the production tool definitions, contains only synthetic records, and
hard-blocks publish and retry effects. It refuses to start unless
`INSTALL_POST_MCP_SYNTHETIC_ONLY=1` is set. This launcher is for developer-mode
transport, tool-discovery, and file-envelope proof only; it does not fetch or
validate attached file bytes and is not the authenticated production adapter.
