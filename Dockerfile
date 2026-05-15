# ──────────────────────────────────────────────────────────────────────────
# MKS Kanban — single image. Backend serves the built React app at /,
# JSON API at /api/v1/*, and WebSocket at /socket.io/*. One container.
# ──────────────────────────────────────────────────────────────────────────

# Stage 1 — frontend build
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2 — backend build
FROM node:20-alpine AS backend
WORKDIR /app/backend
# better-sqlite3 needs build toolchain at install time even in postgres mode
# (the dep is unconditional). Strip it from the final image.
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Stage 3 — runtime
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++ && \
    addgroup -S app && adduser -S -G app app
COPY backend/package*.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=backend  /app/backend/dist  ./dist
COPY --from=frontend /app/frontend/dist ./public
USER app
ENV NODE_ENV=production \
    PORT=3100 \
    DB_DRIVER=postgres \
    FRONTEND_DIST=/app/public
EXPOSE 3100
CMD ["node", "dist/main"]
