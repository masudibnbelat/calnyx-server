// CalNyx relay — Camera Live 1-to-1 rooms (2026-11-21).
// The real Camera Live code lives HERE, not in server.ts:
//   Host   -> {"type":"create","mode":"camera","password":"..."}  (min 4 chars)
//   Server -> {"type":"created","room":"ABC123","mode":"camera","role":"host"}
//   Viewer -> {"type":"join-publish","room":"ABC123","password":"..."}
//   Server -> {"type":"joined","room":"ABC123","mode":"camera","role":"viewer"}
//           | {"type":"error","message":"Room full. This Camera Live room already has a viewer."}
//   Server -> {"type":"peer-joined","role":"viewer"}  (to the host)
//   Server -> {"type":"peer-left","role":"viewer"}    (to the host)
//   Server -> {"type":"viewers","count":0|1}          (to the host)
//   Server -> {"type":"ended"}  (to the viewer + passive watchers, when host stops)
//   Host   -> binary JPEG frame  (to the viewer + passive watchers)
//   Viewer -> binary JPEG frame  (to the host ONLY)
// A browser can also watch a camera room passively:
//   Browser -> {"type":"join","room":"ABC123","password":"..."}
//   Server  -> {"type":"joined","room":"ABC123","mode":"camera","role":"viewer"}
//   It receives host frames only and does NOT count as the 1 viewer.
//
// Rules that matter:
//   - The password is checked BEFORE the room-full check, so a
//     wrong password never leaks whether the room is full.
//   - Max 2 publishers per room (host + 1 viewer). A 3rd publisher
//     gets "Room full."
//   - Viewer frames go to the host ONLY - never to passive
//     watchers, never echoed back to the sender.
//
// Shared state comes from common.ts; the dispatcher in server.ts
// only routes here: "create" with mode "camera", "join-publish"
// for camera rooms, and "join" for camera rooms (passive watch).
// The room lookups below are defensive — the dispatcher already
// looked the room up once.

// NOTE: WebSocket is a VALUE import (not `import type`) because
// the code reads WebSocket.OPEN below. It comes from the "ws"
// package only — never from server.ts — so there is no
// circular import.
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { rooms, meta, genCode, sendJson, notifyHost, endRoom } from "./common.js";
import type { ClientMessage } from "./common.js";

export interface CameraHandlers {
    onMessage(ws: WebSocket, msg: ClientMessage): void;
    onBinary(ws: WebSocket, data: RawData): void;
    onClose(ws: WebSocket): void;
}

export function createCameraHandlers(): CameraHandlers {
    function onMessage(ws: WebSocket, msg: ClientMessage): void {
        if (msg.type === "create") {
            // Host starts a Camera Live room. Password is mandatory,
            // min 4 chars (stronger than Screen Stream's 2).
            const pw = typeof msg.password === "string" ? msg.password : "";
            if (pw.length < 4) {
                sendJson(ws, {
                    type: "error",
                    message: "Password must be at least 4 characters.",
                });
                ws.close();
                return;
            }
            let code = genCode();
            while (rooms.has(code)) code = genCode();
            rooms.set(code, {
                mode: "camera",
                password: pw,
                broadcaster: ws,
                viewers: new Set(),
                publisher: null,
            });
            meta.set(ws, { role: "broadcaster", room: code, mode: "camera" });
            sendJson(ws, { type: "created", room: code, mode: "camera", role: "host" });
            return;
        }

        if (msg.type === "join-publish") {
            // Viewer joins AS a publisher (the 1-to-1 other side).
            // Password is checked BEFORE room-full, so a wrong
            // password never leaks whether the room is full.
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
            if (msg.password !== room.password) {
                sendJson(ws, { type: "error", message: "Wrong password." });
                return;
            }
            const m = meta.get(ws);
            if (m && m.room === code) {
                sendJson(ws, { type: "error", message: "Already connected to this room." });
                return;
            }
            if (room.publisher && room.publisher.readyState === WebSocket.OPEN) {
                sendJson(ws, {
                    type: "error",
                    message: "Room full. This Camera Live room already has a viewer.",
                });
                return;
            }
            room.publisher = ws;
            meta.set(ws, { role: "publisher", room: code, mode: "camera" });
            sendJson(ws, { type: "joined", room: code, mode: "camera", role: "viewer" });
            sendJson(room.broadcaster, { type: "peer-joined", role: "viewer" });
            notifyHost(room);
            return;
        }

        if (msg.type === "join") {
            // Passive browser watcher on a camera room: sees the host
            // only, does NOT count as the 1 viewer, never publishes.
            const code =
                typeof msg.room === "string" ? msg.room.trim().toUpperCase() : "";
            const room = rooms.get(code);
            if (!room) {
                sendJson(ws, { type: "error", message: "Room not found. Check the code." });
                return;
            }
            if (room.mode !== "camera") {
                // Defensive only - the dispatcher routes screen rooms to
                // screen-stream.ts, so this should never happen.
                sendJson(ws, { type: "error", message: "Room is a screen stream, not Camera Live." });
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
            meta.set(ws, { role: "viewer", room: code, mode: "camera" });
            room.viewers.add(ws);
            sendJson(ws, { type: "joined", room: code, mode: "camera", role: "viewer" });
            return;
        }

        // Unknown types ignored.
    }

    function onBinary(ws: WebSocket, data: RawData): void {
        const m = meta.get(ws);
        if (!m || !m.room) return;
        const room = rooms.get(m.room);
        if (!room || room.mode !== "camera") return;
        if (m.role === "broadcaster") {
            // Host frames -> the viewer publisher AND passive watchers.
            if (room.publisher && room.publisher.readyState === WebSocket.OPEN) {
                try {
                    room.publisher.send(data);
                } catch (_) {
                    // Dead publisher - cleaned up on its close event.
                }
            }
            room.viewers.forEach((v) => {
                try {
                    if (v.readyState === WebSocket.OPEN) v.send(data);
                } catch (_) {
                    // Dead watcher - cleaned up on its close event.
                }
            });
        } else if (m.role === "publisher") {
            // Viewer frames -> the host ONLY. Never to passive
            // watchers, never echoed back to the sender.
            try {
                if (room.broadcaster.readyState === WebSocket.OPEN) {
                    room.broadcaster.send(data);
                }
            } catch (_) {
                // Dead host - the room ends on its close event.
            }
        }
        // Passive viewers never publish: their frames are dropped.
    }

    function onClose(ws: WebSocket): void {
        const m = meta.get(ws);
        if (!m || !m.room) return;
        const room = rooms.get(m.room);
        if (!room) return;
        if (m.role === "broadcaster") {
            // Host stopped: the room is gone. The viewer publisher
            // and the passive watchers all see "ended".
            endRoom(m.room, "Stream ended.");
        } else if (m.role === "publisher") {
            // Viewer left: the room stays live, the host is told,
            // and a new viewer can join.
            if (room.publisher === ws) room.publisher = null;
            sendJson(room.broadcaster, { type: "peer-left", role: "viewer" });
            notifyHost(room);
        } else if (m.role === "viewer") {
            room.viewers.delete(ws);
        }
    }

    return { onMessage, onBinary, onClose };
}
