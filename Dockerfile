FROM node:26-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# npm is needed only to install dependencies, not to run this image.
RUN apk upgrade --no-cache zlib \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY src/ src/

# A container is reached from outside its own loopback, so it listens on all interfaces; the server then
# refuses to start without MCP_AUTH_TOKENS or MCP_AUTH_TOKEN.
ENV HOST=0.0.0.0
ENV PORT=3001
EXPOSE ${PORT}

# Streamable HTTP MCP server by default; override to src/mcp.mjs for stdio mode
CMD ["node", "src/server.mjs"]
