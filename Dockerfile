FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ src/

ENV PORT=3001
EXPOSE ${PORT}

# HTTP REST server by default; override to src/mcp.mjs for stdio mode
CMD ["node", "src/server.mjs"]
