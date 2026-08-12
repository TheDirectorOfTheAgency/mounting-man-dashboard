FROM node:22.22.0-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY cloud/install-post-mcp/package.json cloud/install-post-mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY cloud/install-post-mcp/server.mjs cloud/install-post-mcp/backend-client.mjs ./

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
