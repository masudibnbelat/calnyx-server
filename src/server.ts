// CalNyx relay (2026-11-21, TypeScript) — MAIN, thin by design.
// This file only wires things up: HTTP server + viewer page +
// WebSocket server + dispatcher. The real code lives elsewhere:
//   src/common.ts        — shared types, room map, small helpers
//   src/screen-stream.ts — Screen Stream rooms (the code)
//   src/camera.ts        — Camera Live 1-to-1 rooms (the code)
//   src/viewer-page.ts   — the browser watch page (HTML/JS)
// Build: npm install && npm run build (outputs dist/server.js)
// Run:   node dist/server.js (Render sets PORT itself)
// Free-tier note: Render sleeps after ~15 min idle, so the first
// connection after a sleep takes ~30-60 s to wake.

import http from "http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { VIEWER_HTML } from "./viewer-page.js";
import { rooms, meta, sendJson } from "./common.js";
import type { ClientMessage } from "./common.js";
import { createScreenHandlers } from "./screen-stream.js";
import { createCameraHandlers } from "./camera.js";

const PORT = Number(process.env.PORT) || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  // Viewer page: / , /?room=ABC123 , /watch/ABC123
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(VIEWER_HTML);
});

const screenHandlers = createScreenHandlers();
const cameraHandlers = createCameraHandlers();

const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws: WebSocket) => {
  meta.set(ws, { role: null, room: null, mode: null });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    const m = meta.get(ws);
    // Binary = a JPEG frame. Screen frames go to the screen
    // module, camera frames to the camera module.
    if (isBinary) {
      if (m?.mode === "camera") cameraHandlers.onBinary(ws, data);
      else screenHandlers.onBinary(ws, data);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch (_) {
      return;
    }
    // A JSON null / number / string has no .type — ignore it
    // instead of throwing (the live server would have crashed
    // on JSON "null" here).
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "create") {
      if (msg.mode === "camera") cameraHandlers.onMessage(ws, msg);
      else screenHandlers.onMessage(ws, msg);
      return;
    }
    if (msg.type === "join") {
      // The room's mode decides which module answers.
      const code =
        typeof msg.room === "string" ? msg.room.trim().toUpperCase() : "";
      const room = rooms.get(code);
      if (!room) {
        sendJson(ws, { type: "error", message: "Room not found. Check the code." });
        return;
      }
      if (room.mode === "camera") cameraHandlers.onMessage(ws, msg);
      else screenHandlers.onMessage(ws, msg);
      return;
    }
    if (msg.type === "join-publish") {
      // Camera only: the viewer joins as a publisher.
      const code =
        typeof msg.room === "string" ? msg.room.trim().toUpperCase() : "";
      const room = rooms.get(code);
      if (!room) {
        sendJson(ws, { type: "error", message: "Room not found. Check the code." });
        return;
      }
      if (room.mode !== "camera") {
        sendJson(ws, { type: "error", message: "Room is a screen stream, not Camera Live." });
        return;
      }
      cameraHandlers.onMessage(ws, msg);
      return;
    }
    // Unknown types ignored.
  });

  ws.on("close", () => {
    const m = meta.get(ws);
    if (!m || !m.room) return;
    if (m.mode === "camera") cameraHandlers.onClose(ws);
    else screenHandlers.onClose(ws);
  });

  ws.on("error", () => {
    // Ignore - close follows.
  });
});

server.listen(PORT, () => {
  console.log("CalNyx Screen Stream relay listening on " + PORT);
});
