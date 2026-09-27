# Colab intent queue

SkyLight runs the Moat gateway and intent reader. Gemma runs on a Colab T4,
reached through one `google-colab-cli` SSH tunnel. The reader sends its
OpenAI-compatible completion requests to the loopback queue proxy at
`127.0.0.1:8093`. One Redis worker sends them, in FIFO order, to the forwarded
Colab `llama-server` at `127.0.0.1:8092`. There is one worker and one model
slot, so only one completion runs at a time.

Clients use the normal `moat-intent` routes on `127.0.0.1:7083`:

- `POST /v1/read` with `{"text":"..."}` reads and grounds fields for the host
  to show the user. It does not change gateway state.
- `POST /v1/session/{id}/intent` with the same body and the caller's approver
  bearer key reads the message and passes the grounded fields to the gateway
  at `127.0.0.1:7082`. The key stays in the reader process during that request;
  it is not stored in Redis or Colab. The gateway validates the key and tenant.

When Colab is unavailable or a queued read exceeds 55 seconds, the reader
returns `status=unavailable` with empty intent fields. The registration route
then forwards those empty fields, so the message cannot provide model-derived
payment authority. A caller should retry the read when Colab returns; it
must never treat an unavailable read as confirmation to pay.

The four systemd units in `deploy/` are:

- `moat-colab-tunnel.service`: copies `scripts/colab-gemma-server.py` into
  Colab, keeps one SSH tunnel open, and watches the model process. On a lost
  runtime it requests a T4, downloads the benchmarked model files again,
  starts llama-server, and reconnects. Colab capacity and time limits can
  cause interruptions.
- `moat-colab-queue-api.service`: accepts model completions on loopback and
  waits for a Redis job result.
- `moat-colab-queue-worker.service`: processes one model job at a time. Its
  only network target is the loopback tunnel; it never calls the gateway.
- `moat-intent-colab.service`: starts Moat's grounded reader with the queue
  proxy as its model endpoint and the gateway's intent API for registration.

Redis already runs on SkyLight with authentication, AOF, and a loopback bind.
The dedicated `moat_colab` ACL account is limited to `moat:colab:*` keys;
its credential is in `/etc/moat/colab-queue.env` (root owned, mode 0640,
group `moat`). The Colab CLI credential and SSH key are owned by `moat` under
`/var/lib/moat` and are not in Git. The CLI version is pinned to Google
Colab's `a84e094` commit. Moat redacts card and account details before
calling the model, but Redis AOF can still retain other message content until
compaction or backup expiry. Set a customer-data retention and access policy
before using the queue with real customer messages.

The notebook's one-at-a-time T4 configuration uses Gemma 4 E4B Q4 with the
MTP drafter, one parallel slot, and context 2048. Its median was 0.767 seconds
on a 36-message internal corpus. That measurement excludes Redis queue wait,
SSH startup, and Colab runtime startup. Colab uptime is not guaranteed.

On 2026-09-27 the same corpus was run through SkyLight's queued model path.
The grounded reader produced 0 unsafe payees and 36/36 expected payees, but
34/36 expected refusals, 34/36 amounts, and 31/36 cancellation flags; median
read time was 1.9 seconds. The notebook's 36/36 for those fields did not
repeat in this live run. Keep confirmation in the host flow and do not use
these small internal samples as a production accuracy guarantee.
