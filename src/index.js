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
console.log(`dew-streaming-service running on :${port}`);

const server = serve({ fetch: app.fetch, port });

// Initialize WebRTC signaling WebSocket
initializeStreamingWebSocketServer(server);
