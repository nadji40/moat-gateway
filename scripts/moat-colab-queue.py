"""Single-consumer Redis queue for Moat's loopback-only intent reader.

The queue only reads intent. It never registers an intent or executes a payment.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis


PREFIX = "moat:colab:"
PENDING = PREFIX + "pending"
PROCESSING = PREFIX + "processing"
READER = "http://127.0.0.1:7083/v1/read"
RESULT_TTL = 3600


def connection():
    return redis.Redis(host=os.environ.get("REDIS_HOST", "127.0.0.1"),
                       username=os.environ["REDIS_USER"],
                       password=os.environ["REDIS_PASSWORD"],
                       decode_responses=True, socket_timeout=10)


def payload_key(job_id):
    return PREFIX + "payload:" + job_id


def result_key(job_id):
    return PREFIX + "result:" + job_id


def submit(db, text):
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("text must contain 1 to 4000 characters")
    if db.llen(PENDING) + db.llen(PROCESSING) >= 1000:
        raise RuntimeError("queue is full")
    job_id = uuid.uuid4().hex
    with db.pipeline(transaction=True) as tx:
        tx.set(payload_key(job_id), text.strip())
        tx.set(result_key(job_id), json.dumps({"state": "queued"}))
        tx.lpush(PENDING, job_id)
        tx.execute()
    return job_id


def status(db, job_id):
    if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
        return None
    value = db.get(result_key(job_id))
    return json.loads(value) if value else None


def work(db):
    while True:
        # The processing list survives worker restarts. Read-only jobs are safe
        # to repeat if a crash occurred after the model answered.
        job_id = db.lindex(PROCESSING, -1)
        if not job_id:
            job_id = db.brpoplpush(PENDING, PROCESSING, timeout=5)
        if not job_id:
            continue
        text = db.get(payload_key(job_id))
        if text is None:
            db.lrem(PROCESSING, 1, job_id)
            continue
        db.set(result_key(job_id), json.dumps({"state": "processing"}))
        try:
            request = urllib.request.Request(READER, data=json.dumps({"text": text}).encode(),
                                             headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=90) as response:
                reading = json.load(response)
            if reading.get("status") != "read":
                raise RuntimeError("intent reader unavailable")
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            print(f"job {job_id}: reader unavailable ({type(error).__name__}); retrying", flush=True)
            time.sleep(15)
            continue
        with db.pipeline(transaction=True) as tx:
            tx.set(result_key(job_id), json.dumps({"state": "done", "reading": reading}),
                   ex=RESULT_TTL)
            tx.delete(payload_key(job_id))
            tx.lrem(PROCESSING, 1, job_id)
            tx.execute()
        print(f"job {job_id}: read", flush=True)


class Handler(BaseHTTPRequestHandler):
    db = None

    def respond(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"status": "ok"})
        elif self.path.startswith("/v1/result/"):
            result = status(self.db, self.path.removeprefix("/v1/result/"))
            self.respond(200 if result else 404, result or {"error": "job not found"})
        else:
            self.respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/read":
            self.respond(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 20000:
            self.respond(400, {"error": "invalid body length"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            job_id = submit(self.db, body["text"])
        except (ValueError, KeyError, TypeError):
            self.respond(400, {"error": "expected JSON with text of 1 to 4000 characters"})
            return
        except RuntimeError:
            self.respond(503, {"error": "queue is full"})
            return
        self.respond(202, {"id": job_id, "state": "queued"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("api", "worker", "enqueue", "result"))
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    db = connection()
    db.ping()
    if args.mode == "api":
        Handler.db = db
        server = ThreadingHTTPServer(("127.0.0.1", 7084), Handler)
        server.serve_forever()
    elif args.mode == "worker":
        work(db)
    elif args.mode == "enqueue":
        print(submit(db, args.value or sys.stdin.read()))
    else:
        print(json.dumps(status(db, args.value or "")))


if __name__ == "__main__":
    main()
