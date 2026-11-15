#!/usr/bin/env python3
"""Neon Pong server: serves the game on port 8020 and relays online-multiplayer
messages between the host and guests (Server-Sent Events + POST, stdlib only)."""
import http.server, os, sys, json, queue, random, string, socket, threading
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8020
os.chdir(os.path.dirname(os.path.abspath(__file__)))
ROOMS = {}            # code -> {'host': id|None, 'clients': {id: Queue}}
LOCK = threading.Lock()

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1)); ip = s.getsockname()[0]; s.close()
        return ip
    except Exception:
        return "127.0.0.1"

class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        if not self.path.startswith("/api/"):
            super().log_message(*a)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if u.path == "/api/create":
            with LOCK:
                code = "".join(random.choice(string.ascii_uppercase) for _ in range(4))
                while code in ROOMS:
                    code = "".join(random.choice(string.ascii_uppercase) for _ in range(4))
                ROOMS[code] = {"host": None, "clients": {}}
            return self._json({"room": code, "lan": "http://%s:%d" % (lan_ip(), PORT)})
        if u.path == "/api/send":
            code = (q.get("room") or [""])[0]; sid = (q.get("id") or [""])[0]
            try:
                msg = json.loads(raw or b"{}")
            except Exception:
                return self._json({"error": "bad json"}, 400)
            with LOCK:
                room = ROOMS.get(code)
                if not room or sid not in room["clients"]:
                    return self._json({"error": "no room"}, 404)
                if sid == room["host"]:
                    to = msg.get("to")
                    targets = [i for i in room["clients"] if i != sid and (to is None or i == to)]
                else:
                    msg["from"] = sid
                    targets = [room["host"]] if room["host"] in room["clients"] else []
                for t in targets:
                    room["clients"][t].put(msg)
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/api/events":
            return super().do_GET()
        q = parse_qs(u.query)
        code = (q.get("room") or [""])[0].upper(); cid = (q.get("id") or [""])[0]
        role = (q.get("role") or ["guest"])[0]
        qu = queue.Queue()
        with LOCK:
            room = ROOMS.get(code)
            if not room or (role != "host" and room["host"] is None):
                return self._json({"error": "no room"}, 404)
            if role == "host":
                room["host"] = cid
            room["clients"][cid] = qu
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b": hi\n\n"); self.wfile.flush()
            while True:
                try:
                    m = qu.get(timeout=5)
                    self.wfile.write(("data: %s\n\n" % json.dumps(m)).encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with LOCK:
                room = ROOMS.get(code)
                if room and room["clients"].get(cid) is qu:
                    del room["clients"][cid]
                    if cid == room["host"]:
                        for oq in room["clients"].values():
                            oq.put({"t": "hostgone"})
                        del ROOMS[code]
                    elif room["host"] in room["clients"]:
                        room["clients"][room["host"]].put({"t": "left", "from": cid})

if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Neon Pong running on http://localhost:%d" % PORT)
    print("Players on your network can join at http://%s:%d  (Ctrl+C to stop)" % (lan_ip(), PORT))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
