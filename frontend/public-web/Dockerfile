# 构建阶段安装锁定依赖并生成公开站静态资源，供后续运行镜像复制。
FROM node:24-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend ./frontend
RUN npm ci --ignore-scripts && npm run build --workspace @movie-harbor/public-web

# 运行阶段只携带公开站构建产物及路由配置，由 Caddy 提供静态页面。
FROM caddy:2.10-alpine
COPY frontend/public-web/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /src/frontend/public-web/dist /srv
EXPOSE 80
