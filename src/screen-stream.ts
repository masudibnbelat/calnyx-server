// CalNyx relay — Screen Stream rooms (2026-11-21).
// The real Screen Stream code lives HERE, not in server.ts:
//   Phone  -> {"type":"create","password":"..."}  (password: min 2 chars)
//   Server -> {"type":"created","room":"ABC123"}
//   Viewer -> {"type":"join","room":"ABC123","password":"..."}
//   Server -> {"type":"joined","room":"ABC123"}
//           | {"type":"error","message":"Wrong password" | "Room not found"}
//   Server -> {"type":"viewers","count":2}   (to the phone, on join/leave)
//   Server -> {"type":"ended"}               (to viewers, when phone stops)
//   Phone  -> binary JPEG frame               (forwarded to joined viewers)
//
// Behaviour is IDENTICAL to the Screen Stream part of the live
// server.ts the user pasted (2026-11-21, TypeScript). Nothing
// about the screen protocol changed. Shared state comes from
// common.ts; the dispatcher in server.ts only routes here:
// "create" without mode "camera", and "join" for rooms whose
// mode is "screen". The room lookups below are defensive — the
// dispatcher already looked the room up once.

// NOTE: WebSocket is a VALUE import (not `import type`) because
// the code reads WebSocket.OPEN below. It comes from the "ws"
// package only — never from server.ts — so there is no
// circular import.
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { rooms, meta, genCode, sendJson, notifyHost, endRoom } from "./common.js";
import type { ClientMessage } from "./common.js";

export interface ScreenHandlers {
    onMessage(ws: WebSocket, msg: ClientMessage): void;
    onBinary(ws: WebSocket, data: RawData): void;
    onClose(ws: WebSocket): void;
}

export function createScreenHandlers(): ScreenHandlers {
    function onMessage(ws: WebSocket, msg: ClientMessage): void {
        if (msg.type === "create") {
            // Phone starts a stream. Password is mandatory, min 2 chars.
            const pw = typeof msg.password === "string" ? msg.password : "";
            if (pw.length < 2) {
                sendJson(ws, {
                    type: "error",
                    message: "Password must be at least 2 characters.",
                });
                ws.close();
                return;
            }
            let code = genCode();
            while (rooms.has(code)) code = genCode();
            rooms.set(code, {
                mode: "screen",
                password: pw,
                broadcaster: ws,
                viewers: new Set(),
                publisher: null,
            });
            meta.set(ws, { role: "broadcaster", room: code, mode: "screen" });
            sendJson(ws, { type: "created", room: code });
            return;
        }

        if (msg.type === "join") {
            const code =
                typeof msg.room === "string" ? msg.room.trim().toUpperCase() : "";
            const room = rooms.get(code);
            if (!room) {
                sendJson(ws, { type: "error", message: "Room not found. Check the code." });
                return;
            }
            if (room.mode !== "screen") {
                // Defensive only - the dispatcher routes camera rooms to
                // camera.ts, so this should never happen. Answer as if
                // the room did not exist, rather than leaking its mode.
                sendJson(ws, { type: "error", message: "Room not found. Check the code." });
                return;
            }
            if (msg.password !== room.password) {
                sendJson(ws, { type: "error", message: "Wrong password." });
                return;
            }
            const m = meta.get(ws);
            if (m && m.room === code) {
                sendJson(ws, { type: "error", message: "Already connected to this room." });
                return;
            }
            meta.set(ws, { role: "viewer", room: code, mode: "screen" });
            room.viewers.add(ws);
            sendJson(ws, { type: "joined", room: code });
            notifyHost(room);
            return;
        }

        // Unknown types ignored.
    }

    function onBinary(ws: WebSocket, data: RawData): void {
        // Binary = a JPEG frame from the phone. Forward it to every
        // viewer of the same room, nothing else.
        const m = meta.get(ws);
        if (!m || m.role !== "broadcaster" || !m.room) return;
        const room = rooms.get(m.room);
        if (!room || room.mode !== "screen") return;
        room.viewers.forEach((v) => {
            try {
                if (v.readyState === WebSocket.OPEN) v.send(data);
            } catch (_) {
                // Dead viewer - cleaned up on its close event.
            }
        });
    }

    function onClose(ws: WebSocket): void {
        const m = meta.get(ws);
        if (!m || !m.room) return;
        const room = rooms.get(m.room);
        if (!room) return;
        if (m.role === "broadcaster") {
            // Phone stopped: the room is gone, viewers see "ended".
            endRoom(m.room, "Stream ended.");
        } else if (m.role === "viewer") {
            room.viewers.delete(ws);
            notifyHost(room);
        }
    }

    return { onMessage, onBinary, onClose };
}
