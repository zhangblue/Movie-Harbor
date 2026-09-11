FROM node:24-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend ./frontend
RUN npm ci --ignore-scripts && npm run build --workspace @movie-harbor/admin-web

FROM caddy:2.10-alpine
COPY frontend/admin-web/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /src/frontend/admin-web/dist /srv/admin
EXPOSE 80
