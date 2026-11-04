# ==========================================
# XRouter Go Core - Multi-Stage Containerfile
# Ultra-lightweight, Zero-CGO, Pure Go
# Memory footprint: ~20-40 MB | Startup: <50ms
# ==========================================

FROM golang:1.26-alpine AS builder

WORKDIR /build

# Install git and ca-certificates for fetching modules
RUN apk add --no-cache git ca-certificates tzdata

COPY go.mod go.sum* ./
RUN go mod download

COPY . .

# Compile static binary (CGO_ENABLED=0)
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /build/xrouter ./cmd/xrouter

# Runtime Stage
FROM alpine:3.21 AS runner

RUN apk add --no-cache ca-certificates tzdata curl && \
    mkdir -p /app/data && \
    addgroup -S xrouter && adduser -S xrouter -G xrouter && \
    chown -R xrouter:xrouter /app

WORKDIR /app

COPY --from=builder /build/xrouter /app/xrouter

USER xrouter

ENV PORT=20128
ENV DATA_DIR=/app/data
ENV GOMEMLIMIT=128MiB

EXPOSE 20128

ENTRYPOINT ["/app/xrouter"]
