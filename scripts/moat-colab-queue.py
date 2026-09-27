"""Serialize Moat's OpenAI-compatible model calls through Redis and Colab.

The API is only a loopback model proxy. It holds no gateway approver key and
cannot register an intent or execute a payment.
"""

import argparse
import json
import os
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis


PREFIX = "moat:colab:"
PENDING = PREFIX + "pending"
PROCESSING = PREFIX + "processing"
MODEL_URL = "http://127.0.0.1:8092/v1/chat/completions"
WAIT_SECONDS = 120
MAX_ACTIVE_REQUESTS = 3
slots = threading.BoundedSemaphore(MAX_ACTIVE_REQUESTS)


def connection():
    return redis.Redis(host=os.environ.get("REDIS_HOST", "127.0.0.1"),
                       username=os.environ["REDIS_USER"],
                       password=os.environ["REDIS_PASSWORD"],
                       decode_responses=True, socket_timeout=WAIT_SECONDS + 5)


def payload_key(job_id):
    return PREFIX + "payload:" + job_id


def result_key(job_id):
    return PREFIX + "result:" + job_id


def enqueue(db, body):
    if db.llen(PENDING) + db.llen(PROCESSING) >= MAX_ACTIVE_REQUESTS:
        raise RuntimeError("model queue is full")
    job_id = uuid.uuid4().hex
    payload = json.dumps({"body": body, "deadline": time.time() + WAIT_SECONDS})
    with db.pipeline(transaction=True) as tx:
        tx.set(payload_key(job_id), payload, ex=3600)
        tx.lpush(PENDING, job_id)
        tx.execute()
    return job_id


def finish(db, job_id, status, body):
    with db.pipeline(transaction=True) as tx:
        tx.lpush(result_key(job_id), json.dumps({"status": status, "body": body}))
        tx.expire(result_key(job_id), 120)
        tx.delete(payload_key(job_id))
        tx.lrem(PROCESSING, 1, job_id)
        tx.execute()


def work(db):
    while True:
        # Read-only inference can be repeated after a worker crash. Keep the
        # processing list until a result and acknowledgement commit together.
        job_id = db.lindex(PROCESSING, -1)
        if not job_id:
            job_id = db.brpoplpush(PENDING, PROCESSING, timeout=5)
        if not job_id:
            continue
        raw = db.get(payload_key(job_id))
        if raw is None:
            db.lrem(PROCESSING, 1, job_id)
            continue
        payload = json.loads(raw)
        remaining = payload["deadline"] - time.time()
        if remaining <= 2:
            finish(db, job_id, 503, {"error": "model request expired in queue"})
            continue
        try:
            request = urllib.request.Request(
                MODEL_URL, data=json.dumps(payload["body"]).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=min(115, remaining - 1)) as response:
                answer = json.load(response)
            finish(db, job_id, 200, answer)
            print(f"model job {job_id}: completed", flush=True)
        except (OSError, ValueError) as error:
            finish(db, job_id, 503, {"error": "Colab model unavailable"})
            print(f"model job {job_id}: {type(error).__name__}", flush=True)


class Handler(BaseHTTPRequestHandler):
    db = None

    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            self.respond(404, {"error": "not found"})
            return
        self.respond(200, {"status": "ok", "pending": self.db.llen(PENDING),
                           "processing": self.db.llen(PROCESSING)})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.respond(404, {"error": "not found"})
            return
        if not slots.acquire(blocking=False):
            self.respond(503, {"error": "too many waiting model requests"})
            return
        try:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 32768:
                    raise ValueError("invalid body length")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
                    raise ValueError("invalid completion request")
            except (ValueError, TypeError):
                self.respond(400, {"error": "invalid completion request"})
                return
            try:
                job_id = enqueue(self.db, body)
                result = self.db.brpop(result_key(job_id), timeout=WAIT_SECONDS)
            except redis.RedisError:
                self.respond(503, {"error": "model queue unavailable"})
                return
            except RuntimeError:
                self.respond(503, {"error": "model queue is full"})
                return
            if result is None:
                self.respond(503, {"error": "model request timed out"})
                return
            outcome = json.loads(result[1])
            self.respond(outcome["status"], outcome["body"])
        finally:
            slots.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("api", "worker"))
    args = parser.parse_args()
    db = connection()
    db.ping()
    if args.mode == "api":
        Handler.db = db
        ThreadingHTTPServer(("127.0.0.1", 8093), Handler).serve_forever()
    else:
        work(db)


if __name__ == "__main__":
    main()
