interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * Phillips MCP — realized auction prices from phillips.com.
 *
 * ENTRY POINT, AND WHY IT IS THIS ONE
 *   phillips.com's robots.txt (checked 2026-09-05) disallows /Search, /search
 *   and /SEARCH — all three case variants — plus /bin/, /phillips/otis and
 *   /*\/filter/. The keyword-search path every other auction pack uses is
 *   therefore closed here, and this pack does not go near it.
 *
 *   What IS allowed, and what this pack uses instead:
 *     - /sitemap.xml  — 13,031 `/artist/<makerId>/<name>` URLs, which is the
 *       artist-name -> makerId index this pack resolves names against.
 *     - /artist/<makerId>/<slug>  — the artist landing page. It server-renders
 *       past lots WITH realized prices, and carries the same rows as a JSON
 *       blob in the `PhillipsReact.ArtistLanding` hydration props: a `maker`
 *       string holding `pastLots.data[]` with hammerPlusBP (the realized
 *       price), low/high estimate, currency, sale number, lot number and sale
 *       date. Verified live 2026-09-05.
 *     - /detail/<slug>/<objectNumber>  — the lot page, for lot_details.
 *   None of those three is disallowed. The slug segment of both /artist/ and
 *   /detail/ URLs is decorative — any non-empty value resolves, only the
 *   numeric id matters — so this pack sends the real one when it knows it.
 *
 * WHAT THIS COSTS THE CALLER IN COVERAGE
 *   The artist page returns ONE page of past lots — 24 rows — and phillips.com
 *   pages the rest through a separate host (api.phillips.com) that the landing
 *   page calls from the browser. This pack stays on the documented, allowed
 *   HTML path and so returns those 24 most-recent past lots, alongside the
 *   `total_past_lots` count so a caller can see how much archive it is NOT
 *   seeing (Banksy: 24 of 272). That is a deliberate ceiling, not a bug.
 *
 * Third of three art houses surveyed, after mcps/bonhams and mcps/sothebys.
 * Tools are house-prefixed (phillips_*) so the three do not collide on one
 * name — see the README.
 */


const UA = 'pipeworx-mcp-phillips/1.0 (+https://pipeworx.io)';
const BASE = 'https://www.phillips.com';

async function pwFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(
    url,
    { ...init, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', ...(init?.headers ?? {}) } },
    'Phillips',
  );
}

/**
 * Department is not a field on the artist-page rows, but Phillips' sale
 * numbers encode it: <2-letter saleroom><2-digit department><2-digit sale
 * sequence><2-digit year>, e.g. UK010526 = London, department 01, sale 05,
 * 2026. Every one of the 892 past auctions listed on /auctions/past agreed
 * with this mapping when it was derived (2026-09-05).
 *
 * 00 and 09 are NOT departments — they are sale formats that run across
 * departments — so they are labelled as such rather than guessed at.
 */
const DEPARTMENTS: Record<string, string> = {
  '01': 'Modern & Contemporary Art',
  '03': 'Editions & Works on Paper',
  '04': 'Photographs',
  '05': 'Design',
  '06': 'Jewels',
  '07': 'Editions, Photographs and Design',
  '08': 'Watches',
  '09': 'Online Auction (mixed departments)',
  '00': 'Special / collaboration sale',
};

const SALEROOMS: Record<string, string> = {
  NY: 'New York',
  UK: 'London',
  HK: 'Hong Kong',
  CH: 'Geneva',
  GE: 'Geneva',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'phillips_results_search',
    description:
      "Look up realized prices for an artist or maker in Phillips' past-auction results. Returns that maker's most recent past lots with the realized price (hammer plus buyer's premium), the estimate range it sold against, currency, lot and sale number, saleroom, department and sale date. Phillips' keyword search is closed to crawlers, so this resolves the maker by NAME against Phillips' own artist index and reads their artist page — which means results are per-maker, and cover the 24 most recent past lots of the (reported) total. Optionally narrow by category/department, e.g. \"jewels\", \"watches\", \"editions\", \"photographs\", \"design\".",
    inputSchema: {
      type: 'object' as const,
      properties: {
        artist: {
          type: 'string',
          description: 'Artist or maker name, e.g. "Banksy", "Jean-Michel Basquiat", "Patek Philippe". Matched against Phillips\' artist index — exact match wins, otherwise the closest name is used and near-misses are returned in `alternatives`.',
        },
        artist_id: {
          type: 'number',
          description: "Optional Phillips makerId, e.g. 8845 for Banksy. Skips name resolution entirely — pass this back from a previous result's `artist_id` to save a round trip. Overrides `artist` when both are given.",
        },
        category: {
          type: 'string',
          description: 'Optional filter, matched against the department, saleroom, sale number and lot title, e.g. "jewels", "watches", "editions", "photographs", "design", "London".',
        },
        include_upcoming: {
          type: 'boolean',
          description: 'Also return the maker\'s upcoming (not yet sold) lots, which carry an estimate but no realized price. Default false.',
        },
        limit: { type: 'number', description: 'Max past lots to return (1-24, default 20).' },
      },
      required: [],
    },
  },
  {
    name: 'phillips_lot_details',
    description:
      "Full detail for one Phillips lot: work title, maker, lot number, realized price (hammer plus buyer's premium), hammer price, estimate range, currency, the sale it appeared in and its date, plus the catalogue image. Takes the `lot_id` from phillips_results_search.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        lot_id: {
          type: 'string',
          description: 'Phillips lot id (the `lot_id` / objectNumber from phillips_results_search), e.g. "233345".',
        },
        slug: {
          type: 'string',
          description: 'Optional artist slug for the URL, e.g. "banksy". Decorative — any value resolves the same lot; omit to use a placeholder.',
        },
      },
      required: ['lot_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'phillips_results_search':
      return resultsSearch(args);
    case 'phillips_lot_details':
      return lotDetails(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── artist name -> makerId, from Phillips' sitemap ──────────────────

interface ArtistEntry {
  id: number;
  name: string;
}

// Held for the life of the isolate so a second lookup does not refetch the
// 2 MB sitemap. Not persisted anywhere.
let artistIndex: ArtistEntry[] | null = null;

async function loadArtistIndex(): Promise<ArtistEntry[]> {
  if (artistIndex) return artistIndex;
  const url = `${BASE}/sitemap.xml`;
  const res = await pwFetch(url);
  if (!res.ok) throw new Error(`Phillips artist index: HTTP ${res.status} from ${url}`);
  const xml = await res.text();

  const out: ArtistEntry[] = [];
  const re = /<loc>\s*https?:\/\/[^/]*\/artist\/(\d+)\/([^<]*)<\/loc>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const id = Number(m[1]);
    // Sitemap names arrive percent-encoded AND HTML-escaped
    // ("Jennifer%20&amp;%20Kevin%20McCoy"), so both layers come off here.
    // Storing the decoded name and encoding once at URL-build time is what
    // keeps "Jean-Michel Basquiat" from going out as "Jean-Michel%2520Basquiat".
    const name = safeDecodeUri(decode(m[2])).trim();
    if (!Number.isFinite(id) || !name) continue;
    out.push({ id, name });
  }
  if (!out.length) throw new Error('Phillips artist index: the sitemap returned no /artist/ URLs — the site layout may have changed.');
  artistIndex = out;
  return out;
}

interface ArtistMatch {
  chosen: ArtistEntry;
  alternatives: { artist: string; artist_id: number }[];
}

function matchArtist(index: ArtistEntry[], query: string): ArtistMatch | null {
  const q = norm(query);
  const exact = index.filter((a) => norm(a.name) === q);
  const starts = index.filter((a) => norm(a.name).startsWith(q));
  const contains = index.filter((a) => norm(a.name).includes(q));
  // Prefer an exact name, then a prefix, then any substring. Within a tier the
  // shortest name wins: "Banksy" should beat "After Banksy" and "Banksy and
  // Damien Hirst" for the query "banksy".
  const tier = exact.length ? exact : starts.length ? starts : contains;
  if (!tier.length) return null;
  const ranked = [...tier].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return {
    chosen: ranked[0],
    alternatives: ranked.slice(1, 8).map((a) => ({ artist: a.name, artist_id: a.id })),
  };
}

// ── phillips_results_search ─────────────────────────────────────────

interface Lot {
  lot_id: string;
  title: string;
  artist: string;
  artist_id: number | null;
  lot_number: string;
  sale_number: string;
  saleroom: string | null;
  department: string | null;
  sale_date: string | null;
  currency: string;
  estimate_low: number | null;
  estimate_high: number | null;
  realized_price_inc_premium: number | null;
  sold: boolean;
  url: string;
  image_url: string | null;
}

async function resultsSearch(args: Record<string, unknown>): Promise<unknown> {
  const artistArg = strArg(args.artist);
  const idArg = numOrNull(args.artist_id) ?? (strArg(args.artist_id) ? Number(strArg(args.artist_id)) : null);
  const category = strArg(args.category).toLowerCase();
  const includeUpcoming = args.include_upcoming === true || args.include_upcoming === 'true';
  const limit = clamp(numArg(args.limit, 20), 1, 24);

  if (!artistArg && !(idArg && Number.isFinite(idArg))) {
    throw new Error('Pass artist (a maker name, e.g. "Banksy") or artist_id (a Phillips makerId, e.g. 8845).');
  }

  let makerId: number;
  let slug = 'artist';  // decorative: any non-empty segment resolves the id
  let alternatives: { artist: string; artist_id: number }[] = [];
  let resolvedFrom: string | null = null;

  if (idArg && Number.isFinite(idArg)) {
    makerId = Math.trunc(idArg);
  } else {
    const index = await loadArtistIndex();
    const match = matchArtist(index, artistArg);
    if (!match) {
      throw new Error(`Phillips has no artist matching "${artistArg}" in its public artist index (${index.length} makers). Try a surname on its own, or a different spelling.`);
    }
    makerId = match.chosen.id;
    slug = match.chosen.name;
    alternatives = match.alternatives;
    resolvedFrom = match.chosen.name;
  }

  const url = `${BASE}/artist/${makerId}/${encodeURIComponent(slug)}`;
  const res = await pwFetch(url);
  if (!res.ok) throw new Error(`Phillips artist ${makerId}: HTTP ${res.status} from ${url}`);
  const html = await res.text();

  const props = extractHydrationProps(html, 'ArtistLanding');
  if (!props) {
    throw new Error(`Phillips artist ${makerId}: the artist page carried no lot data — the page layout may have changed.`);
  }
  const maker = parseNested(props.maker);
  if (!maker) throw new Error(`Phillips artist ${makerId}: the artist page's maker record could not be read.`);

  const pastPage = asRecord(maker.pastLots);
  const upcomingPage = asRecord(maker.upcomingLots);
  const makerName = str(maker.makerName) || resolvedFrom || artistArg;

  let past = (Array.isArray(pastPage?.data) ? pastPage!.data : []).map((r) => mapLot(r, makerId, makerName)).filter(isLot);
  let upcoming = includeUpcoming
    ? (Array.isArray(upcomingPage?.data) ? upcomingPage!.data : []).map((r) => mapLot(r, makerId, makerName)).filter(isLot)
    : [];

  if (category) {
    past = past.filter((l) => matchesCategory(l, category));
    upcoming = upcoming.filter((l) => matchesCategory(l, category));
  }

  return {
    source: url,
    artist: makerName,
    artist_id: makerId,
    artist_nationality: str(maker.nationality) || null,
    artist_birth_year: str(maker.birthYear) || null,
    query: artistArg || null,
    category_filter: category || null,
    // What the caller is NOT seeing: Phillips pages past lots 24 at a time and
    // serves page 2 onward from a different host, so this is the first page.
    total_past_lots: numOrNull(pastPage?.totalCount),
    returned_past_lots: Math.min(past.length, limit),
    results: past.slice(0, limit),
    upcoming_lots: includeUpcoming ? upcoming : undefined,
    alternatives: alternatives.length ? alternatives : undefined,
  };
}

function matchesCategory(l: Lot, category: string): boolean {
  return [l.department, l.saleroom, l.sale_number, l.title].some((f) => (f ?? '').toLowerCase().includes(category));
}

function mapLot(raw: unknown, makerId: number, fallbackMaker: string): Lot | null {
  const r = asRecord(raw);
  if (!r) return null;
  const lotId = str(r.objectNumber);
  if (!lotId) return null;
  const saleNumber = str(r.saleNumber);
  const realized = numOrNull(r.hammerPlusBP);
  const path = str(r.detailPath) || `/detail/lot/${lotId}`;
  return {
    lot_id: lotId,
    title: decode(str(r.description)),
    artist: decode(str(r.makerName)) || fallbackMaker,
    artist_id: numOrNull(r.makerId) ?? makerId,
    lot_number: str(r.lotNumberFull).trim() || str(r.lotNumber),
    sale_number: saleNumber,
    saleroom: salesroomOf(saleNumber),
    department: departmentOf(saleNumber),
    sale_date: str(r.auctionStartDateTimeOffset) || null,
    currency: str(r.currencySign),
    estimate_low: numOrNull(r.lowEstimate),
    estimate_high: numOrNull(r.highEstimate),
    // Phillips reports 0 for a lot that did not sell; that is an absence of a
    // price, not a price of zero.
    realized_price_inc_premium: realized && realized > 0 ? realized : null,
    sold: !!(realized && realized > 0),
    url: path.startsWith('http') ? path : `${BASE}${path}`,
    image_url: str(r.imagePath) || null,
  };
}

function departmentOf(saleNumber: string): string | null {
  return /^[A-Za-z]{2}\d{6}$/.test(saleNumber) ? (DEPARTMENTS[saleNumber.slice(2, 4)] ?? null) : null;
}
function salesroomOf(saleNumber: string): string | null {
  return /^[A-Za-z]{2}\d{6}$/.test(saleNumber) ? (SALEROOMS[saleNumber.slice(0, 2).toUpperCase()] ?? null) : null;
}

// ── phillips_lot_details ────────────────────────────────────────────

async function lotDetails(args: Record<string, unknown>): Promise<unknown> {
  const lotId = strArg(args.lot_id);
  if (!lotId) throw new Error('lot_id is required (the `lot_id` from phillips_results_search, e.g. "233345").');
  const slug = strArg(args.slug) || 'lot';

  const url = `${BASE}/detail/${encodeURIComponent(slug)}/${encodeURIComponent(lotId)}`;
  const res = await pwFetch(url);
  if (!res.ok) throw new Error(`Phillips lot ${lotId}: HTTP ${res.status} from ${url}`);
  const html = await res.text();

  const product = findProductLd(html);
  if (!product) {
    throw new Error(`Phillips lot ${lotId}: no lot record on that page — the id may not exist.`);
  }
  const offers = asRecord(product.offers);

  // The realized price is rendered into the page but is NOT in the JSON-LD
  // (whose `offers.price` is the LOW ESTIMATE, which is why it is not used as
  // a price here). Read the rendered "Sold for" line instead.
  const soldText = textOf(sliceAround(html, 'seldon-bid-snapshot__sold', 0, 900));
  const sold = parseMoney(soldText);
  const saleNumber = (html.match(/auction-assets\/([A-Z]{2}\d{6})\//) ?? [])[1] ?? '';

  // The estimate is rendered too, and must be read from there rather than from
  // the state blob: the blob's only `lowEstimate`/`highEstimate` pair belongs
  // to its CURRENCY-CONVERSION table (HK$622,000-830,000 for this lot), not to
  // the sale currency. Reading the blob here silently returns a real number
  // that is the wrong currency and roughly 10x out.
  const estimate = parseEstimate(textOf(sliceAround(html, 'pah-lot-estimate__value', 300, 300)));

  const currency = str(offers?.priceCurrency) || sold?.currency || '';
  const availability = str(offers?.availability);
  const saleName = decode(str(product.name));
  const artist = decode(str(asRecord(product.brand)?.name));
  // Phillips titles the JSON-LD Product "<maker> - <sale name>"; the maker is
  // already its own field.
  const sale = artist && saleName.startsWith(`${artist} - `) ? saleName.slice(artist.length + 3) : saleName;
  const realized = sold?.amount ?? blobNumber(html, 'soldPrice');
  const hammer = blobNumber(html, 'hammerPrice');

  return {
    source: url,
    lot_id: lotId,
    title: decode(str(product.description)),
    artist,
    lot_number: (html.match(/seldon-breadcrumb--current"[^>]*>\s*Lot\s+([^<]+?)\s*</) ?? [])[1] ?? null,
    sale,
    sale_number: saleNumber || null,
    saleroom: salesroomOf(saleNumber),
    department: departmentOf(saleNumber),
    sale_date: blobString(html, 'auctionStartDateTime'),
    currency,
    currency_symbol: sold?.currency ?? estimate?.currency ?? null,
    estimate_low: estimate?.low ?? numOrNull(offers?.price),
    estimate_high: estimate?.high ?? null,
    realized_price_inc_premium: realized,
    // Hammer is only in the state blob, which is a flat key-then-value array
    // rather than an addressable object. Drop it rather than report it if it
    // fails the one invariant that always holds — hammer <= hammer + premium.
    hammer_price: hammer !== null && (realized === null || hammer <= realized) ? hammer : null,
    sold: availability ? availability.includes('SoldOut') : sold !== null,
    image_url: Array.isArray(product.image) ? (str(product.image[0]) || null) : str(product.image) || null,
  };
}

/** JSON-LD on the lot page is a mix of Organization/BreadcrumbList/Product. */
function findProductLd(html: string): Record<string, unknown> | null {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const graph = asRecord(parsed);
    const nodes = Array.isArray(graph?.['@graph']) ? (graph!['@graph'] as unknown[]) : [parsed];
    for (const n of nodes) {
      const rec = asRecord(n);
      if (rec && rec['@type'] === 'Product') return rec;
    }
  }
  return null;
}

/**
 * The lot page ships its state as a flattened, backslash-escaped array where a
 * key string is followed by its value. There is no addressable JSON object to
 * parse, so these two read the value that follows a known key — used only for
 * fields the rendered HTML does not carry (hammer price, sale datetime).
 */
function blobNumber(html: string, key: string): number | null {
  const m = html.match(new RegExp(`\\\\"${key}\\\\",(-?\\d+(?:\\.\\d+)?)`));
  return m ? numOrNull(Number(m[1])) : null;
}
function blobString(html: string, key: string): string | null {
  const m = html.match(new RegExp(`\\\\"${key}\\\\",\\\\"([^\\\\"]+)`));
  return m ? m[1] : null;
}

/** "Estimate £60,000–80,000" -> { currency: "£", low: 60000, high: 80000 } */
function parseEstimate(text: string): { currency: string; low: number; high: number } | null {
  const m = text.match(/Estimate\s*([^\d\s]{0,3})\s*([\d,]+)\s*[\u2013\u2014-]\s*([^\d\s]{0,3})\s*([\d,]+)/i);
  if (!m) return null;
  const low = Number(m[2].replace(/,/g, ''));
  const high = Number(m[4].replace(/,/g, ''));
  return Number.isFinite(low) && Number.isFinite(high) ? { currency: m[1].trim(), low, high } : null;
}

/** "Sold For £122,550" -> { currency: "£", amount: 122550 } */
function parseMoney(text: string): { currency: string; amount: number } | null {
  const m = text.match(/Sold\s*For\s*([^\d\s]{0,3})\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(amount) ? { currency: m[1].trim(), amount } : null;
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Phillips hydrates its pages with
 * `React.createElement(PhillipsReact.<Name>, {…props…})`. Pull that props
 * object out by scanning for its balanced closing brace — the props contain
 * nested braces and quoted braces, so an index-of on `}` does not do.
 */
function extractHydrationProps(html: string, component: string): Record<string, unknown> | null {
  const marker = `PhillipsReact.${component},`;
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return asRecord(JSON.parse(html.slice(start, i + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** `maker` arrives as a JSON string nested inside the props object. */
function parseNested(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string') return asRecord(v);
  try {
    return asRecord(JSON.parse(v));
  } catch {
    return null;
  }
}

function sliceAround(html: string, marker: string, before: number, after: number): string {
  const i = html.indexOf(marker);
  if (i < 0) return '';
  return html.slice(Math.max(0, i - before), i + after);
}
function textOf(html: string): string {
  return decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}
function isLot(l: Lot | null): l is Lot {
  return l !== null;
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
