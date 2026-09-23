# =============================================================
# Akuntakita F&B Control — Backend API (Express + MariaDB + Cloudflare R2)
# Base directory di Coolify: /backend  |  Build pack: Dockerfile  |  Port: 3000
# Backend TIDAK perlu domain publik: frontend (Nginx) memproksi /api ke container ini
# lewat nama/alias jaringan internal Coolify (lihat README-COOLIFY.md).
# =============================================================
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DRIVER=r2 \
    UPLOAD_DIR=/app/data/uploads

WORKDIR /app

# tsx (runtime TypeScript) ada di dependencies, jadi cukup production install.
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile --production=true || yarn install --production=true

COPY . .
RUN mkdir -p /app/data/uploads && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1

# Saat start: migrasi skema MariaDB (idempoten) -> bootstrap admin -> verifikasi bucket R2 -> listen.
CMD ["yarn", "start"]
