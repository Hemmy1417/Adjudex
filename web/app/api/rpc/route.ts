/**
 * The same-origin read proxy.
 *
 * WHY THIS EXISTS, measured rather than assumed. Probing StudioNet directly:
 *
 *   30 concurrent reads  ->  3 succeeded, 27 rejected
 *   reads paced 1.5s apart over 62s  ->  18 succeeded, 6 rejected
 *   error text: "Rate limit exceeded: 30 requests per minute"
 *
 * The ceiling is 30 requests per MINUTE per IP, and a single read takes about
 * 1.3 seconds. A portfolio page with eight positions needs seventeen reads; a
 * write confirming through lib/tx.ts polls thirty times on its own. Talking to
 * the RPC straight from the browser therefore does not merely risk a slow
 * page, it produces a broken one.
 *
 * Routing reads through here buys three things:
 *
 *   1. COALESCING. Everyone looking at the marketplace is asking the identical
 *      question. One upstream read answers all of them for the cache window,
 *      so the cost of a reader is close to zero.
 *   2. PACING. One place enforces the upstream budget, instead of every tab
 *      independently discovering the ceiling by hitting it.
 *   3. HONEST ERRORS. A rate-limited or erroring upstream can answer with an
 *      HTML body and no CORS headers, which reaches the browser as an opaque
 *      "Failed to fetch" that says nothing. This route always answers
 *      same-origin JSON that names what happened.
 *
 * HONEST LIMITATION: the cache and the pacer are per serverless instance.
 * Vercel may run several, so the effective upstream rate is per instance, not
 * global. That is a real weakness, not a detail to gloss: it is a mitigation
 * for the read budget, not a guarantee of it. A durable shared cache would
 * need a store this build deliberately does not have.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = (
  process.env.GENLAYER_RPC_URL ??
  process.env.NEXT_PUBLIC_GENLAYER_RPC_URL ??
  "https://studio.genlayer.com/api"
).trim();

const CONTRACT = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? "").trim().toLowerCase();

/**
 * Measured ceiling is 30 per minute. Holding at 26 leaves headroom so a burst
 * arriving exactly on a window boundary does not tip over, and spacing keeps
 * the upstream from seeing a thundering herd in the first place.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 26;
const MIN_SPACING_MS = 2_100;

/**
 * Four seconds. Long enough to collapse a page's worth of reads and every
 * concurrent viewer, short enough that lib/tx.ts polling its confirmation
 * predicate every six seconds still observes a fresh answer each time. Raising
 * this would start reporting landed writes as unconfirmed.
 */
const CACHE_TTL_MS = 4_000;

/** How long a caller may wait for a pacing slot before we admit we are busy. */
const MAX_QUEUE_WAIT_MS = 25_000;

type Cached = { at: number; status: number; body: unknown };

const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<{ status: number; body: unknown }>>();
const recent: number[] = [];
let lastCallAt = 0;
let chain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serialize upstream calls behind the sliding window and the spacing rule.
 *
 * THE BACKPRESSURE HAS TO MEASURE THE WHOLE WAIT. `started` used to be read
 * inside the chained callback, which only runs once a job reaches the HEAD of
 * the queue, so time spent queued counted for nothing and the 25s cap could
 * never fire however deep the queue grew. Thirty distinct reads arriving at
 * once each waited 2.1s longer than the last, and the thirtieth sat for a
 * minute with no refusal, long past any serverless request timeout. It is
 * stamped on ARRIVAL now, and the queue has a depth limit as well, because a
 * cap measured in seconds still lets an unbounded number of requests pile up
 * behind it.
 */
const MAX_QUEUE_DEPTH = 24;
let queued = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  if (queued >= MAX_QUEUE_DEPTH) return Promise.reject(new Error("BUSY"));
  queued++;
  const started = Date.now();
  const run = chain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (recent.length && now - recent[0] >= WINDOW_MS) recent.shift();

      const sinceLast = now - lastCallAt;
      const spacingWait = sinceLast >= MIN_SPACING_MS ? 0 : MIN_SPACING_MS - sinceLast;
      const windowWait =
        recent.length < MAX_PER_WINDOW ? 0 : WINDOW_MS - (now - recent[0]) + 50;
      const wait = Math.max(spacingWait, windowWait);

      if (wait <= 0) break;
      if (now - started + wait > MAX_QUEUE_WAIT_MS) {
        throw new Error("BUSY");
      }
      await sleep(Math.min(wait, 1_000));
    }
    lastCallAt = Date.now();
    recent.push(lastCallAt);
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run.then(job).finally(() => {
    queued--;
  });
}

/**
 * Every refusal leaves here as a valid JSON-RPC envelope, never as a bespoke
 * shape.
 *
 * The SDK's transport does `const data = await response.json(); if (data.error)
 * throw data.error;` without ever looking at the HTTP status. Answering with
 * `{error: "read_budget", detail: "..."}` therefore throws the bare STRING
 * "read_budget" into the app, which carries no code, no retry hint, and does
 * not match the transient patterns the read layer classifies on. The result is
 * a rate-limited read reported to the user as a hard failure, and during a
 * write's confirmation polling, a landed transaction reported as failed.
 *
 * The [transient] tag is the machine-readable part: lib/read.ts keys retry
 * behaviour off it rather than off a prose match that drifts when copy changes.
 */
const TRANSIENT_TAG = "[transient]";

function rpcError(status: number, code: number, message: string, id: unknown = null) {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status },
  );
}

/**
 * The allowlist. This proxy forwards exactly two things: a READ against the
 * one contract this app is configured for, and a transaction-status lookup by
 * hash. It cannot be used to submit a transaction, to read another contract,
 * or to reach any other RPC method, so publishing it does not hand anyone a
 * general-purpose relay.
 *
 * The status lookup exists because a contract read is not finality. A view
 * predicate turning true proves the write was ACCEPTED — a state StudioNet
 * can still walk back — so lib/tx.ts follows it by polling the transaction
 * itself until the chain reports FINALIZED, and those polls have to travel
 * through the same pacing and cache as every other read or they would blow
 * the 30-per-minute budget the proxy exists to protect. The lookup is
 * read-only, takes exactly one 0x-prefixed 32-byte hash, and reveals nothing
 * a block explorer would not.
 */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function reject(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The request body must be a single JSON-RPC object.";
  }
  const b = body as Record<string, unknown>;
  if (b.method === "eth_getTransactionByHash") {
    const params = b.params;
    if (
      !Array.isArray(params) ||
      params.length !== 1 ||
      typeof params[0] !== "string" ||
      !TX_HASH.test(params[0])
    ) {
      return "A transaction lookup takes exactly one 0x-prefixed 32-byte hash.";
    }
    return null;
  }
  if (b.method !== "gen_call") {
    return `This endpoint forwards read calls only. It does not forward ${String(b.method)}.`;
  }
  const params = b.params;
  if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== "object" || params[0] === null) {
    return "A gen_call takes exactly one parameter object.";
  }
  const p = params[0] as Record<string, unknown>;
  if (p.type !== "read") {
    return "This endpoint forwards read calls only. Writes are signed and sent by your wallet.";
  }
  if (!CONTRACT) {
    return "No contract is configured on the server, so there is nothing to read.";
  }
  if (typeof p.to !== "string" || p.to.toLowerCase() !== CONTRACT) {
    return "This endpoint reads one contract only, and that is not it.";
  }
  if (typeof p.data !== "string") {
    return "The call carries no encoded method.";
  }
  return null;
}

/**
 * A read against this contract is a few hundred bytes: a method selector and
 * its arguments. Eight kilobytes is far more than any legitimate call needs.
 *
 * Without this a 2MB body was accepted, forwarded upstream, rejected there,
 * and came back classified as TRANSIENT, so the client would retry something
 * that could never succeed. Refusing it here costs one comparison and turns an
 * infinite retry into a clear refusal.
 */
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return rpcError(413, -32600, "That request is far larger than any read this endpoint serves.");
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return rpcError(400, -32700, "The request body could not be read.");
  }
  if (raw.length > MAX_BODY_BYTES) {
    return rpcError(413, -32600, "That request is far larger than any read this endpoint serves.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "The request body was not valid JSON.");
  }

  const reqId = (body as { id?: unknown })?.id ?? null;

  const refusal = reject(body);
  if (refusal) return rpcError(403, -32601, refusal, reqId);

  const p = (body as { params: Array<Record<string, unknown>> }).params[0];

  // The key is normalised and complete. `to` is lowercased because the
  // allowlist compares it that way, so a case-varied address is the SAME read
  // and must not buy a second upstream slot. `from` is included because the
  // contract may answer differently for a different caller, and two callers
  // sharing a cache entry would hand one of them the other's answer.
  const key = [
    String(p.to).toLowerCase(),
    String(p.from ?? "").toLowerCase(),
    String(p.data),
    String(p.transaction_hash_variant ?? ""),
  ].join(":");
  const id = (body as { id?: unknown }).id ?? 1;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(withId(hit.body, id), { status: hit.status });
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        return await schedule(() => callUpstream(body));
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }

  let out: { status: number; body: unknown };
  try {
    out = await pending;
  } catch (e) {
    if (e instanceof Error && e.message === "BUSY") {
      return rpcError(
        429,
        -32029,
        `${TRANSIENT_TAG} This page is reading the chain faster than StudioNet allows. It will catch up shortly.`,
        reqId,
      );
    }
    return rpcError(
      502,
      -32603,
      `${TRANSIENT_TAG} StudioNet could not be reached. Try again shortly.`,
      reqId,
    );
  }

  if (out.status === 200) cache.set(key, { at: Date.now(), ...out });
  return NextResponse.json(withId(out.body, id), { status: out.status });
}

/**
 * The cached body carries whichever id the first caller used. JSON-RPC clients
 * match responses to requests by id, so a cached hit handed to a second caller
 * has to be re-stamped or the client discards it as unsolicited.
 */
function withId(body: unknown, id: unknown): unknown {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), id };
  }
  return body;
}

async function callUpstream(body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML error page or a proxy banner. This is the exact failure that
    // reaches a browser as an unexplained "Failed to fetch" when the RPC is
    // called directly, so it gets named here instead.
    const rateLimited = /rate limit|too many requests/i.test(text) || res.status === 429;
    return {
      status: rateLimited ? 429 : 502,
      body: {
        jsonrpc: "2.0",
        error: {
          code: rateLimited ? -32029 : -32603,
          message: rateLimited
            ? `${TRANSIENT_TAG} StudioNet rate limit reached. This page will retry.`
            : `${TRANSIENT_TAG} StudioNet answered with a non-JSON body (HTTP ${res.status}).`,
        },
      },
    };
  }

  // A JSON-RPC error still arrives as HTTP 200. Rate limiting is re-tagged so
  // the client treats it as transient rather than as a read that failed to
  // load, and so a write confirming through tx.ts keeps polling instead of
  // reporting a landed transaction as failed.
  const err = (parsed as { error?: { message?: string } })?.error;
  if (err && /rate limit/i.test(String(err.message ?? ""))) {
    return {
      status: 429,
      body: {
        jsonrpc: "2.0",
        error: { code: -32029, message: `${TRANSIENT_TAG} ${err.message}` },
      },
    };
  }
  return { status: res.ok ? 200 : res.status, body: parsed };
}
