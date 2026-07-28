# syntax=docker/dockerfile:1
FROM node:24-alpine AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS frontend-build
COPY index.html tsconfig.json vite.config.ts ./
COPY src/frontend ./src/frontend
RUN pnpm exec vp build

FROM node:24-alpine AS app
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-prod,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile
COPY src/server ./src/server
COPY database ./database
USER node
EXPOSE 3000
CMD ["node", "src/server/index.ts"]

FROM nginx:1.29-alpine AS nginx
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
EXPOSE 8080
