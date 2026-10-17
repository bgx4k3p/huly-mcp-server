FROM node:26-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# npm is needed only to install dependencies, not to run this image.
RUN apk upgrade --no-cache zlib \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY src/ src/

ENV PORT=3001
EXPOSE ${PORT}

# Streamable HTTP MCP server by default; override to src/mcp.mjs for stdio mode
CMD ["node", "src/server.mjs"]
