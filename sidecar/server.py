#!/usr/bin/env python3
"""The speech sidecar: transcription of recordings the person added, on this machine.

It binds LOOPBACK only, on a
port the application passes in, and it speaks one protocol: a path in, a transcript with timestamps
out. It never fetches a model and never reaches a network; whatever recogniser it uses must already
be on the machine, and if none is, it says so instead of guessing.

Backends, in the order tried:
  parakeet-mlx     Apple Silicon, fastest here
  faster-whisper   everywhere else, int8 on CPU

NOT RUN. No recogniser is installed on this machine at the time of writing, so this file has been
exercised only to the point of reporting that, which is the honest half of what it does. Nothing
has been scored on a real recording with a checked transcript yet.
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


def available() -> dict:
    """What this machine can actually do, reported rather than assumed."""
    found = {}
    for name, module in (("parakeet-mlx", "parakeet_mlx"), ("faster-whisper", "faster_whisper"), ("silero-vad", "silero_vad")):
        try:
            __import__(module)
            found[name] = True
        except Exception:
            found[name] = False
    return found


def transcribe(path: str) -> dict:
    have = available()
    if not os.path.exists(path):
        return {"ok": False, "reason": "no such file", "path": path}
    if have.get("parakeet-mlx"):
        from parakeet_mlx import from_pretrained  # type: ignore

        model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v2")
        result = model.transcribe(path)
        return {
            "ok": True,
            "backend": "parakeet-mlx",
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text} for s in getattr(result, "sentences", [])
            ],
        }
    if have.get("faster-whisper"):
        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
        segments, _info = model.transcribe(path, word_timestamps=False)
        return {
            "ok": True,
            "backend": "faster-whisper",
            "segments": [{"start": s.start, "end": s.end, "text": s.text} for s in segments],
        }
    # An instrument that is not installed is not a transcript of silence.
    return {
        "ok": False,
        "reason": "no recogniser is installed on this machine, so nothing was transcribed. "
                  "This is a statement about the instrument, not about the recording.",
        "looked_for": have,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            return self._send(200, {"ok": True, "backends": available()})
        return self._send(404, {"ok": False, "reason": "no such route"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/transcribe":
            return self._send(404, {"ok": False, "reason": "no such route"})
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        return self._send(200, transcribe(body.get("path", "")))

    def log_message(self, *args) -> None:  # keep the console quiet; nothing here is a record
        return


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({"listening": server.server_address[1], "host": "127.0.0.1", "backends": available()}), flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
