"""Local HTTP service that runs The Thinking Room's OpenSpiel agent team.

    python server.py [--port 8765]

Prints "THINKING_ROOM_ENGINE_READY <port>" once it is listening; the desktop
app waits for that line. Pass --port 0 to pick any free port.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pyspiel  # noqa: E402

import agents  # noqa: E402
from games import ADAPTERS, EngineError  # noqa: E402

MAX_BODY = 64 * 1024
OPENSPIEL_VERSION = getattr(pyspiel, "__version__", None) or "2.0.2"


class Handler(BaseHTTPRequestHandler):
    server_version = "ThinkingRoomEngine/1.0"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "engine": "openspiel", "version": OPENSPIEL_VERSION, "games": sorted(ADAPTERS)})
        else:
            self._send(404, {"error": "Not found."})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        if not 0 < length <= MAX_BODY:
            self._send(413, {"error": "Request body is missing or too large."})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise EngineError("Expected a JSON object.")
            if self.path == "/move":
                legal = payload.get("legalMoves")
                if not isinstance(legal, list) or not legal or not all(isinstance(move, str) for move in legal):
                    raise EngineError("legalMoves must be a non-empty list of strings.")
                result = agents.choose_move(payload.get("game"), payload.get("board"), legal, payload.get("challengeMode", "balanced"))
            else:
                self._send(404, {"error": "Not found."})
                return
        except (EngineError, json.JSONDecodeError) as error:
            self._send(400, {"error": str(error)})
            return
        except Exception as error:  # Keep the service alive and report the failure to the app.
            self._send(500, {"error": f"OpenSpiel engine error: {error}"})
            return
        self._send(200, result)

    def log_message(self, format, *args):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENSPIEL_PORT", 8765)))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"THINKING_ROOM_ENGINE_READY {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
