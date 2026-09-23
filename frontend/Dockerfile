# =============================================================
# Akuntakita F&B Control — Frontend (React + Vite) di Nginx
# Base directory di Coolify: /frontend  |  Build pack: Dockerfile  |  Port: 80
# Env runtime: BACKEND_URL (contoh: http://backend-fnb:3000)
# =============================================================
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile || yarn install
COPY . .
# Frontend memanggil path relatif /api (diproksi Nginx ke backend) — tidak ada URL absolut yang di-bake.
ENV CI=true
RUN yarn typecheck && yarn build

FROM nginx:1.27-alpine AS runtime
ENV BACKEND_URL=http://backend:3000 \
    NGINX_PORT=80 \
    CLIENT_MAX_BODY_SIZE=20m
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/05-normalize-backend-url.envsh /docker-entrypoint.d/05-normalize-backend-url.envsh
COPY nginx/16-resolver-fallback.envsh /docker-entrypoint.d/16-resolver-fallback.envsh
RUN chmod +x /docker-entrypoint.d/05-normalize-backend-url.envsh /docker-entrypoint.d/16-resolver-fallback.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${NGINX_PORT}/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
