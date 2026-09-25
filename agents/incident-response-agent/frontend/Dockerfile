# syntax=docker/dockerfile:1

# Operator UI: Next.js standalone server on port 3000.
#
#   docker build -t ira-frontend \
#     --build-arg NEXT_PUBLIC_API_URL= \
#     --build-arg CSP_OIDC_ORIGIN=https://login.example.com \
#     frontend/
#
# NEXT_PUBLIC_API_URL: API base URL, inlined into the browser bundle and the
#   CSP at build time. Empty = same origin (the ingress routes /v1 to the API).
# CSP_OIDC_ORIGIN (optional): IdP origin(s) allowed in CSP connect-src. When
#   unset, connect-src allows any https: origin so the runtime-configured
#   issuer works.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- deps
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG CSP_OIDC_ORIGIN=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    CSP_OIDC_ORIGIN=${CSP_OIDC_ORIGIN} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

USER 1001:1001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
