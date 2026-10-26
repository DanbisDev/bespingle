FROM node:24-alpine AS frontend
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
COPY server/world.json server/scrimba.json ./server/
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY server ./server
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bespingle ./server

FROM scratch
WORKDIR /app
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=backend /out/bespingle /app/bespingle
COPY --from=frontend /app/dist /app/dist
COPY LICENSE /app/LICENSE
ENV HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/dist
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/bespingle"]
