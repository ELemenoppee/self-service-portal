FROM node:24-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 falls back to compiling its native addon with node-gyp
# when no prebuilt binary matches the Node ABI; that needs Python + a
# C++ toolchain, which the slim base image doesn't include.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json angular.json tsconfig.json tsconfig.app.json ./
COPY src ./src
RUN npm install && npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
