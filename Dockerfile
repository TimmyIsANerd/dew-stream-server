# Build stage for mediasoup native compilation
FROM node:20-slim AS builder

# Install build dependencies for mediasoup
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

# Production stage
FROM node:20-slim

# Install runtime dependencies for mediasoup
RUN apt-get update && apt-get install -y \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from builder (includes compiled mediasoup)
COPY --from=builder /app/node_modules ./node_modules

COPY package.json ./
COPY src ./src
COPY .env.example ./.env.example

ENV NODE_ENV=production

# HTTP/WebSocket port
EXPOSE 8787

# UDP ports for mediasoup RTP (media traffic)
EXPOSE 10000-10100/udp
EXPOSE 10000-10100/tcp

CMD ["node", "src/index.js"]
