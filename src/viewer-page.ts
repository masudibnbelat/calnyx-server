// CalNyx relay - viewer page (2026-11-21).
// The browser page served at / , /?room=ABC123 and /watch/ABC123.
// Kept in its own file so server.ts stays thin: the page is UI,
// not server logic. The password travels as a #pw=... fragment,
// so it never reaches the server; room + password in the link
// auto-join. Byte-identical to the page in the live server.ts
// the user pasted (2026-11-21), including the camera bar line.

export const VIEWER_HTML = `<!DOCTYPE html>
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
          document.getElementById('bar').textContent = (msg.mode === 'camera' ? 'Live - camera - room ' : 'Live - room ') + code;
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
