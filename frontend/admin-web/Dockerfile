# 构建阶段安装锁定依赖并生成管理站静态资源，供后续运行镜像复制。
FROM node:24-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend ./frontend
RUN npm ci --ignore-scripts && npm run build --workspace @movie-harbor/admin-web

# 运行阶段只携带静态资源及路由回退配置，由 Caddy 提供管理站页面。
FROM caddy:2.10-alpine
COPY frontend/admin-web/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /src/frontend/admin-web/dist /srv/admin
EXPOSE 80
