#!/usr/bin/env python3
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Execute the bundled retrieval recipe against a disposable HTTP server.

Deterministic API fault injection, not an LLM-quality or acoustic evaluation.
No production service, credentials, audio, or customer data are used.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROMPT = Path(__file__).resolve().parents[1] / "crates/screenpipe-core/assets/pipes/meeting-summary/pipe.md"


class MeetingSummaryRetrieval(unittest.TestCase):
    def run_case(self, transcript, failures=0, fallback=None, permanent=False):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                scoped = self.path == "/meetings/42/transcript"
                count = sum(path == self.path for path in requests)
                failed = permanent or (scoped and count <= failures)
                body = {"error": "recording priority"} if failed else transcript if scoped else {"data": fallback or []}
                self.send_response(503 if failed else 200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            prompt = PROMPT.read_text()
            start = prompt.index("  # Use the same meeting-scoped transcript")
            end = prompt.index("  (curl -sf -G", start)
            recipe = prompt[start:end]
            with tempfile.TemporaryDirectory(prefix="meeting-eval-") as tmp:
                recipe = recipe.replace("/tmp/", tmp + "/").replace("http://localhost:3030", f"http://127.0.0.1:{server.server_port}")
                env = dict(os.environ, ID="42", A="Authorization: Bearer synthetic", S="2026-01-01T00:00:00Z", E="2026-01-01T00:30:00Z")
                subprocess.run(["bash", "-c", recipe + "\nwait"], env=env, check=True, capture_output=True, timeout=25)
                result = json.loads(Path(tmp, "audio.json").read_text())
            return result, requests
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_live_only_transcript_is_not_replaced_by_unrelated_search(self):
        result, requests = self.run_case([{"transcript": "Alex will deliver the draft on Friday.", "capturedAt": "2026-01-01T00:10:00Z", "deviceType": "output", "speakerName": "speaker 1"}])
        self.assertEqual(result["data"][0]["content"]["transcription"], "Alex will deliver the draft on Friday.")
        self.assertEqual(requests, ["/meetings/42/transcript"])

    def test_two_temporary_503s_recover_on_third_attempt(self):
        result, requests = self.run_case([{"transcript": "The team approved the release."}], failures=2)
        self.assertEqual(len(result["data"]), 1)
        self.assertEqual(len(requests), 3)

    def test_empty_transcript_uses_bounded_time_fallback(self):
        result, requests = self.run_case([], fallback=[{"content": {"transcription": "Recovered archived speech"}}])
        self.assertEqual(len(result["data"]), 1)
        self.assertEqual(len(requests), 2)
        self.assertIn("start_time=", requests[-1])
        self.assertIn("end_time=", requests[-1])

    def test_silent_meeting_stays_empty(self):
        result, requests = self.run_case([])
        self.assertEqual(result["data"], [])
        self.assertEqual(len(requests), 2)
        self.assertFalse(result.get("fetch_failed", False))

    def test_permanent_failure_stops_and_is_not_called_silence(self):
        result, requests = self.run_case([], permanent=True)
        self.assertEqual(result, {"data": [], "fetch_failed": True})
        self.assertEqual(len(requests), 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
