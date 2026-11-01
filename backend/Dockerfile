# syntax=docker/dockerfile:1

# ---- build: kompilasi TypeScript (devDependencies hanya ada di stage ini) ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

# ---- runtime: dependency produksi + hasil kompilasi, tanpa tool dev ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production     PORT=3000

COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile && yarn cache clean

COPY --from=build /app/dist ./dist
# dist/migrate.js membaca ../db/migrations relatif terhadap file hasil build.
COPY db ./db

RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5   CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1

CMD ["node", "dist/index.js"]
