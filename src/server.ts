// CalNyx Screen Stream relay (2026-11-21, TypeScript).
// One small Node server. It carries NO video of its own - it only
// passes frames between the phone and the viewers:
//
//   Phone  --wss-->  this server  --wss-->  any browser, anywhere
//
// Protocol (must match ScreenStreamService.kt + the viewer page):
//   Phone  -> {"type":"create","password":"..."}  (password: min 2 chars)
//   Server -> {"type":"created","room":"ABC123"}
//   Viewer -> {"type":"join","room":"ABC123","password":"..."}
//   Server -> {"type":"joined","room":"ABC123"}
//           | {"type":"error","message":"Wrong password" | "Room not found"}
//   Server -> {"type":"viewers","count":2}   (to the phone, on join/leave)
//   Server -> {"type":"ended"}               (to viewers, when phone stops)
//   Phone  -> binary JPEG frame               (forwarded to joined viewers)
//
// Build:  npm install && npm run build   (outputs dist/server.js)
// Run:    node dist/server.js             (Render sets PORT itself)
// The share link is then https://<your-app>.onrender.com/?room=ABC123
// Free-tier note: Render sleeps the service after ~15 min idle,
// so the first connection after a sleep takes ~30-60 s to wake.
// While a stream is live it stays awake.

import http from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";

const PORT = Number(process.env.PORT) || 10000;

// Room code: 6 chars, no confusing 0/O/1/I.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function genCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

interface Room {
  password: string;
  broadcaster: WebSocket;
  viewers: Set<WebSocket>;
}

interface SocketMeta {
  role: "broadcaster" | "viewer" | null;
  room: string | null;
}

// Per-socket state (role + room). A WeakMap keeps it off the
// socket object itself and frees it when the socket closes.
const meta = new WeakMap<WebSocket, SocketMeta>();

// code -> room
const rooms = new Map<string, Room>();

function sendJson(ws: WebSocket, obj: unknown): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {
    // Socket already gone - nothing to do.
  }
}

function viewersCount(room: Room): number {
  let n = 0;
  room.viewers.forEach((v) => {
    if (v.readyState === WebSocket.OPEN) n++;
  });
  return n;
}

function notifyViewers(room: Room): void {
  sendJson(room.broadcaster, { type: "viewers", count: viewersCount(room) });
}

function endRoom(code: string, reason?: string): void {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  room.viewers.forEach((v) => {
    sendJson(v, { type: "ended", message: reason ?? "Stream ended." });
  });
  room.viewers.clear();
}

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CalNyx Screen Stream</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #111; color: #f5f5f5; font-family: sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { width: min(92vw, 420px); background: #1f1f1f; border: 1px solid #434343; border-radius: 16px; padding: 24px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #c7c7c7; font-size: 14px; margin: 0 0 16px; }
  input { width: 100%; padding: 12px 14px; margin-bottom: 12px; border-radius: 10px; border: 1px solid #434343; background: #333; color: #f5f5f5; font-size: 16px; }
  button { width: 100%; padding: 13px; border: 0; border-radius: 10px; background: #f5f5f5; color: #111; font-size: 16px; font-weight: bold; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { margin-top: 12px; font-size: 13px; color: #c7c7c7; min-height: 18px; }
  #screen { display: none; position: fixed; inset: 0; background: #000; }
  #screen img { width: 100%; height: 100%; object-fit: contain; }
  #screen .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px; text-align: center; font-size: 13px; color: #c7c7c7; background: rgba(0,0,0,0.6); }
</style>
</head>
<body>
<div class="card" id="joinCard">
  <h1>CalNyx Screen Stream</h1>
  <p>Enter the room code and password to watch this screen.</p>
  <input id="room" placeholder="Room code (ABC123)" maxlength="6" autocomplete="off">
  <input id="pw" type="password" placeholder="Password" autocomplete="off">
  <button id="watchBtn">Watch</button>
  <div id="status"></div>
</div>
<div id="screen">
  <img id="img" alt="">
  <div class="bar" id="bar">Live</div>
</div>
<script>
  var params = new URLSearchParams(location.search);
  var roomInput = document.getElementById('room');
  var pwInput = document.getElementById('pw');
  var statusEl = document.getElementById('status');
  var btn = document.getElementById('watchBtn');
  var room = (params.get('room') || '').toUpperCase();
  if (room) roomInput.value = room;
  // Password passed as #pw=... (fragment: never sent to the server).
  var hash = new URLSearchParams(location.hash.slice(1));
  var fragPw = hash.get('pw') || '';
  if (fragPw) pwInput.value = fragPw;
  var ws = null;
  var lastUrl = null;
  function setStatus(t) { statusEl.textContent = t; }
  function connect() {
    var code = roomInput.value.trim().toUpperCase();
    var pw = pwInput.value;
    if (code.length !== 6) { setStatus('Enter the 6-letter room code.'); return; }
    if (pw.length < 2) { setStatus('Enter the password (at least 2 characters).'); return; }
    btn.disabled = true;
    setStatus('Connecting...');
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/stream');
    ws.binaryType = 'arraybuffer';
    ws.onopen = function() {
      ws.send(JSON.stringify({ type: 'join', room: code, password: pw }));
    };
    ws.onmessage = function(ev) {
      if (typeof ev.data === 'string') {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'joined') {
          document.getElementById('joinCard').style.display = 'none';
          document.getElementById('screen').style.display = 'block';
          document.getElementById('bar').textContent = 'Live - room ' + code;
        } else if (msg.type === 'error') {
          btn.disabled = false;
          setStatus(msg.message || 'Could not join.');
          try { ws.close(); } catch (e) {}
        } else if (msg.type === 'ended') {
          document.getElementById('bar').textContent = msg.message || 'Stream ended.';
          setTimeout(function() { location.reload(); }, 3000);
        }
        return;
      }
      // Binary JPEG frame.
      var blob = new Blob([ev.data], { type: 'image/jpeg' });
      var url = URL.createObjectURL(blob);
      var img = document.getElementById('img');
      img.src = url;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = url;
    };
    ws.onclose = function() {
      var bar = document.getElementById('bar');
      if (document.getElementById('screen').style.display === 'block') {
        bar.textContent = 'Disconnected. Reload to try again.';
      } else {
        btn.disabled = false;
        setStatus('Connection failed. Try again.');
      }
    };
    ws.onerror = function() { btn.disabled = false; setStatus('Connection failed. Try again.'); };
  }
  btn.addEventListener('click', connect);
  pwInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') connect(); });
  // Auto-join when both room and password are already in the link.
  if (room && fragPw) connect();
</script>
</body>
</html>`;

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

const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws: WebSocket) => {
  meta.set(ws, { role: null, room: null });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    // Binary = a JPEG frame from the phone. Forward it to every
    // viewer of the same room, nothing else.
    if (isBinary) {
      const m = meta.get(ws);
      if (!m || m.role !== "broadcaster" || !m.room) return;
      const room = rooms.get(m.room);
      if (!room) return;
      room.viewers.forEach((v) => {
        try {
          if (v.readyState === WebSocket.OPEN) v.send(data);
        } catch (_) {
          // Dead viewer - cleaned up on its close event.
        }
      });
      return;
    }
    let msg: { type?: string; password?: string; room?: string };
    try {
      msg = JSON.parse(data.toString()) as {
        type?: string;
        password?: string;
        room?: string;
      };
    } catch (_) {
      return;
    }
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
      rooms.set(code, { password: pw, broadcaster: ws, viewers: new Set() });
      meta.set(ws, { role: "broadcaster", room: code });
      sendJson(ws, { type: "created", room: code });
    } else if (msg.type === "join") {
      const code =
        typeof msg.room === "string" ? msg.room.trim().toUpperCase() : "";
      const room = rooms.get(code);
      if (!room) {
        sendJson(ws, { type: "error", message: "Room not found. Check the code." });
        return;
      }
      if (msg.password !== room.password) {
        sendJson(ws, { type: "error", message: "Wrong password." });
        return;
      }
      meta.set(ws, { role: "viewer", room: code });
      room.viewers.add(ws);
      sendJson(ws, { type: "joined", room: code });
      notifyViewers(room);
    }
  });

  ws.on("close", () => {
    const m = meta.get(ws);
    if (!m || !m.room) return;
    const room = rooms.get(m.room);
    if (!room) return;
    if (m.role === "broadcaster") {
      // Phone stopped: the room is gone, viewers see "ended".
      endRoom(m.room, "Stream ended.");
    } else if (m.role === "viewer") {
      room.viewers.delete(ws);
      notifyViewers(room);
    }
  });

  ws.on("error", () => {
    // Ignore - close follows.
  });
});

server.listen(PORT, () => {
  console.log("CalNyx Screen Stream relay listening on " + PORT);
});
