# Colab intent queue

Moat can read messages on a Colab T4 without running the model on SkyLight's
CPU. The SkyLight host keeps a single SSH connection to Colab using
`google-colab-cli`. That connection carries a loopback port forward to
`llama-server`. The `moat-intent` reader calls the forwarded endpoint. One
Redis worker consumes queued read requests in FIFO order and calls
`moat-intent` at `127.0.0.1:7083/v1/read`.

The queue API listens only on `127.0.0.1:7084`. `POST /v1/read` with JSON
`{"text":"..."}` returns HTTP 202 and a job ID. Poll
`GET /v1/result/{id}` for `queued`, `processing`, or `done`. A completed job
contains Moat's grounded reading. Results expire after one hour; waiting
jobs remain in Redis until the model is available. There is one worker, so
the model processes one request at a time.

The four systemd units in `deploy/` are:

- `moat-colab-tunnel.service`: copies `scripts/colab-gemma-server.py` into
  Colab, keeps one SSH tunnel open, and watches the model process. On a lost
  runtime it requests a T4, downloads the benchmarked model files again,
  starts llama-server, and reconnects. Colab capacity and time limits can
  cause interruptions.
- `moat-intent-colab.service`: starts the existing Moat intent reader on
  loopback, without a gateway registration credential.
- `moat-colab-queue-worker.service`: consumes Redis jobs and retries a read
  while the model is unavailable.
- `moat-colab-queue-api.service`: accepts and reports jobs on loopback.

Redis already runs on SkyLight with authentication, AOF, and a loopback bind.
The dedicated `moat_colab` ACL account is limited to `moat:colab:*` keys;
its credential is in `/etc/moat/colab-queue.env` (root owned, mode 0640,
group `moat`). The Colab CLI credential and SSH key are owned by `moat` under
`/var/lib/moat` and are not in Git. The CLI version is pinned to Google
Colab's `a84e094` commit.

This path only **reads** an intent. It does not register an intent with the
gateway, authorize a payment, or run any payment tool. Callers must show or
check the returned fields and use the existing gateway flow for any later
action. Redis AOF can retain deleted message text until compaction or backup
expiry, so do not submit real customer data without a retention and access
policy for this queue.

On 2026-09-27, a synthetic request (`Pay Alice 12 USD for invoice INV-42`)
was enqueued through the loopback API on SkyLight. The single worker sent it
through Moat's reader and the Colab T4 tunnel. The completed result was
`status=read`, `pay=[Alice]`, `amounts=[12]`, `currencies=[USD]`, and
`references=[INV-42]`, with no dropped values. This proves one live read
through the queue; it is not a throughput or long term uptime measurement.
