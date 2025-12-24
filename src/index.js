import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import dotenv from "dotenv";
import { connectDB } from "./config/database.js";
import { errorHandler } from "./middleware/errorHandler.js";

import webhooksRoutes from "./routes/webhooks.js";
import streamStatusRoutes from "./routes/stream-status.js";
import streamsRoutes from "./routes/streams.js";
import { initializeStreamingWebSocketServer } from "./routes/streaming-ws.js";
import { initializeWorkers } from "./sfu/mediasoup-config.js";

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const app = new Hono();

// DB
connectDB();

// Middleware
app.use("*", logger());
app.use("*", cors({
  origin: [
    "http://localhost:3000", 
    "http://localhost:3001", 
    "https://dew.meme",
    "https://www.dew.meme",
    "https://stream.dew.meme"
  ],
  credentials: true,
}));

// Routes
app.route("/api/webhooks", webhooksRoutes);
app.route("/api/status", streamStatusRoutes);
app.route("/api/streams", streamsRoutes);

// Root
app.get("/", (c) => c.text("OK", 200));
app.get("/health", (c) => c.json({ status: "OK", ts: new Date().toISOString() }));

// Error handling
app.use("*", errorHandler);

const port = process.env.PORT || 8787;

async function start() {
  try {
    // Initialize mediasoup workers before starting server
    console.log('🎬 [Server] Initializing mediasoup SFU...');
    await initializeWorkers();
    console.log('🎬 [Server] mediasoup SFU initialized');

    // Start HTTP server
    const server = serve({ fetch: app.fetch, port });
    console.log(`🚀 dew-streaming-service running on :${port}`);

    // Initialize WebSocket signaling
    initializeStreamingWebSocketServer(server);
    console.log('🔌 [Server] WebSocket signaling server initialized');
  } catch (error) {
    console.error('❌ [Server] Failed to start:', error);
    process.exit(1);
  }
}

start();
