// CalNyx relay — shared plumbing (2026-11-21).
// Everything BOTH feature modules need, in one place: the room
// and socket types, the shared room map, room-code generation,
// and the small helpers (sendJson / peerCount / notifyHost /
// endRoom). This file imports ONLY from "ws" — nothing local —
// so screen-stream.ts and camera.ts can both import from it
// with no circular import. server.ts imports it too, but only
// to read `rooms` / `meta` for routing.

import { WebSocket } from "ws";

export interface Room {
    mode: "screen" | "camera";
    password: string;
    broadcaster: WebSocket;
    viewers: Set<WebSocket>;
    publisher: WebSocket | null;
}

export interface SocketMeta {
    role: "broadcaster" | "viewer" | "publisher" | null;
    room: string | null;
    mode: "screen" | "camera" | null;
}

// One message from a client (phone, viewer or browser).
export interface ClientMessage {
    type?: string;
    password?: string;
    room?: string;
    mode?: string;
}

// code -> room
export const rooms = new Map<string, Room>();

// Per-socket state (role + room + mode). A WeakMap keeps it off
// the socket object itself and frees it when the socket closes.
export const meta = new WeakMap<WebSocket, SocketMeta>();

// Room code: 6 chars, no confusing 0/O/1/I.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function genCode(): string {
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return code;
}

export function sendJson(ws: WebSocket, obj: unknown): void {
    try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    } catch (_) {
        // Socket already gone - nothing to do.
    }
}

// How many peers the host is connected to: for a screen room the
// open passive viewers, for a camera room 1 while its viewer is
// connected, else 0 (passive browser watchers never count).
export function peerCount(room: Room): number {
    if (room.mode === "camera") {
        return room.publisher && room.publisher.readyState === WebSocket.OPEN ? 1 : 0;
    }
    let n = 0;
    room.viewers.forEach((v) => {
        if (v.readyState === WebSocket.OPEN) n++;
    });
    return n;
}

export function notifyHost(room: Room): void {
    sendJson(room.broadcaster, { type: "viewers", count: peerCount(room) });
}

export function endRoom(code: string, reason?: string): void {
    const room = rooms.get(code);
    if (!room) return;
    rooms.delete(code);
    room.viewers.forEach((v) => {
        sendJson(v, { type: "ended", message: reason ?? "Stream ended." });
    });
    room.viewers.clear();
    if (room.publisher) {
        sendJson(room.publisher, { type: "ended", message: reason ?? "Stream ended." });
        room.publisher = null;
    }
}
