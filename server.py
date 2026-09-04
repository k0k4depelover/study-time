#!/usr/bin/env python3
"""
Study Session Timer – HTTP server
Pure stdlib, no external dependencies.

Endpoints:
  GET  /                       → index.html
  GET  /<file>                 → static file from ./static/
  GET  /api/plan               → current plan (ETag-based caching)
  POST /api/plan               → set plan { content, format }
  GET  /api/state              → last persisted session state
  POST /api/state              → save session state snapshot
  POST /mcp/tools/set_plan     → MCP-compatible ingestion endpoint
  GET  /mcp/tools/get_example_plan → returns an example plan (MCP tool)
  GET  /openapi.json           → OpenAPI manifest (MCP discovery)

Persistence:
  Single-file SQLite DB (study.db) with a simple key-value table.
  Inspired by Apple's NSUserDefaults: lightweight, monolithic, no schemas
  beyond a (key, value, ts) triplet.  WAL mode keeps writes fast and
  non-blocking even if the frontend posts a heartbeat every 30 s.
"""

import json
import os
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ── Windows cp1252 fix ───────────────────────────────────────────────────────
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "study.db")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}

# ── SQLite KV store ───────────────────────────────────────────────────────────
#
#  Design: one table, one row per logical key.
#  Keys used:
#    "plan"    → { content, format, source }
#    "session" → { tasks, currentIndex, sessionRemaining,
#                  taskRemaining, phase, savedAt }
#
#  WAL journal_mode: allows concurrent reads while a write is in progress.
#  synchronous=NORMAL: safe for single-user apps (no fsync on every write).
#
_db_lock = threading.Lock()  # serialize writes from multiple HTTP threads


def _open_db() -> sqlite3.Connection:
    """Open the DB connection with recommended settings for a local KV store."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-4000")  # 4 MB page cache
    conn.execute("""
        CREATE TABLE IF NOT EXISTS kv (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    conn.commit()
    return conn


# Module-level connection (single-user app, one thread reads at a time)
_conn: sqlite3.Connection = _open_db()


def kv_get(key: str):
    """Return the parsed JSON value for key, or None."""
    row = _conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    if row is None:
        return None
    try:
        return json.loads(row[0])
    except json.JSONDecodeError:
        return None


def kv_set(key: str, value) -> None:
    """Upsert a JSON-serialisable value under key."""
    serialised = json.dumps(value, ensure_ascii=False)
    ts = int(time.time())
    with _db_lock:
        _conn.execute(
            "INSERT INTO kv(key, value, updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
            "updated_at=excluded.updated_at",
            (key, serialised, ts),
        )
        _conn.commit()


# ── In-memory state (seeded from DB on startup) ──────────────────────────────
_mem_lock = threading.Lock()


def _seed_from_db():
    """Load persisted plan into memory so ETag polling works immediately."""
    saved = kv_get("plan")
    if saved and saved.get("content"):
        return saved, 1  # plan, etag=1 (already existed)
    return {"content": None, "format": "markdown", "source": None}, 0


_plan, _etag = _seed_from_db()


# ── HTTP Handler ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"  [{self.command}] {self.path}  ->  {args[1]}")

    # ── helpers ───────────────────────────────────────────────────────────────
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, If-None-Match")

    def _json(self, code: int, data: dict, etag=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        if etag is not None:
            self.send_header("ETag", str(etag))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n > 0 else b""

    def _static(self, rel: str):
        safe = rel.lstrip("/\\").replace("\\", "/")
        path = os.path.normpath(os.path.join(STATIC_DIR, safe))
        if not path.startswith(STATIC_DIR):
            self.send_error(403, "Forbidden")
            return
        if not os.path.isfile(path):
            self.send_error(404, f"Not found: /{rel}")
            return
        ext = os.path.splitext(path)[1]
        mime = MIME.get(ext, "application/octet-stream")
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", len(data))
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    # ── verb routing ──────────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._static("index.html")
        elif path == "/api/plan":
            self._get_plan()
        elif path == "/api/state":
            self._get_state()
        elif path == "/mcp/tools/get_example_plan":
            self._mcp_get_example_plan()
        elif path == "/openapi.json":
            self._serve_openapi()
        else:
            self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/plan":
            self._post_plan()
        elif path == "/api/state":
            self._post_state()
        elif path == "/mcp/tools/set_plan":
            self._mcp_set_plan()
        else:
            self.send_error(404, "Not Found")

    # ── /api/plan ─────────────────────────────────────────────────────────────
    def _get_plan(self):
        global _plan, _etag
        client_etag = self.headers.get("If-None-Match", "")
        with _mem_lock:
            etag = _etag
            plan = dict(_plan)

        if str(client_etag) == str(etag) and plan.get("content") is not None:
            self.send_response(304)
            self._cors()
            self.end_headers()
            return

        self._json(200, {"plan": plan, "etag": etag}, etag=etag)

    def _post_plan(self):
        global _plan, _etag
        try:
            data = json.loads(self._body())
        except Exception as e:
            self._json(400, {"error": str(e)})
            return

        plan_obj = {
            "content": data.get("content", ""),
            "format": data.get("format", "markdown"),
            "source": "api",
        }
        with _mem_lock:
            _plan = plan_obj
            _etag += 1
            etag = _etag

        # Persist to DB (non-blocking: WAL handles concurrent access)
        kv_set("plan", plan_obj)
        self._json(200, {"ok": True, "etag": etag})

    # ── /api/state ────────────────────────────────────────────────────────────
    def _get_state(self):
        """
        Returns the last saved session snapshot so the frontend can offer
        to restore a session after a page reload or server restart.
        """
        state = kv_get("session")
        self._json(200, {"state": state})

    def _post_state(self):
        """
        Save a session snapshot.  Called by the frontend on pause,
        task completion, extra-time addition, and every 30 s (heartbeat).

        Expected body:
          {
            "tasks":            [...],   // full task array with completion values
            "currentIndex":     int,
            "sessionRemaining": float,   // seconds
            "taskRemaining":    float,   // seconds
            "phase":            str,     // paused | running | done …
            "planContent":      str,     // raw markdown (for plan reconstruction)
            "planFormat":       str
          }
        """
        try:
            data = json.loads(self._body())
        except Exception as e:
            self._json(400, {"error": str(e)})
            return

        # Always add a server-side timestamp for display purposes
        data["savedAt"] = int(time.time())
        kv_set("session", data)

        # Also keep plan in sync if provided
        if data.get("planContent"):
            plan_obj = {
                "content": data["planContent"],
                "format": data.get("planFormat", "markdown"),
                "source": "session-sync",
            }
            kv_set("plan", plan_obj)
            global _plan, _etag
            with _mem_lock:
                _plan = plan_obj
                # Don't bump etag here — this is a sync, not a new plan

        self._json(200, {"ok": True, "savedAt": data["savedAt"]})

    # ── /mcp/tools/set_plan ───────────────────────────────────────────────────
    def _mcp_set_plan(self):
        global _plan, _etag
        try:
            data = json.loads(self._body())
        except Exception as e:
            self._json(400, {"error": str(e)})
            return

        params = data.get("params", data)
        plan_obj = {
            "content": params.get("content", ""),
            "format": params.get("format", "markdown"),
            "source": "mcp",
        }
        with _mem_lock:
            _plan = plan_obj
            _etag += 1
            etag = _etag

        kv_set("plan", plan_obj)
        self._json(200, {"result": {"ok": True, "etag": etag}, "tool": "set_plan"})

    # ── /mcp/tools/get_example_plan ───────────────────────────────────────────────────

    def _mcp_get_example_plan(self):
        self._json(
            200,
            {"Example plan": """
                            # Mi sesión de estudio

                            | Tarea | Minutos | Descripción | 25% | 50% | 75% |
                            |---|---:|---|---|---|---|
                            | Matemáticas | 45 | Derivadas e integrales | ✓ | ✓ | ✓ |
                            | Física | 50 | Mecánica cuántica | | ✓ | |
                            | Programación | 60 | Algoritmos de ordenamiento | ✓ | ✓ | ✓ |
                            | Descanso | 10 | | | | |

                            ## Nombre de tarea (45 min)"""},
        )

    # ── /openapi.json ─────────────────────────────────────────────────────────
    def _serve_openapi(self):
        openapi_path = os.path.join(BASE_DIR, "openapi.json")
        with open(openapi_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header(
            "Access-Control-Allow-Origin", "*"
        )  # Indispensable para llamadas cross-origin de agentes
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    host, port = "localhost", 8000

    # Log what was found in DB
    saved_plan = kv_get("plan")
    saved_session = kv_get("session")
    has_plan = bool(saved_plan and saved_plan.get("content"))
    has_session = bool(saved_session)

    httpd = HTTPServer((host, port), Handler)

    print(f"\n  Study Session Timer")
    print(f"  -> http://{host}:{port}")
    print(f"  DB: {DB_PATH}")
    print(f"  Persisted plan:    {'yes' if has_plan else 'none'}")
    if has_session:
        saved_ts = saved_session.get("savedAt", 0)
        saved_ago = int(time.time()) - saved_ts if saved_ts else 0
        ago_str = (
            f"{saved_ago // 60} min ago" if saved_ago > 60 else f"{saved_ago}s ago"
        )
        print(f"  Persisted session: yes (saved {ago_str})")
    else:
        print(f"  Persisted session: none")
    print(f"\n MCP GET http://{host}:{port}/mcp/tools/get_example_plan")
    print(f"\n  MCP: POST http://{host}:{port}/mcp/tools/set_plan")

    print(f"  Ctrl+C to stop\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
