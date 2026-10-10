// The editor driver (proof/editors): one long-lived Node process per test
// session that drives HQ's editor pages in the image's Chromium.
//
// It speaks JSON lines with the Python client (proof/editors/client.py) on
// stdin and stdout, and writes nothing else to stdout. The protocol keeps
// Python single-threaded with HQ: every request a page makes to HQ is handed
// to Python while Python waits on the operation, and answered with HQ's
// response.
//
// - On start, once Chromium is up: {"ready": true, "chromium", "playwright",
//   "origin", "port", "navigationHeaders", ...}. `navigationHeaders` are the
//   headers Chromium sends with a top-level navigation to the origin (read
//   from a probe navigation the driver answers itself), so Python can answer
//   a page's navigation exactly as the page will ask for it; `port` is the
//   loopback port the origin listens on.
// - Python sends one operation at a time: {"id", "op", "deadlineMs", ...}.
// - While it runs, the driver may send {"hq": {"rid", "method", "url",
//   "headers", "bodyBase64", "phase", "forwarded"}}; Python answers each with
//   {"reply": rid, "status", "headers": [[name, value], ...], "bodyBase64"}
//   before anything else happens in the page that waits on it. A view
//   operation also sends {"phase": {"pid", "name", "event"}} as it starts and
//   ends each section, and waits for {"phaseReady": pid} before it goes on;
//   that wait is Python's work, and moves the operation's deadline on by as
//   long as it took (Python's own deadline for the operation likewise).
// - The operation ends with {"id", "ok": true, "result"} or {"id", "ok":
//   false, "error": {"kind", "message", ...}}; by then every request the page
//   made has been answered or abandoned.
//
// Operations:
// - "run": a fresh browser context (so no page's module state, storage or
//   cookies reach the next) holding the given "cookies", whose every request
//   is routed through Playwright; then the given steps in order: "goto" (a
//   page, failing the run when HQ answers it with an error status),
//   "waitFor" (a page expression, looked at in the page until it holds; one
//   whose value is a function is that function, called with "arg" at every
//   look, which Playwright's own string form does not do: waiterExpression),
//   "eval" (a page function called with "arg", its value kept), "call" and
//   "until" (a step file of proof/editors/driver/steps called with "arg":
//   once, its value kept, or until it holds), "dispatch" (an event on the
//   elements a selector finds), "click" (the element's own click),
//   "files" and "draw" (the element a step file finds, called with
//   `find`, given a chosen file, or the pointer pressed, moved through
//   "stroke" and released, each point a fraction of its box and optionally
//   pixels more; or, with "drag", dragged that many pixels from its middle
//   in strokes that stay inside it and the window, each followed by the
//   page's answer to it, "answeredBy", and the page quiet),
//   "mark" (the page's answered requests counted, for an "awaitRequest"
//   with "sinceMark", which then waits for one answered after the mark, and
//   with "unlessMissed" is skipped where the wait that a step allowed to
//   miss before it missed, or held with a value other than true),
//   "awaitRequest" (until the page's request to a path has been answered;
//   with "orDialog", or until the page answers the last click with a dialog
//   and sends nothing, the outcome's "unsent" naming the dialog, after which
//   every step marked "unlessUnsent" is skipped),
//   "advance" (a step file asked again and again as a wait's predicate,
//   each "next" it answers followed by the page's answer to the request it
//   caused, "answeredBy", and the page quiet, until it answers otherwise:
//   a form shown one question a screen stepped forward by its own Next;
//   its last answer the outcome's value, any but true and those "passes"
//   names skipping to "orSkipTo"),
//   "followRedirect" (that, and when HQ's answer sent the page elsewhere,
//   until the redirected document has loaded) and "settle" (until none of
//   the page's requests is in flight, a frame and a task later still; with
//   "timers", and none of the page's own short timers still set). With
//   "seed" ({seed, epoch}) the context runs steps/page/seed.js before each
//   document's own scripts, and with "timers" steps/page/timers.js, which
//   counts the page's short one-off timers. Every document of every page
//   the driver opens first runs steps/page/polls.js, which holds the page's
//   polls.
// - "view": one load of an app-manager page on the driver's reused view
//   page, every offered section's save held and then released into its own
//   phase (see below).
// - "vellum": a form opened and saved in Vellum, on the driver's warm Vellum
//   host when it may reuse it, on a fresh load of the host otherwise (and
//   with "fresh"). The host is kept for the next form only after a clean run
//   whose page loaded no image from HQ (runVellum).
// - "idle": lets a reused page ("page": "views" or "vellum") sit idle for
//   "virtualMs" of Chromium's virtual time with no operation serving it, for
//   the driver's own tests of what a page sends once its operation is over
//   (see runIdle).
// - "static": registers a file the origin serves under /static/ beside the
//   editors' static directory (the JavaScript translation catalog HQ's
//   deployment compiles).
// - "stats": what the driver has done (operations, loads and pages per reused
//   page, the static files the origin answered each, and the stray requests
//   it refused).
// - "shutdown": closes Chromium and exits.
//
// The driver keeps two pages across operations, each in a browser context of
// its own: one for views, one for the Vellum host, so a view never takes the
// warm Vellum instance away. Both talk to a real HTTP origin: Chromium
// resolves hq.proof.test to this process's own server
// (`--host-resolver-rules`, which keeps the origin's port the default one and
// fails every other name), so requests take the browser's ordinary network
// path. The origin is not a secure context, so Chromium sends no Sec-Fetch-*
// header; a navigation is the request that carries Upgrade-Insecure-Requests.
// Every request a reused page sends names the page (the `x-proof-page`
// header its context adds, which the origin strips before anything reads
// the request), and the origin serves it to that page's own operation and
// to nothing else. The server serves /static/ from the editors' static
// directory as immutable (a missing file is an immutable 404 of its own),
// gives a frame the page embeds (another page, such as App Preview: any
// navigation other than the view's own and the one HQ's redirect asks for)
// an empty document,
// and hands every other request to Python, sending HQ's answer with
// `Cache-Control: no-store`. A request for HQ that arrives while its page has
// no operation running (a timer the page kept past its operation, which a
// fresh page's closed context would never have run) is a stray: the origin
// refuses it unanswered, the page is loaded afresh before its next use, and
// the operation that is running, or the next one, fails naming it. A request
// to another origin fails to resolve and is recorded from Playwright's
// `requestfailed`. Before each load the page leaves for about:blank, the
// origin's storage and the context's cookies are cleared, the run's cookies
// are set, and the run's seed script (steps/page/seed.js) replaces the last
// one. A page is replaced after a failure and every RECYCLE_LOADS
// operations (the Vellum host every VELLUM_RECYCLE_RUNS), which bounds the
// garbage its renderer keeps.
//
// Every page expression the driver evaluates (a step file's function, a
// wait) is evaluated in the page's own scripts' world through a DevTools
// session of the driver's own (pageValue), as Playwright's page.evaluate
// evaluates one (a promise awaited, run as a person's gesture), without
// Playwright's utility and injected scripts; a wait is one evaluation that
// looks in the page, once at once and then each animation frame, as
// Playwright's waitForFunction looks (waitInPage).
//
// The driver counts each page's requests in flight on that same session
// (PageRequests): Chromium reports a request as the page starts it
// (Network.requestWillBeSent), before it reaches the origin, and again when
// it has finished or failed (Network.loadingFinished, Network.loadingFailed);
// it reports neither for the requests a document still had when its frame
// commits another, so a main-frame commit drops the old document's requests
// and a detached frame takes its own with it. A page is quiet only when none
// of its requests is in flight and none the origin forwarded is unanswered,
// a frame and a task later still.
//
// A view: the page loads once; then for each section, in the order given, the
// driver arms it (steps/pages/armed.js, until its bar reads "Save"), reads
// its state (steps/pages/save_state.js), clicks Save and holds the save
// request it sends, unanswered. Once the page is quiet but for the held
// saves, they are released one at a time: the driver reads the section's
// state, opens its phase (Python enters its fork), forwards the save, lets
// every request that follows it reach Python in that phase, waits until the
// section's bar has left "Saving" (steps/pages/saved.js) and the page is
// quiet but for the saves still held, reads its state again, and closes the
// phase. A save whose answer navigates the page (HQ's `redirect`,
// app_manager.js::_initSaveButtons) is followed, as a fresh page follows it,
// and the sections still held are abandoned and reported so. The view ends
// with the page sent to about:blank, as a fresh page's context ends by
// closing: nothing of the view runs after it.

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";

const TOOLS = process.env.PROOF_TOOLS ?? "/opt/proof-tools";
const EDITORS = process.env.PROOF_EDITORS ?? "/opt/editors";
const HOST = "hq.proof.test";
const ORIGIN = `http://${HOST}`;
const STATIC_PREFIX = "/static/";
// How the origin answers for the image's static files: never to be asked
// again while Chromium's cache holds the answer.
const STATIC_CACHE_CONTROL = "public, max-age=31536000, immutable";
const STATIC_DIR = path.join(EDITORS, "static");
const STEPS_DIR = path.join(import.meta.dirname, "steps");
const PROBE_PATH = "/proof-driver/probe";
const VELLUM_HOST = "/static/vellum/host.html";
// A reused page's renderer keeps each document it leaves until V8's next full
// collection, which a renderer with memory to spare runs late: the renderer
// passed 3.5 GB in 250 loads of module and form views. A full collection
// forced through DevTools (HeapProfiler.collectGarbage) bounds that, but
// costs about half a CPU-second each (measured: one every 10 loads cost 9 to
// 14% of every view's CPU). So the driver bounds a page's memory by
// replacing it instead: the views page every RECYCLE_LOADS loads (measured
// over 124 module, form and app settings views: a peak of 1.1 GB for the
// driver and its Chromium, against 0.9 GB with a forced collection every 10
// loads, at 9% less CPU a view). The warm Vellum host keeps more than
// garbage: every instance leaves listeners on the document and window that
// it never removes (vellum.py), and with them the instance, about 0.9 MB a
// run (measured: the driver's processes grew from 450 to 670 MB over 250
// warm runs), so it is replaced every VELLUM_RECYCLE_RUNS runs. With
// PROOF_EDITORS_RECYCLE_LOADS set, both pages are replaced that often.
const RECYCLE_LOADS = Number(process.env.PROOF_EDITORS_RECYCLE_LOADS ?? 25);
const VELLUM_RECYCLE_RUNS = Number(
	process.env.PROOF_EDITORS_RECYCLE_LOADS ?? 50,
);
// With PROOF_EDITORS_LATENCY_MS set, Chromium adds that much latency to every
// request a reused page sends (a slow network between the browser and HQ),
// for the driver's own tests of when a page is quiet.
const LATENCY_MS = Number(process.env.PROOF_EDITORS_LATENCY_MS ?? 0);
// Chromium opens at most six connections per host; a view holds at most this
// many saves at once, so the page always has one for anything else.
const MAX_HELD = 5;
// With PROOF_EDITORS_TRACE set, each step is written to stderr as it starts.
const TRACE = Boolean(process.env.PROOF_EDITORS_TRACE);
// The header naming the reused page a request comes from (its context's extra
// HTTP header). It is the driver's, so the origin strips it with the transport's.
const PAGE_HEADER = "x-proof-page";
// Request headers Chromium manages per connection, and the driver's own; they
// are not the page's.
const TRANSPORT_HEADERS = new Set(["host", "connection", PAGE_HEADER]);
// HQ's response headers the origin's own transport replaces.
const HOP_HEADERS = new Set([
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"cache-control",
]);

const tools = createRequire(path.join(TOOLS, "package.json"));
const { chromium } = tools("playwright-core");

// The web font HQ's pages load (hqwebapp/base.html links Google Fonts'
// stylesheet for Nunito Sans, the face HQ's stylesheets name first), served
// from the image (the font's own package, OFL-1.1, among the image's Node
// tools) where the page asks Google for it, so the page lays its text out in
// HQ's face; every other host stays refused.
const FONTS_ORIGIN = "https://fonts.googleapis.com";
const FONTS = {
	"Nunito Sans": path.dirname(
		tools.resolve("@fontsource/nunito-sans/package.json"),
	),
};

/**
 * Google Fonts' answer to a request of its stylesheet (`/css?family=Name:w1,w2`,
 * `|` between families) or of a font file the stylesheet names (relative to
 * it, `/files/<file>`), from the fonts the image holds: each weight asked for
 * that the font has, in the order asked; null for anything else.
 */
async function webFont(url) {
	if (url.pathname === "/css") {
		const sheets = [];
		for (const asked of (url.searchParams.get("family") ?? "").split("|")) {
			const [family, weights = "400"] = asked.split(":");
			const directory = FONTS[family];
			if (!directory) return null;
			for (const weight of weights.split(",")) {
				const file = path.join(directory, `${weight}.css`);
				const found = await readFile(file, "utf8").catch(() => null);
				if (found !== null) sheets.push(found);
			}
		}
		if (!sheets.length) return null;
		return {
			contentType: "text/css; charset=utf-8",
			body: Buffer.from(sheets.join("\n")),
		};
	}
	const name = url.pathname.startsWith("/files/")
		? url.pathname.slice("/files/".length)
		: null;
	if (!name || name.includes("/")) return null;
	for (const directory of Object.values(FONTS)) {
		const body = await readFile(path.join(directory, "files", name)).catch(
			() => null,
		);
		if (body !== null)
			return {
				contentType: name.endsWith(".woff2") ? "font/woff2" : "font/woff",
				body,
			};
	}
	return null;
}
const playwrightVersion = tools("playwright-core/package.json").version;

const CONTENT_TYPES = {
	".js": "application/javascript; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".gif": "image/gif",
	".svg": "image/svg+xml",
};

// stdout is the protocol; nothing else may write to it.
const protocolOut = process.stdout;
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;

function send(message) {
	protocolOut.write(`${JSON.stringify(message)}\n`);
}

function trace(text) {
	if (TRACE) console.error(text);
}

class StepFailed extends Error {
	constructor(kind, message, detail = {}) {
		super(message);
		this.kind = kind;
		Object.assign(this, detail);
	}
}

// -- step files --------------------------------------------------------------

/**
 * `value` as a JavaScript literal inside an expression the driver hands the
 * page: its JSON, with every character that could end a script element or a
 * line in a context that reads the text another way escaped (CodeQL's
 * js/bad-code-sanitization), each to the escape that denotes it, so the
 * literal is the same value.
 */
function literal(value) {
	return JSON.stringify(value).replace(
		/[<>/\u2028\u2029]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const stepSources = new Map();

/** A step file's function, as a page expression. Names are "<folder>/<file>". */
function stepSource(name) {
	if (!/^[a-z]+\/[a-z_]+$/.test(name)) {
		throw new StepFailed(
			"request",
			`"${name}" is not a step file name; step files are named "<folder>/<file>" under ${STEPS_DIR}.`,
		);
	}
	if (!stepSources.has(name)) {
		const file = path.join(STEPS_DIR, `${name}.js`);
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			throw new StepFailed(
				"request",
				`The driver has no step file ${file} (${error.code ?? error.message}).`,
			);
		}
		stepSources.set(name, text.trim().replace(/;$/, ""));
	}
	return stepSources.get(name);
}

/** The page expression calling a step file's function with `arg`. */
function stepCall(name, arg) {
	return `(${stepSource(name)})(${literal(arg ?? null)})`;
}

/**
 * The page expression reading a section's state (steps/pages/save_state.js)
 * once its save is over on the page (steps/pages/saved.js), and null while
 * it is not.
 */
function settledState(bar) {
	return `((saved, state, bar) => (saved(bar) ? state(bar) : null))(${stepSource("pages/saved")}, ${stepSource("pages/save_state")}, ${literal(bar)})`;
}

// -- Python ------------------------------------------------------------------

let nextReplyId = 1;
const pendingReplies = new Map();
let nextPhaseId = 1;
const pendingPhases = new Map();

/** Asks Python to answer one request with HQ, and waits for its reply. */
function askHq(request) {
	const rid = nextReplyId++;
	return new Promise((resolve, reject) => {
		pendingReplies.set(rid, { resolve, reject });
		send({ hq: { rid, ...request } });
		trace(
			`asked HQ ${rid} (${request.phase}): ${request.method} ${request.url}`,
		);
	});
}

/**
 * Tells Python a phase starts or ends, and waits until Python is ready for
 * what follows. The wait is Python's own work (the caller's fork opened, or
 * what HQ's state holds after a section read and served to Formplayer and
 * the Web Apps client), not the page's, so `served`'s deadline, which
 * catches a stuck page, is moved on by as long as it took.
 */
async function announcePhase(served, name, event, detail = {}) {
	const pid = nextPhaseId++;
	const started = Date.now();
	const ready = await new Promise((resolve, reject) => {
		pendingPhases.set(pid, { resolve, reject });
		send({ phase: { pid, name, event, ...detail } });
		trace(`phase ${pid}: ${name} ${event}`);
	});
	served.deadline += Date.now() - started;
	return ready;
}

// -- the origin --------------------------------------------------------------

const staticCache = new Map();
const registeredStatics = new Map();

async function staticFile(pathname) {
	if (registeredStatics.has(pathname)) return registeredStatics.get(pathname);
	if (staticCache.has(pathname)) return staticCache.get(pathname);
	const relative = decodeURIComponent(pathname.slice(STATIC_PREFIX.length));
	const file = path.resolve(STATIC_DIR, relative);
	let found = null;
	if (file.startsWith(STATIC_DIR + path.sep)) {
		try {
			if ((await stat(file)).isFile()) {
				found = {
					body: await readFile(file),
					contentType:
						CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
				};
			}
		} catch {
			found = null;
		}
	}
	staticCache.set(pathname, found);
	return found;
}

/** The events of the driver's HTTP exchanges, numbered in one sequence, so overlaps can be read after. */
let tick = 0;
const nextTick = () => ++tick;

let server;
let serverPort;
let probeHeaders = null;
// The operation the driver is running ("view", "vellum", "run"), or null.
let runningOp = null;
// Every stray request the origin refused, and those no operation has failed
// on yet: the running operation, or the next one, fails naming them.
const strays = [];
let unreportedStrays = [];

function pageHeaders(request) {
	const headers = {};
	for (const [name, value] of Object.entries(request.headers)) {
		if (!TRANSPORT_HEADERS.has(name)) headers[name] = value;
	}
	return headers;
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return chunks.length ? Buffer.concat(chunks) : null;
}

function respond(response, status, headers, body) {
	if (response.destroyed || response.writableEnded) return;
	response.writeHead(status, headers);
	response.end(body);
}

async function handleRequest(request, response) {
	const url = new URL(request.url, ORIGIN);
	const body = await readBody(request);
	if (url.pathname === PROBE_PATH) {
		probeHeaders = pageHeaders(request);
		respond(response, 200, { "content-type": "text/html; charset=utf-8" }, "");
		return;
	}
	// The operation this request belongs to: its own page's, and only while
	// that page is serving one.
	const named = request.headers[PAGE_HEADER];
	const owner = REUSED_PAGES.get(named) ?? RUN_PAGES.get(named) ?? null;
	const served = owner?.serving ?? null;
	if (url.pathname.startsWith(STATIC_PREFIX)) {
		// The image's own files change nothing in HQ, whenever a page asks;
		// what Chromium's cache already holds decides whether it does. A file
		// the image lacks is as fixed as one it has (HQ's stylesheets, which
		// every view asks for), so its 404 is kept in Chromium's cache too.
		const file = await staticFile(url.pathname);
		const answeredBy = file ? "editors" : "missing";
		served?.record({
			method: request.method,
			url: url.href,
			answeredBy,
			status: file ? 200 : 404,
		});
		if (owner) owner.statics[answeredBy]++;
		if (file) {
			respond(
				response,
				200,
				{
					"content-type": file.contentType,
					"cache-control": STATIC_CACHE_CONTROL,
				},
				file.body,
			);
		} else {
			respond(
				response,
				404,
				{ "content-type": "text/plain", "cache-control": STATIC_CACHE_CONTROL },
				"",
			);
		}
		return;
	}
	if (!served) {
		refuseStray(request, response, url, owner);
		return;
	}
	await served.handle({ request, response, url, body });
}

/**
 * Refuses a request for HQ that no operation of its page is serving, unanswered.
 * Its page is closed (its next operation opens a new one), and the running
 * operation, or the next one, fails naming it.
 */
function refuseStray(request, response, url, owner) {
	const stray = {
		page: owner?.name ?? request.headers[PAGE_HEADER] ?? null,
		method: request.method,
		path: url.pathname + url.search,
		during: runningOp,
	};
	strays.push(stray);
	unreportedStrays.push(stray);
	if (owner) {
		// The page has no operation: whatever it still runs is stopped now,
		// and its next operation opens a new page.
		owner.broken = true;
		owner.close().catch(() => {});
	}
	trace(`refused a stray request: ${JSON.stringify(stray)}`);
	respond(response, 503, { "cache-control": "no-store" }, "");
}

/** The strays no operation has failed on yet, as the failure of the operation that takes them (null when none). */
function takeStrays() {
	if (!unreportedStrays.length) return null;
	const taken = unreportedStrays;
	unreportedStrays = [];
	const described = taken
		.map(
			(stray) =>
				`${stray.method} ${stray.path} from ${stray.page === null ? "no page the driver keeps" : `the ${stray.page} page`}` +
				(stray.during
					? ` while the ${stray.during} operation was running`
					: " between operations"),
		)
		.join("; ");
	return new StepFailed(
		"stray",
		`HQ's origin was sent ${taken.length === 1 ? "a request" : `${taken.length} requests`} that no operation of the sending page was serving, and refused ${taken.length === 1 ? "it" : "them"} unanswered: ${described}. A page the driver keeps between operations makes no request for HQ once its operation has ended (a fresh page's context would be closed by then), so something the page started outlived its operation; the page is loaded afresh before its next use.`,
		{ strays: taken },
	);
}

/** An operation's failure with the strays no operation has failed on yet added to it; a failure of their own when it had none. */
function withStrays(failure) {
	const stray = takeStrays();
	if (!stray) return failure;
	if (!failure) return stray;
	return Object.assign(
		new StepFailed(
			failure instanceof StepFailed ? failure.kind : timeoutKind(failure),
			`${failure.message}\n${stray.message}`,
		),
		{
			strays: stray.strays,
			outcomes: failure.outcomes,
			failedStep: failure.failedStep,
		},
	);
}

/** Sends HQ's answer to the page, with the origin's own transport headers. */
function deliver(response, reply) {
	const headers = { "cache-control": "no-store" };
	const cookies = [];
	for (const [name, value] of reply.headers) {
		const key = name.toLowerCase();
		if (HOP_HEADERS.has(key)) continue;
		if (key === "set-cookie") cookies.push(value);
		else
			headers[key] =
				headers[key] === undefined ? value : `${headers[key]}, ${value}`;
	}
	if (cookies.length) headers["set-cookie"] = cookies;
	respond(
		response,
		reply.status,
		headers,
		Buffer.from(reply.bodyBase64 ?? "", "base64"),
	);
}

// -- a page's requests in flight ---------------------------------------------

/**
 * What the page threw, as its error text: an Error's own description (its
 * name, message and stack, as V8 prints it), or the thrown value itself
 * where it is no Error. Vellum throws strings (parser.js::_getInstances,
 * tree.js), which Playwright's pageerror hands on as an Error it makes by
 * splitting the text at its first colon and with no stack, so the driver
 * reads the exception from DevTools (Runtime.exceptionThrown) instead.
 */
function thrownText(details) {
	const thrown = details.exception;
	if (!thrown) return String(details.text ?? "");
	if (thrown.type === "string") return thrown.value;
	if (thrown.description !== undefined) return thrown.description;
	return "value" in thrown ? String(thrown.value) : thrown.type;
}

/**
 * Hands `onError` the text of every exception the page leaves uncaught
 * (thrownText), as it is thrown, through a DevTools session of the driver's
 * own, which this enables the runtime domain on.
 */
async function watchPageErrors(cdp, onError) {
	cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
		onError(thrownText(exceptionDetails)),
	);
	await cdp.send("Runtime.enable");
}

/**
 * A page's requests in flight, as Chromium reports them to a DevTools session
 * of the driver's own: from the moment the page starts one
 * (Network.requestWillBeSent, sent before the request reaches the network)
 * until it has finished or failed (Network.loadingFinished,
 * Network.loadingFailed). Chromium reports neither for the requests a
 * document still had when its frame commits another document (Playwright's
 * frames drop those the same way), so a main-frame commit
 * (Page.frameNavigated) keeps only the new document's own, and a frame that
 * is detached takes its requests with it. One session sees all of these in
 * the order the page made them. Each entry is {method, url}.
 */
class PageRequests {
	constructor(onChange) {
		this.entries = new Map();
		this.onChange = onChange;
	}

	static async attach(cdp, onChange) {
		const requests = new PageRequests(onChange);
		cdp.on("Network.requestWillBeSent", (event) => {
			requests.entries.set(event.requestId, {
				method: event.request.method,
				url: event.request.url,
				loaderId: event.loaderId,
				frameId: event.frameId,
			});
		});
		cdp.on("Network.loadingFinished", (event) => requests.end(event.requestId));
		cdp.on("Network.loadingFailed", (event) => requests.end(event.requestId));
		cdp.on("Page.frameNavigated", ({ frame }) => {
			if (frame.parentId) return;
			for (const [id, entry] of requests.entries) {
				if (entry.loaderId !== frame.loaderId) requests.entries.delete(id);
			}
			requests.onChange();
		});
		cdp.on("Page.frameDetached", ({ frameId }) => {
			for (const [id, entry] of requests.entries) {
				if (entry.frameId === frameId) requests.entries.delete(id);
			}
			requests.onChange();
		});
		// Nothing of the requests' bodies is kept for this session.
		await cdp.send("Network.enable", {
			maxTotalBufferSize: 0,
			maxResourceBufferSize: 0,
			maxPostDataSize: 0,
		});
		return requests;
	}

	end(id) {
		if (this.entries.delete(id)) this.onChange();
	}

	get size() {
		return this.entries.size;
	}

	clear() {
		this.entries.clear();
	}

	[Symbol.iterator]() {
		return this.entries.values();
	}

	describe() {
		return [...this.entries.values()]
			.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)
			.join(", ");
	}
}

// -- the browser and its reused pages ----------------------------------------

let browser;

/**
 * One page the driver keeps across operations, in a browser context of its
 * own (its own cookies, storage and HTTP cache). The driver keeps two: one
 * for app-manager views, and one for the Vellum host, so a view's load never
 * takes the warm Vellum instance away. Every request the page sends names it
 * (PAGE_HEADER). Each is replaced after a failed operation, after a stray
 * request, and every `recycleAfter` operations.
 */
class ReusedPage {
	constructor(name, recycleAfter) {
		this.name = name;
		// Operations a page serves before it is replaced.
		this.recycleAfter = recycleAfter;
		this.context = null;
		this.page = null;
		this.cdp = null;
		// Operations on the current page (each a load, or a warm Vellum run),
		// and the pages opened so far.
		this.uses = 0;
		this.loads = 0;
		this.pages = 0;
		// The seed script every new document runs first, and the seed it holds.
		this.seedScript = null;
		this.seed = null;
		// A failed operation, or a stray request, leaves the page to be replaced.
		this.broken = false;
		// The page holds a Vellum host whose instance the next form may reuse.
		this.vellumWarm = false;
		// The operation this page serves now, and its requests in flight
		// (PageRequests).
		this.serving = null;
		this.inFlight = null;
		// The static files the origin answered this page, over all its pages:
		// those the image has, and those it lacks.
		this.statics = { editors: 0, missing: 0 };
	}

	async close() {
		const { context } = this;
		this.context = null;
		this.page = null;
		this.cdp = null;
		this.seedScript = null;
		this.seed = null;
		this.vellumWarm = false;
		this.inFlight = null;
		if (context) await context.close().catch(() => {});
	}

	async open() {
		await this.close();
		const context = await browser.newContext({ javaScriptEnabled: true });
		await context.setExtraHTTPHeaders({ [PAGE_HEADER]: this.name });
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		// The seed script is added through this session, which runs it only
		// with the Page domain on.
		await cdp.send("Page.enable");
		// Every document of the page holds its polls (steps/page/polls.js),
		// whatever seed a load then adds.
		await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
			source: stepCall("page/polls"),
		});
		const inFlight = await PageRequests.attach(cdp, () =>
			this.serving?.notify(),
		);
		// The images the page starts loading from HQ, which a kept document
		// shows again without asking (runVellum).
		cdp.on("Network.requestWillBeSent", (event) => {
			if (event.type === "Image" && isHqResource(event.request.url))
				this.serving?.imageRequested(event.request.url);
		});
		if (LATENCY_MS > 0) {
			await cdp.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: LATENCY_MS,
				downloadThroughput: -1,
				uploadThroughput: -1,
			});
		}
		await watchPageErrors(cdp, (text) => this.serving?.pageError(text));
		page.on("console", (entry) => {
			if (entry.type() === "error")
				this.serving?.consoleError(entry.text(), entry.location()?.url ?? "");
		});
		page.on("dialog", (dialog) => {
			// Leaving a page is the driver's act, never a section's: a
			// beforeunload prompt is accepted so the page leaves.
			if (dialog.type() === "beforeunload") {
				dialog.accept().catch(() => {});
				return;
			}
			this.serving?.dialog({
				type: dialog.type(),
				message: dialog.message(),
			});
			dialog.dismiss().catch(() => {});
		});
		page.on("requestfailed", (entry) => {
			const url = new URL(entry.url());
			if (url.origin === ORIGIN) return;
			this.serving?.record({
				method: entry.method(),
				url: entry.url(),
				answeredBy: "refused",
				error: entry.failure()?.errorText ?? null,
			});
		});
		Object.assign(this, {
			context,
			page,
			cdp,
			inFlight,
			uses: 0,
			loads: 0,
			broken: false,
			vellumWarm: false,
		});
		this.pages++;
	}

	/** Readies the page for an operation: replaced when due. */
	async prepareUse() {
		if (!this.page || this.broken || this.uses >= this.recycleAfter) {
			await this.open();
		}
		this.uses++;
	}

	/** Readies the page for a new load: a blank page, no storage or cookies but the run's, the run's seed. */
	async prepareLoad({ cookies, seed }) {
		await this.prepareUse();
		const { page, cdp, context } = this;
		if (page.url() !== "about:blank") {
			await page.goto("about:blank");
		}
		// Nothing of the document it left is in flight any longer.
		this.inFlight.clear();
		this.vellumWarm = false;
		await cdp.send("Storage.clearDataForOrigin", {
			origin: ORIGIN,
			storageTypes: "all",
		});
		await context.clearCookies();
		if (cookies?.length) {
			await context.addCookies(
				cookies.map(({ name, value }) => ({ name, value, url: ORIGIN })),
			);
		}
		if (this.seedScript !== null) {
			await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
				identifier: this.seedScript,
			});
			this.seedScript = null;
		}
		if (seed) {
			const { identifier } = await cdp.send(
				"Page.addScriptToEvaluateOnNewDocument",
				{ source: stepCall("page/seed", seed) },
			);
			this.seedScript = identifier;
		}
		this.seed = seed ?? null;
		this.loads++;
	}

	stats() {
		return {
			uses: this.uses,
			loads: this.loads,
			pages: this.pages,
			statics: { ...this.statics },
		};
	}
}

const viewPage = new ReusedPage("views", RECYCLE_LOADS);
const vellumPage = new ReusedPage("vellum", VELLUM_RECYCLE_RUNS);
const REUSED_PAGES = new Map([
	[viewPage.name, viewPage],
	[vellumPage.name, vellumPage],
]);

// The page of each "run" operation in progress, by the name its requests
// carry (PAGE_HEADER). A run's requests are answered through its context's
// route (PageRun.route), but Chromium follows an HTTP redirect the route
// answered with itself, past the route, to the origin: the origin serves
// that request to its run (PageRun.handle), as a person's browser follows
// HQ's redirect after a form's post.
const RUN_PAGES = new Map();
let runPages = 0;

// -- what a served operation records ------------------------------------------

/** One served operation: its requests, the page's errors and dialogs, each in the phase it happened in. */
class Served {
	constructor(deadline) {
		this.deadline = deadline;
		this.phase = "load";
		this.requests = [];
		this.pageErrors = [];
		this.consoleErrors = [];
		this.dialogs = [];
		this.forwarded = new Set();
		this.answered = [];
		this.waiters = [];
		// Each image the page started loading from HQ (not one of the
		// editors' static files), by its URL.
		this.images = [];
	}

	remaining() {
		const left = this.deadline - Date.now();
		if (left <= 0)
			throw new StepFailed("deadline", "The page run outlived its deadline.");
		return left;
	}

	imageRequested(url) {
		this.images.push(url);
	}

	record(entry) {
		this.requests.push({ phase: this.phase, ...entry });
	}

	pageError(text) {
		this.pageErrors.push({ phase: this.phase, error: text });
	}

	consoleError(text, url) {
		this.consoleErrors.push({ phase: this.phase, error: text, url });
	}

	dialog(dialog) {
		this.dialogs.push({ phase: this.phase, ...dialog });
	}

	/** Wakes whatever waits on this operation: a request was forwarded or answered, or the page's requests changed. */
	notify() {
		for (const waiter of [...this.waiters]) waiter();
	}

	/** Resolves once `condition()` holds, looking again whenever the operation is notified; fails at the deadline with `describe()`. */
	until(condition, describe) {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (!condition()) return;
				this.waiters = this.waiters.filter((w) => w !== check);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== check);
				reject(new StepFailed("deadline", describe()));
			}, this.remaining());
			this.waiters.push(check);
			check();
		});
	}

	/** Resolves once nothing this operation forwarded to Python is unanswered. */
	settledForwarding() {
		return this.until(
			() => this.forwarded.size === 0,
			() =>
				`HQ had not answered ${this.forwarded.size} of the page's requests by the deadline.`,
		);
	}

	/** Forwards a request to Python in the current phase and sends the page HQ's answer. */
	async forward({ request, response, url, body }, { phase = this.phase } = {}) {
		const entry = {
			phase,
			method: request.method,
			url: url.href,
			answeredBy: "hq",
		};
		this.requests.push(entry);
		const token = {};
		this.forwarded.add(token);
		entry.forwarded = nextTick();
		try {
			const reply = await askHq({
				method: request.method,
				url: url.href,
				headers: pageHeaders(request),
				bodyBase64: body ? body.toString("base64") : null,
				phase,
				forwarded: entry.forwarded,
			});
			entry.replied = nextTick();
			entry.status = reply.status;
			deliver(response, reply);
		} catch (error) {
			entry.answeredBy = "failed";
			entry.error = String(error.message ?? error);
			response.destroy();
		} finally {
			this.forwarded.delete(token);
			this.answered.push(entry);
			this.notify();
		}
	}

	frame(response, url, method) {
		this.record({ method, url: url.href, answeredBy: "frame-not-loaded" });
		respond(
			response,
			200,
			{
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
			"<!doctype html><title></title>",
		);
	}

	output() {
		return {
			requests: this.requests,
			pageErrors: this.pageErrors,
			consoleErrors: this.consoleErrors,
			dialogs: this.dialogs,
		};
	}
}

const isNavigation = (request) =>
	request.headers["upgrade-insecure-requests"] === "1";

/** Whether a URL the page asks for is HQ's to answer: the origin's, outside the editors' static files. */
function isHqResource(href) {
	const url = new URL(href);
	return url.origin === ORIGIN && !url.pathname.startsWith(STATIC_PREFIX);
}

// -- the view operation ------------------------------------------------------

class ServedView extends Served {
	constructor(message) {
		super(Date.now() + (message.deadlineMs ?? 60000));
		this.url = new URL(message.url, ORIGIN).href;
		this.sections = message.sections;
		this.expectingNavigation = true;
		// The section whose save is being armed, and the saves held so far.
		this.arming = null;
		this.held = new Map();
		this.heldWaiters = [];
		this.redirected = null;
	}

	async handle(exchange) {
		const { request, response, url } = exchange;
		if (this.phase === "leave") {
			// The page is leaving for about:blank once the view is over: what
			// it asks as it goes is refused, as a closing context drops it.
			this.record({
				method: request.method,
				url: url.href,
				answeredBy: "refused",
			});
			respond(response, 503, { "cache-control": "no-store" }, "");
			return;
		}
		if (isNavigation(request)) {
			if (this.expectingNavigation && url.href === this.url) {
				this.expectingNavigation = false;
				await this.forward(exchange, { phase: "load" });
				return;
			}
			const redirected = this.redirected;
			if (redirected && !redirected.followed && url.href === redirected.url) {
				// The section's answer sent the page elsewhere (HQ's redirect):
				// a fresh page follows it in the same way.
				redirected.followed = true;
				await this.forward(exchange, {
					phase: `followup:${redirected.section}`,
				});
				return;
			}
			this.frame(response, url, request.method);
			return;
		}
		const arming = this.arming;
		if (
			arming !== null &&
			request.method === "POST" &&
			url.pathname === this.sections[arming].savePath &&
			!this.held.has(arming)
		) {
			const entry = {
				phase: `section:${arming}`,
				method: request.method,
				url: url.href,
				answeredBy: "held",
			};
			this.requests.push(entry);
			const held = {
				exchange,
				entry,
				path: url.pathname,
				released: false,
				abandoned: false,
			};
			request.on("close", () => {
				if (!response.writableEnded) held.abandoned = true;
			});
			this.held.set(arming, held);
			for (const waiter of [...this.heldWaiters]) waiter();
			return;
		}
		const phase = this.phase.startsWith("section:")
			? `followup:${this.phaseSection}`
			: "load";
		await this.forward(exchange, { phase });
	}

	get phaseSection() {
		return Number(this.phase.split(":")[1]);
	}

	/** A dialog the page showed: recorded, and whatever waits on a held save looks again. */
	dialog(dialog) {
		super.dialog(dialog);
		for (const waiter of [...this.heldWaiters]) waiter();
	}

	/** The first dialog the page showed while section `index`'s save was armed, if any. */
	armDialog(index) {
		return this.dialogs.find((dialog) => dialog.phase === `arm:${index}`);
	}

	/**
	 * How many of the page's requests are in flight, the saves it holds
	 * unreleased aside (each a POST to its section's save path that Chromium
	 * started and the origin keeps unanswered).
	 */
	outstanding(inFlight) {
		const holding = new Map();
		for (const held of this.held.values()) {
			if (held.released || held.abandoned) continue;
			holding.set(held.path, (holding.get(held.path) ?? 0) + 1);
		}
		let count = 0;
		for (const entry of inFlight) {
			if (entry.method === "POST") {
				const pathname = new URL(entry.url).pathname;
				const left = holding.get(pathname) ?? 0;
				if (left > 0) {
					holding.set(pathname, left - 1);
					continue;
				}
			}
			count++;
		}
		return count;
	}

	/**
	 * Waits until section `index`'s save has reached the origin and is held,
	 * or the page has answered its Save with a dialog instead (HQ's Case
	 * List page refuses a configuration it finds errors in with an alert and
	 * sends nothing, details/bootstrap3/screen.js): the held save, or
	 * `{dialog}`.
	 */
	awaitHeld(index) {
		return new Promise((resolve, reject) => {
			const check = () => {
				const dialog = this.armDialog(index);
				if (!this.held.has(index) && dialog === undefined) return;
				this.heldWaiters = this.heldWaiters.filter((w) => w !== check);
				clearTimeout(timer);
				resolve(this.held.get(index) ?? { dialog });
			};
			const timer = setTimeout(() => {
				this.heldWaiters = this.heldWaiters.filter((w) => w !== check);
				const section = this.sections[index];
				reject(
					new StepFailed(
						"deadline",
						`The ${section.name} section's Save sent no POST to ${section.savePath} before the deadline.`,
					),
				);
			}, this.remaining());
			this.heldWaiters.push(check);
			check();
		});
	}

	/**
	 * Forwards a held save to Python as its section's own request. An answer
	 * holding `redirect` is one the page follows (app_manager.js::
	 * _initSaveButtons sets window.location to it): the driver then waits for
	 * the new document's load, which it starts listening for before the page
	 * has the answer.
	 */
	async release(index, page) {
		const held = this.held.get(index);
		held.released = true;
		held.entry.answeredBy = "hq";
		const { request, response, url, body } = held.exchange;
		const token = {};
		this.forwarded.add(token);
		held.entry.forwarded = nextTick();
		try {
			const reply = await askHq({
				method: request.method,
				url: url.href,
				headers: pageHeaders(request),
				bodyBase64: body ? body.toString("base64") : null,
				phase: `section:${index}`,
				forwarded: held.entry.forwarded,
			});
			held.entry.replied = nextTick();
			held.entry.status = reply.status;
			const redirect = redirectOf(reply);
			if (redirect) {
				this.redirected = { section: index, url: redirect, followed: false };
				this.redirectLoaded = page.waitForEvent("load", {
					timeout: this.remaining(),
				});
			}
			deliver(response, reply);
		} finally {
			this.forwarded.delete(token);
			this.answered.push(held.entry);
			this.notify();
		}
	}

	abandonHeld(from) {
		for (const [index, held] of this.held) {
			if (index < from || held.released) continue;
			held.abandoned = true;
			held.entry.answeredBy = "abandoned";
			held.exchange.response.destroy();
		}
	}
}

/** Where an HQ answer sends the page, when it is a JSON object naming `redirect`. */
function redirectOf(reply) {
	try {
		const parsed = JSON.parse(
			Buffer.from(reply.bodyBase64 ?? "", "base64").toString("utf8"),
		);
		if (parsed && typeof parsed.redirect === "string")
			return new URL(parsed.redirect, ORIGIN).href;
	} catch {
		// Not JSON: nothing for the page to follow.
	}
	return null;
}

/**
 * Evaluates a page expression in the main world of the page's current
 * document, through a DevTools session of the driver's own, as Playwright's
 * page.evaluate evaluates one: a promise it evaluates to is awaited, and it
 * runs as a person's gesture (Playwright's Runtime.callFunctionOn passes
 * `userGesture: true`, so the page has the same user activation either way).
 * Returns its value, as JSON carries it. Playwright's page.evaluate would
 * first evaluate its own utility script in the document's world and run
 * the expression through it; this evaluates the expression alone. An
 * exception the expression throws fails it with the page's description of
 * the error.
 */
async function pageValue(cdp, expression) {
	const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
		userGesture: true,
	});
	if (exceptionDetails) {
		const thrown = exceptionDetails.exception;
		throw new Error(
			thrown?.description ??
				(thrown && "value" in thrown ? String(thrown.value) : null) ??
				exceptionDetails.text,
		);
	}
	return result.value;
}

/** A step file's function called with `arg` in the page (pageValue). */
async function evaluate(cdp, name, arg) {
	return pageValue(cdp, stepCall(name, arg));
}

/** Waits, in the page, until a step file's function holds for `arg` (waitInPage). */
async function waitUntil(cdp, served, name, arg) {
	return waitInPage(cdp, { source: stepSource(name) }, arg, {
		timeoutMs: served.remaining(),
	});
}

/**
 * The page expression that waits inside the page until a predicate holds,
 * and evaluates to the value that held. The predicate is `source` (a page
 * function, called with `arg`) or `expression` (a string the page evaluates
 * each time it looks). The driver's rule for an expression: one whose value
 * is a function is that function, called with `arg` at every look, and any
 * other value is what is looked at. (This is not Playwright's rule for a
 * string: its Node API's waitForFunction sends a string with `isFunction:
 * false`, and its page takes the function value itself as the result, which
 * is truthy, so the wait holds at once.) It looks once at once and then,
 * while the predicate does not hold, once each animation frame ("raf",
 * Playwright's own default) or every `polling` ms, as Playwright's poller
 * looks; and gives up once `timeoutMs` of the page's performance clock
 * (which the run's fixed Date leaves running) have passed, with an error
 * naming WAIT_EXPIRED.
 */
function waiterExpression({ source, expression }, arg, polling, timeoutMs) {
	const predicate =
		source !== undefined
			? `const predicate = (${source});\n\tconst look = () => predicate(arg);`
			: `const expression = ${literal(expression)};
	let predicate;
	const look = () => {
		if (predicate) return predicate(arg);
		const value = (0, eval)(expression);
		if (typeof value !== "function") return value;
		predicate = value;
		return predicate(arg);
	};`;
	return `(() => {
	const arg = ${literal(arg ?? null)};
	const polling = ${literal(polling)};
	const end = performance.now() + ${Math.max(0, Math.floor(timeoutMs))};
	${predicate}
	return new Promise((resolve, reject) => {
		const next = () => {
			try {
				const value = look();
				if (value) return resolve(value);
				if (performance.now() >= end) return reject(new Error(${literal(WAIT_EXPIRED)}));
				if (polling === "raf") requestAnimationFrame(next);
				else setTimeout(next, polling);
			} catch (error) {
				reject(error);
			}
		};
		next();
	});
})()`;
}

// What a page's wait rejects with once its time has run out (waiterExpression).
const WAIT_EXPIRED = "proof-driver: the wait outlived its deadline";
// A wait whose document ended under it (a navigation) starts again on the
// document that replaced it, 100 ms after, as Playwright's waitForFunction
// tries again (Frame.retryWithProgressAndTimeouts: the first try at once,
// each later one 100 ms after the one before).
const WAIT_RETRY_MS = 100;
// How Chromium answers an evaluation whose document went away under it.
const CONTEXT_GONE =
	/Execution context was destroyed|Cannot find context with specified id|Promise was collected|Inspected target navigated or closed/;

/**
 * Waits, inside the page, until a predicate (waiterExpression) holds, and
 * returns the value that held: one evaluation whose promise the page
 * settles, instead of Playwright's waitForFunction, which first evaluates
 * its whole injected script in the document's world and then polls through
 * handles. A document that ends under the wait (a navigation) has the wait
 * start again on the next one, as waitForFunction does; an error the
 * predicate throws ends it. Fails with a TimeoutError once `timeoutMs` have
 * passed.
 */
async function waitInPage(cdp, predicate, arg, { polling = "raf", timeoutMs }) {
	const deadline = Date.now() + timeoutMs;
	const expired = () => {
		const error = new Error(
			`The page's wait did not hold within ${timeoutMs} ms.`,
		);
		error.name = "TimeoutError";
		return error;
	};
	for (let tries = 0; ; tries++) {
		if (tries > 0)
			await new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_MS));
		const left = deadline - Date.now();
		if (left <= 0) throw expired();
		let timer;
		const waited = pageValue(
			cdp,
			waiterExpression(predicate, arg, polling, left),
		);
		// Once the driver's own timer has ended the wait, the page's answer, when
		// it comes, is nobody's.
		waited.catch(() => {});
		try {
			// The page gives up at its own deadline; the driver's timer is for a
			// page that no longer runs its frames or timers at all.
			return await Promise.race([
				waited,
				new Promise((_resolve, reject) => {
					timer = setTimeout(() => reject(expired()), left + 1000);
				}),
			]);
		} catch (error) {
			const message = String(error?.message ?? error);
			if (message.includes(WAIT_EXPIRED)) throw expired();
			if (!CONTEXT_GONE.test(message)) throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}

// The page expression clicking the element a selector finds, as a person's
// click (the element's own click()); false when there is none.
const clickExpression = (selector) =>
	`((selector) => {
	const element = document.querySelector(selector);
	if (!element) return false;
	element.click();
	return true;
})(${literal(selector)})`;

// The page expression resolving a frame and then four tasks, one after
// another, later with what the page's clock reads then. Timers of one delay
// run in the order they were set, so every task the page's scripts had
// queued when the frame came runs first, and so do the tasks those queue in
// turn, four deep. jQuery (3.5.1, HQ's) calls a ready handler added after the
// document was ready from a task, catches what it throws in another, and
// rethrows it from a third (deferred.js, core/readyException.js): what a ready
// handler raises is the load's, never the next section's arming.
const FRAME_AND_TASK = `new Promise((resolve) =>
	requestAnimationFrame(() => {
		let left = 4;
		const next = () => (--left === 0 ? resolve(Date.now()) : setTimeout(next, 0));
		setTimeout(next, 0);
	}),
)`;

/**
 * Waits until the page is quiet: none of its requests in flight but those
 * `outstanding` leaves aside, none the origin forwarded unanswered, and so
 * still a frame and four tasks later (FRAME_AND_TASK: a handler that runs on
 * an answer may start another request, and an error it raises may reach the
 * page tasks later). Returns what the page's clock read then.
 */
async function quiet(owner, served, outstanding) {
	const calm = () =>
		served.forwarded.size === 0 && outstanding(owner.inFlight) === 0;
	for (;;) {
		await served.until(
			calm,
			() =>
				`The page still had ${outstanding(owner.inFlight)} request(s) in flight (${owner.inFlight.describe()}), ${served.forwarded.size} of them unanswered by HQ, at the deadline.`,
		);
		const clock = await pageValue(owner.cdp, FRAME_AND_TASK);
		if (calm()) return clock;
	}
}

const allInFlight = (inFlight) => inFlight.size;

async function runView(message) {
	const served = new ServedView(message);
	if (served.sections.length > MAX_HELD) {
		throw new StepFailed(
			"request",
			`A view holds at most ${MAX_HELD} saves at once (Chromium opens six connections to a host), and this one names ${served.sections.length} sections.`,
		);
	}
	const started = Date.now();
	const sections = served.sections.map((section) => ({
		name: section.name,
		armed: false,
		held: false,
		// The dialog the page answered the section's Save with when it sent
		// no save (`awaitHeld`).
		unsent: null,
		before: null,
		preRelease: null,
		after: null,
		abandoned: false,
	}));
	let failure = null;
	await viewPage.prepareLoad(message);
	const { page, cdp } = viewPage;
	viewPage.serving = served;
	const outstanding = (inFlight) => served.outstanding(inFlight);
	try {
		const response = await page.goto(served.url, {
			waitUntil: "load",
			timeout: served.remaining(),
		});
		const status = response ? response.status() : null;
		if (status !== null && status >= 400) {
			throw new StepFailed(
				"page",
				`The view ${message.url} was answered with status ${status}, so there is no page to save.`,
				{ status },
			);
		}
		// The load is over once the page is quiet: what its own scripts do
		// after the load event (an error jQuery rethrows from a ready handler
		// on a timer, a handler that runs on a load request's answer) belongs
		// to the load, and so to every section, as on a fresh page, not to
		// whichever section the driver arms first. What the page's clock reads
		// then is kept (the run's epoch when it is seeded).
		served.pageClock = await quiet(viewPage, served, outstanding);
		for (const [index, section] of served.sections.entries()) {
			served.phase = `arm:${index}`;
			served.arming = index;
			await waitUntil(cdp, served, "pages/ready", { bar: section.bar });
			await waitUntil(cdp, served, "pages/armed", {
				action: section.arm.action,
				selector: section.arm.selector,
				bar: section.bar,
			});
			sections[index].armed = true;
			sections[index].before = await evaluate(
				cdp,
				"pages/save_state",
				section.bar,
			);
			const clicked = await pageValue(
				cdp,
				clickExpression(`${section.bar} > .btn:not(.disabled)`),
			);
			if (!clicked) {
				throw new StepFailed(
					"page",
					`The ${section.name} section's Save button (${section.bar} > .btn) was not there to click.`,
				);
			}
			const awaited = await served.awaitHeld(index);
			if (awaited.dialog !== undefined) {
				// The page answered Save with a dialog. Once it is quiet, a save
				// it still sent after the dialog is held as any other; one it
				// never sent leaves the section unsent, its page as it was.
				await quiet(viewPage, served, outstanding);
			}
			if (served.held.has(index)) {
				sections[index].held = true;
			} else {
				sections[index].unsent = {
					type: awaited.dialog.type,
					message: awaited.dialog.message,
				};
				sections[index].preRelease = sections[index].before;
				sections[index].after = await evaluate(
					cdp,
					"pages/save_state",
					section.bar,
				);
			}
			served.arming = null;
		}
		served.phase = "load";
		await quiet(viewPage, served, outstanding);
		for (const [index, section] of served.sections.entries()) {
			if (sections[index].unsent !== null) continue;
			if (served.redirected) {
				sections[index].abandoned = true;
				continue;
			}
			const held = served.held.get(index);
			if (held.abandoned) {
				sections[index].abandoned = true;
				continue;
			}
			sections[index].preRelease = await evaluate(
				cdp,
				"pages/save_state",
				section.bar,
			);
			await announcePhase(served, `section:${index}`, "start");
			served.phase = `section:${index}`;
			await served.release(index, page);
			if (served.redirected) {
				await served.redirectLoaded;
				served.abandonHeld(index + 1);
				await waitUntil(cdp, served, "pages/ready", { bar: section.bar });
			}
			// The section has settled once its bar has left "Saving" (the
			// page's success or error handler has run, and started whatever it
			// asks HQ for next: app_manager.js::updateDOM's validation) and the
			// page is quiet but for the saves still held; its state is read
			// then, in the evaluation that sees it still settled.
			let after = null;
			do {
				await waitUntil(cdp, served, "pages/saved", section.bar);
				await quiet(viewPage, served, outstanding);
				after = await pageValue(cdp, settledState(section.bar));
			} while (after === null);
			sections[index].after = after;
			served.phase = `settled:${index}`;
			await announcePhase(served, `section:${index}`, "end");
		}
		served.phase = "end";
	} catch (error) {
		failure = error;
	}
	if (failure) {
		served.abandonHeld(0);
		viewPage.broken = true;
	}
	// The view is over: the page leaves, as a fresh page's context closes,
	// so nothing it started runs on after the operation.
	served.phase = "leave";
	try {
		await page.goto("about:blank");
	} catch {
		viewPage.broken = true;
	}
	await served.settledForwarding().catch(() => {});
	viewPage.serving = null;
	failure = withStrays(failure);
	const result = {
		url: served.url,
		sections,
		redirected: served.redirected,
		...served.output(),
		pageClock: served.pageClock ?? null,
		seconds: (Date.now() - started) / 1000,
	};
	if (failure) return failed(failure, result);
	return { ok: true, result };
}

/** An operation's failure, as the driver answers it: its kind, message, strays (if any) and what the run had recorded. */
function failed(failure, run) {
	return {
		ok: false,
		error: {
			kind: failure instanceof StepFailed ? failure.kind : timeoutKind(failure),
			message: failure.message,
			...(failure.strays ? { strays: failure.strays } : {}),
			run,
		},
	};
}

function timeoutKind(error) {
	return error?.name === "TimeoutError" ? "deadline" : "page";
}

// -- the Vellum operation ----------------------------------------------------

class ServedVellum extends Served {
	async handle(exchange) {
		const { request, response, url } = exchange;
		if (this.phase === "leave") {
			// The host is leaving for about:blank after a run that did not end
			// clean: what it asks as it goes is refused, as a closing context
			// drops it.
			this.record({
				method: request.method,
				url: url.href,
				answeredBy: "refused",
			});
			respond(response, 503, { "cache-control": "no-store" }, "");
			return;
		}
		if (isNavigation(request)) {
			this.frame(response, url, request.method);
			return;
		}
		await this.forward(exchange, { phase: "vellum" });
	}
}

// Finds two of Vellum's modules in the host page and keeps them on the
// window: util (src/util.js) as `window.proofVellumUtil` and mugs
// (src/mugs.js) as `window.proofVellumMugs`, so steps/vellum/shared.js,
// reset.js and end.js can put back the state they share between instances.
// HQ's vendored Vellum build keeps its modules inside its own scope, where no
// page script reaches them (Vellum's own tests import the modules instead);
// the core plugin's functions close over core.js's module scope, which
// imports both, so the inspector finds them there: the scope variables whose
// value, or one of whose properties, holds util's `checkForFormSubmissions`
// with underscore's `cancel`, and mugs' `baseMugTypes` and `baseSpecs`.
// Returns whether the window holds both.
const EXPOSE_VELLUM_MODULES = `function () {
	const util = (value) =>
		value !== null &&
		typeof value === "object" &&
		typeof value.checkForFormSubmissions === "function" &&
		typeof value.checkForFormSubmissions.cancel === "function";
	const mugs = (value) =>
		value !== null &&
		typeof value === "object" &&
		typeof value.baseMugTypes?.normal === "object" &&
		typeof value.baseSpecs?.databind === "object";
	const keep = (name, value) =>
		Object.defineProperty(window, name, { value, configurable: true });
	const candidates = [this];
	for (const key of Object.keys(this)) {
		try {
			candidates.push(this[key]);
		} catch {}
	}
	for (const value of candidates) {
		if (!window.proofVellumUtil && util(value)) keep("proofVellumUtil", value);
		if (!window.proofVellumMugs && mugs(value)) keep("proofVellumMugs", value);
	}
	return !!window.proofVellumUtil && !!window.proofVellumMugs;
}`;

async function exposeVellumModules(owner) {
	const { cdp } = owner;
	const objectGroup = "proof-vellum-modules";
	try {
		const { result: core } = await cdp.send("Runtime.evaluate", {
			expression: "window.proofVellumHost.jQuery.vellum._plugins.core",
			objectGroup,
		});
		const { result: members } = await cdp.send("Runtime.getProperties", {
			objectId: core.objectId,
			ownProperties: true,
		});
		for (const member of members) {
			if (member.value?.type !== "function") continue;
			const { internalProperties = [] } = await cdp.send(
				"Runtime.getProperties",
				{ objectId: member.value.objectId, ownProperties: false },
			);
			const scopes = internalProperties.find((p) => p.name === "[[Scopes]]");
			if (!scopes?.value?.objectId) continue;
			const { result: chain } = await cdp.send("Runtime.getProperties", {
				objectId: scopes.value.objectId,
				ownProperties: true,
			});
			for (const scope of chain) {
				if (!scope.value?.objectId || scope.value.description === "Global")
					continue;
				const { result: variables } = await cdp.send("Runtime.getProperties", {
					objectId: scope.value.objectId,
					ownProperties: true,
				});
				for (const variable of variables) {
					if (variable.value?.type !== "object" || !variable.value.objectId)
						continue;
					const { result } = await cdp.send("Runtime.callFunctionOn", {
						objectId: variable.value.objectId,
						functionDeclaration: EXPOSE_VELLUM_MODULES,
						returnByValue: true,
					});
					if (result.value === true) return;
				}
			}
			// Every core function closes over the same module scope: the first
			// one with scopes has been searched.
			break;
		}
	} finally {
		await cdp
			.send("Runtime.releaseObjectGroup", { objectGroup })
			.catch(() => {});
	}
	const missing = await pageValue(
		cdp,
		"[window.proofVellumUtil ? null : 'util (src/util.js, with checkForFormSubmissions)', window.proofVellumMugs ? null : 'mugs (src/mugs.js, with baseMugTypes and baseSpecs)'].filter(Boolean).join(' and ')",
	);
	throw new StepFailed(
		"page",
		`The driver did not find Vellum's ${missing} in the scope of Vellum's core plugin on the host page, so it cannot put back what Vellum's instances share; a warm host would carry one form's check for submissions, mug types and property specs into the next. Check that HQ's vendored Vellum still builds core.js on util.js and mugs.js.`,
	);
}

async function runVellum(message) {
	const served = new ServedVellum(Date.now() + (message.deadlineMs ?? 60000));
	served.phase = "vellum";
	const started = Date.now();
	const outcome = {};
	const stages = {};
	let failure = null;
	// A warm host needs the same clock its document was given: seeded or not,
	// at the same epoch (the generator itself restarts as Vellum starts,
	// steps/vellum/start.js).
	const seeded = message.seed ?? null;
	const reusable =
		!message.fresh &&
		vellumPage.vellumWarm &&
		!vellumPage.broken &&
		vellumPage.page !== null &&
		(vellumPage.seed === null) === (seeded === null) &&
		vellumPage.seed?.epoch === seeded?.epoch;
	// A host that has served its recycle period is replaced even when it could
	// have been reused, and the run says so.
	const recycled = reusable && vellumPage.uses >= vellumPage.recycleAfter;
	const warm = reusable && !recycled;
	try {
		if (warm) await vellumPage.prepareUse();
		else await vellumPage.prepareLoad(message);
		const { page, context, cdp } = vellumPage;
		vellumPage.serving = served;
		if (warm) {
			outcome.reset = await evaluate(cdp, "vellum/reset", null);
			await context.clearCookies();
			if (message.cookies?.length) {
				await context.addCookies(
					message.cookies.map(({ name, value }) => ({
						name,
						value,
						url: ORIGIN,
					})),
				);
			}
		} else {
			await page.goto(new URL(VELLUM_HOST, ORIGIN).href, {
				waitUntil: "load",
				timeout: served.remaining(),
			});
			await waitUntil(cdp, served, "vellum/host_ready", null);
			await exposeVellumModules(vellumPage);
			await evaluate(cdp, "vellum/shared", null);
		}
		const opening = Date.now();
		outcome.started = await evaluate(cdp, "vellum/start", {
			options: message.options,
			loadDelay: message.loadDelay ?? null,
			seed: seeded ? seeded.seed : null,
		});
		await waitUntil(cdp, served, "vellum/loaded", null);
		await waitUntil(cdp, served, "vellum/settled", null);
		outcome.record = await evaluate(cdp, "vellum/record", null);
		const saving = Date.now();
		stages.open = (saving - opening) / 1000;
		outcome.save = await evaluate(cdp, "vellum/save", null);
		await waitUntil(cdp, served, "vellum/saved", null);
		stages.save = (Date.now() - saving) / 1000;
		outcome.after = await evaluate(cdp, "vellum/after_save", null);
		await quiet(vellumPage, served, allInFlight);
	} catch (error) {
		failure = error;
	}
	// The reset rule: a run that did not end clean leaves the page to be
	// loaded afresh for the next form.
	let clean =
		!failure &&
		served.pageErrors.length === 0 &&
		outcome.record?.loaded !== false &&
		outcome.save?.saved === true &&
		(outcome.after?.modals ?? []).length === 0 &&
		outcome.after?.saveButton === "saved" &&
		served.answered.every((entry) => (entry.status ?? 0) < 400);
	if (clean) {
		// The run ends as a fresh page's context closing would end it: nothing
		// it started may run on.
		try {
			outcome.ended = await evaluate(vellumPage.cdp, "vellum/end", null);
		} catch (error) {
			failure = error;
			clean = false;
		}
	}
	// A document keeps every image it has loaded and shows it again without
	// asking HQ (the HTML standard's list of available images, which Chromium
	// keeps per document whatever HQ's answer says about caching and which
	// nothing in the page can clear), where a fresh page asks HQ for it. So
	// the host stays for the next form only after a clean run whose page
	// loaded no image from HQ; after one that did, the next form gets a fresh
	// load of the host, and no run is shown an image an earlier run loaded.
	const kept = clean && served.images.length === 0;
	if (!kept && vellumPage.page) {
		served.phase = "leave";
		try {
			await vellumPage.page.goto("about:blank");
		} catch {
			vellumPage.broken = true;
		}
	}
	await served.settledForwarding().catch(() => {});
	vellumPage.serving = null;
	vellumPage.vellumWarm = kept && !vellumPage.broken;
	if (failure) vellumPage.broken = true;
	failure = withStrays(failure);
	const result = {
		warm,
		recycled,
		clean,
		kept,
		...outcome,
		...served.output(),
		stages,
		seconds: (Date.now() - started) / 1000,
	};
	if (failure) return failed(failure, result);
	return { ok: true, result };
}

// -- the idle operation -----------------------------------------------------

/**
 * Lets a reused page sit idle with no operation serving it, for the driver's
 * own tests. Chromium's virtual time (Emulation.setVirtualTimePolicy with the
 * "advance" policy and a budget of `virtualMs`) runs every timer the page
 * holds that falls due within the budget, as fast as the page can run them,
 * so whatever the page would send HQ in that much time once its operation is
 * over arrives now, as a stray: refused, and failing this operation. With
 * "eval" (a page function) the page runs it first. Virtual time is not given
 * back to the page's own clock (once the budget is spent the page's timers
 * stay paused), so the page is replaced before its next use.
 */
async function runIdle(message) {
	const deadline = Date.now() + (message.deadlineMs ?? 60000);
	const owner = REUSED_PAGES.get(message.page);
	const result = { page: message.page, virtualMs: message.virtualMs };
	if (!owner?.page) {
		return failed(
			new StepFailed(
				"request",
				`The driver has no ${message.page} page open to leave idle; it keeps ${[...REUSED_PAGES.keys()].join(" and ")}, each once an operation has opened it.`,
			),
			result,
		);
	}
	const { page, cdp } = owner;
	// A stray closes the page, and with it the session this waits on.
	const open = () => owner.page === page;
	const waitWhile = async (condition, describe) => {
		while (condition()) {
			if (Date.now() > deadline) throw new StepFailed("deadline", describe());
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	let failure = null;
	try {
		if (message.eval) await pageValue(cdp, `(${message.eval})()`);
		let spent = false;
		cdp.once("Emulation.virtualTimeBudgetExpired", () => {
			spent = true;
		});
		await cdp.send("Emulation.setVirtualTimePolicy", {
			policy: "advance",
			budget: message.virtualMs,
		});
		await waitWhile(
			() => open() && !spent,
			() =>
				`The ${message.page} page did not spend ${message.virtualMs} ms of virtual time before the deadline.`,
		);
		// Whatever the page sent as its timers ran has reached the origin:
		// none of its requests is in flight, or a stray has closed it.
		await waitWhile(
			() => open() && owner.inFlight.size > 0,
			() =>
				`The ${message.page} page still had requests in flight (${owner.inFlight.describe()}) at the deadline.`,
		);
	} catch (error) {
		// A session a stray closed fails what was waiting on it; the stray is
		// the operation's failure.
		if (open() || !unreportedStrays.length) failure = error;
	}
	owner.broken = true;
	failure = withStrays(failure);
	if (failure) return failed(failure, result);
	return { ok: true, result };
}

// -- the run operation (a fresh context, routed through Playwright) ----------

class PageRun {
	constructor(deadline) {
		this.deadline = deadline;
		this.requests = [];
		this.pageErrors = [];
		this.consoleErrors = [];
		this.dialogs = [];
		this.inFlight = new Set();
		// The page's requests Chromium has started and not finished (PageRequests).
		this.pageInFlight = null;
		this.page = null;
		this.cdp = null;
		this.answered = [];
		this.waiters = [];
		// Inside a "recover" step: the page is being left as a person leaves it.
		this.leaving = false;
	}

	remaining() {
		const left = this.deadline - Date.now();
		if (left <= 0)
			throw new StepFailed("deadline", "The page run outlived its deadline.");
		return left;
	}

	notify() {
		for (const waiter of [...this.waiters]) waiter();
	}

	record(entry) {
		this.requests.push(entry);
	}

	/**
	 * A request of the run's page that reached the origin past its route: the
	 * one Chromium sends following an HTTP redirect HQ answered a request
	 * with. It is HQ's to answer, as every request of the run is.
	 */
	async handle({ request, response, url, body }) {
		const entry = { method: request.method, url: url.href };
		this.requests.push(entry);
		const handled = (async () => {
			try {
				const reply = await askHq({
					method: request.method,
					url: url.href,
					headers: pageHeaders(request),
					bodyBase64: body ? body.toString("base64") : null,
					phase: "run",
					forwarded: null,
				});
				entry.answeredBy = "hq";
				entry.status = reply.status;
				deliver(response, reply);
			} catch (error) {
				entry.answeredBy = "failed";
				entry.error = String(error.message ?? error);
				response.destroy();
			}
		})();
		this.inFlight.add(handled);
		try {
			await handled;
		} finally {
			this.inFlight.delete(handled);
			this.answered.push(entry);
			this.notify();
		}
	}

	/** Follows the page's requests in flight, through a DevTools session of the driver's own (PageRequests). */
	async watch(context, page) {
		this.page = page;
		const cdp = await context.newCDPSession(page);
		await cdp.send("Page.enable");
		this.pageInFlight = await PageRequests.attach(cdp, () => this.notify());
		await watchPageErrors(cdp, (text) => this.pageErrors.push(text));
		// The page's own scripts' world is evaluated in through this session
		// too (pageValue), as on the reused pages.
		this.cdp = cdp;
	}

	/** Resolves once none of the page's requests is in flight and no answer is being delivered. */
	idle() {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (this.pageInFlight.size || this.inFlight.size) return;
				this.waiters = this.waiters.filter((w) => w !== check);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== check);
				reject(
					new StepFailed(
						"deadline",
						`The page still had ${this.pageInFlight.size} request(s) in flight (${this.pageInFlight.describe()}) at the deadline.`,
					),
				);
			}, this.remaining());
			this.waiters.push(check);
			check();
		});
	}

	async route(route) {
		const request = route.request();
		const url = new URL(request.url());
		const entry = { method: request.method(), url: request.url() };
		this.requests.push(entry);
		if (url.origin === FONTS_ORIGIN) {
			const font = await webFont(url);
			if (font) {
				entry.answeredBy = "font";
				entry.status = 200;
				await route.fulfill({
					status: 200,
					contentType: font.contentType,
					body: font.body,
				});
				return;
			}
		}
		if (url.origin !== ORIGIN) {
			entry.answeredBy = "refused";
			await route.abort("blockedbyclient");
			return;
		}
		// A frame the page embeds (App Preview) is another page, not the one
		// under test: it gets an empty document of the page's own origin, so
		// the page's scripts can still reach into it.
		if (
			request.isNavigationRequest() &&
			request.frame().parentFrame() !== null
		) {
			entry.answeredBy = "frame-not-loaded";
			await route.fulfill({
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: "<!doctype html><title></title>",
			});
			return;
		}
		if (url.pathname.startsWith(STATIC_PREFIX)) {
			const file = await staticFile(url.pathname);
			if (file && !registeredStatics.has(url.pathname)) {
				entry.answeredBy = "editors";
				entry.status = 200;
				await route.fulfill({
					status: 200,
					contentType: file.contentType,
					body: file.body,
				});
				return;
			}
		}
		const body = request.postDataBuffer();
		// The whole handling, fulfilment included, is what drain() waits on.
		const handled = (async () => {
			try {
				const reply = await askHq({
					method: request.method(),
					url: request.url(),
					headers: Object.fromEntries(
						Object.entries(await request.allHeaders()).filter(
							([name]) => name !== PAGE_HEADER,
						),
					),
					bodyBase64: body ? body.toString("base64") : null,
					phase: "run",
					forwarded: null,
				});
				entry.answeredBy = "hq";
				entry.status = reply.status;
				// An answer whose page follows HQ's redirect (app_manager.js::
				// _initSaveButtons sets window.location to it): the new
				// document's load is listened for before the page has the answer.
				const redirect = redirectOf(reply);
				if (
					redirect &&
					this.page &&
					request.frame() === this.page.mainFrame()
				) {
					entry.redirect = redirect;
					const loaded = this.page.waitForEvent("load", {
						timeout: this.remaining(),
					});
					loaded.catch(() => {});
					Object.defineProperty(entry, "redirectLoaded", { value: loaded });
				}
				const headers = {};
				for (const [name, value] of reply.headers) {
					const key = name.toLowerCase();
					headers[key] =
						headers[key] === undefined ? value : `${headers[key]}\n${value}`;
				}
				await route.fulfill({
					status: reply.status,
					headers,
					body: Buffer.from(reply.bodyBase64 ?? "", "base64"),
				});
			} catch (error) {
				entry.answeredBy ??= "failed";
				entry.error = String(error.message ?? error);
				await route.abort("failed").catch(() => {});
			}
		})();
		this.inFlight.add(handled);
		try {
			await handled;
		} finally {
			this.inFlight.delete(handled);
			this.answered.push(entry);
			this.notify();
		}
	}

	/**
	 * Resolves once the page has had a request matching `want` answered; or,
	 * given `dialogsFrom`, once the page has shown a dialog after the first
	 * `dialogsFrom` it showed, with `{dialog}` (the page answered what was
	 * clicked with that dialog).
	 */
	awaitRequest(want, from = 0, dialogsFrom = null) {
		return new Promise((resolve, reject) => {
			const check = () => {
				const found = this.answeredRequest(want, from);
				const dialog =
					dialogsFrom === null ? undefined : this.dialogs[dialogsFrom];
				if (found || dialog !== undefined) {
					this.waiters = this.waiters.filter((w) => w !== check);
					clearTimeout(timer);
					resolve(found ?? { dialog });
				}
			};
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== check);
				reject(
					new StepFailed(
						"deadline",
						`The page made no ${want.method ?? ""} request to ${want.pathname} before the deadline.`,
					),
				);
			}, this.remaining());
			this.waiters.push(check);
			check();
		});
	}

	/** The page's request matching `want` that has been answered, among those after the first `from`, if any. */
	answeredRequest(want, from = 0) {
		return this.answered
			.slice(from)
			.find(
				(entry) =>
					entry.method === (want.method ?? entry.method) &&
					new URL(entry.url).pathname === want.pathname &&
					entry.answeredBy !== undefined,
			);
	}

	/** Waits until every request the page made to HQ has been answered and delivered. */
	async drain() {
		while (this.inFlight.size) {
			await Promise.allSettled([...this.inFlight]);
			// Let each finished handler's own cleanup run before looking again.
			await new Promise((resolve) => setImmediate(resolve));
		}
	}
}

/**
 * Until the page is quiet: none of its requests in flight, and so still a
 * frame and four tasks later (FRAME_AND_TASK). With `timers` (a run whose
 * documents count their short timers, steps/page/timers.js), none of the
 * page's own short timers is still set either: what such a timer runs may
 * start a request, so the two are waited for in turn until both hold at once.
 */
async function runQuiet(run, timers) {
	for (;;) {
		await run.idle();
		if (timers) {
			await waitInPage(
				run.cdp,
				{ expression: "() => window.proofShortTimers() === 0" },
				null,
				{ polling: "raf", timeoutMs: run.remaining() },
			);
		}
		await pageValue(run.cdp, FRAME_AND_TASK);
		if (
			!run.pageInFlight.size &&
			!run.inFlight.size &&
			(!timers || (await pageValue(run.cdp, "window.proofShortTimers()")) === 0)
		)
			return;
	}
}

/**
 * The strokes a drag of [dx, dy] whole pixels is made of: each from the
 * middle of `box`, as few as keep every stroke's end inside the box and the
 * window (`viewport`) with a margin, the pixels shared among them so they add
 * up to the drag exactly.
 */
function dragStrokes([dx, dy], box, viewport) {
	const margin = 8;
	const middle = [box.x + box.width / 2, box.y + box.height / 2];
	const reach = (half, from, size) =>
		Math.max(1, Math.floor(Math.min(half, from, size - from) - margin));
	const across = reach(box.width / 2, middle[0], viewport.width);
	const down = reach(box.height / 2, middle[1], viewport.height);
	const count = Math.max(
		1,
		Math.ceil(Math.abs(dx) / across),
		Math.ceil(Math.abs(dy) / down),
	);
	const share = (total, index) =>
		Math.trunc(((index + 1) * total) / count) -
		Math.trunc((index * total) / count);
	return Array.from({ length: count }, (_, index) => [
		[0.5, 0.5],
		[0.5, 0.5, share(dx, index), share(dy, index)],
	]);
}

async function runSteps(page, run, steps) {
	const outcomes = [];
	// The dialogs the page had shown when the last click was made, and
	// whether an awaited request was answered with a dialog instead (a save
	// the page refused and never sent), which skips the steps marked
	// `unlessUnsent`.
	let dialogsAtClick = 0;
	let unsent = false;
	// The page's answered requests when the last "mark" step ran, which an
	// "awaitRequest" with "sinceMark" looks past (a request the steps after
	// the mark caused, never one answered earlier); and whether the last wait
	// a step allowed to miss missed or held with a value other than true,
	// which skips an "awaitRequest" marked "unlessMissed" (the page did not
	// do what would send the request).
	let answeredAtMark = 0;
	let lastMissed = false;
	// A wait a step allows to miss (`within`, with `orSkipTo` or `optional`):
	// once one with `orSkipTo` has missed, every step up to the one labelled
	// so is skipped, and `missed` stays set until a `recover` step puts the
	// page back.
	let skipTo = null;
	let missed = false;
	for (const [index, step] of steps.entries()) {
		const started = Date.now();
		const outcome = { step: index };
		trace(`step ${index}: ${JSON.stringify(step).slice(0, 200)}`);
		if (skipTo !== null) {
			if (step.label === skipTo) {
				skipTo = null;
			} else {
				outcome.skipped = true;
				outcomes.push(outcome);
				continue;
			}
		}
		if (step.unlessUnsent && unsent) {
			outcome.skipped = true;
			outcomes.push(outcome);
			continue;
		}
		try {
			if (step.label !== undefined && step.recover === undefined) {
				// A place a missed wait skips to; nothing to do.
				outcome.label = step.label;
			} else if (step.mark !== undefined) {
				answeredAtMark = run.answered.length;
				lastMissed = false;
			} else if (
				(step.awaitRequest !== undefined ||
					step.files !== undefined ||
					step.draw !== undefined) &&
				step.unlessMissed &&
				lastMissed
			) {
				outcome.skipped = true;
			} else if (step.recover !== undefined) {
				// The page back where a run starts: by the click a person makes
				// when nothing missed and the element is there, else by loading
				// the address again; either way leaving what the run left open
				// (a form asks whether to leave it, and is told yes).
				run.leaving = true;
				try {
					const clicked =
						!missed &&
						(await pageValue(run.cdp, clickExpression(step.recover.click)));
					if (!clicked) {
						await page.goto(new URL(step.recover.goto, ORIGIN).toString(), {
							waitUntil: "load",
							timeout: run.remaining(),
						});
						outcome.reloaded = true;
					}
				} finally {
					run.leaving = false;
				}
				missed = false;
			} else if (step.until !== undefined && step.within !== undefined) {
				// A wait that may miss: the page is given `within` ms to hold it.
				try {
					outcome.value = await waitInPage(
						run.cdp,
						{ source: stepSource(step.until) },
						step.arg,
						{
							polling: step.polling ?? "raf",
							timeoutMs: Math.min(step.within, run.remaining()),
						},
					);
					lastMissed = outcome.value !== true;
					// A wait that held with another answer than true (the page
					// said it cannot go on: a search it refused) ends the run
					// where a miss would.
					if (lastMissed && step.orSkipTo !== undefined) {
						skipTo = step.orSkipTo;
						missed = true;
					}
				} catch (error) {
					if (error?.name !== "TimeoutError" || run.remaining() <= 0)
						throw error;
					outcome.missed = true;
					lastMissed = true;
					if (step.orSkipTo !== undefined) {
						skipTo = step.orSkipTo;
						missed = true;
					}
				}
			} else if (step.goto !== undefined) {
				const response = await page.goto(
					new URL(step.goto, ORIGIN).toString(),
					{
						waitUntil: "load",
						timeout: run.remaining(),
					},
				);
				outcome.status = response ? response.status() : null;
				if (outcome.status !== null && outcome.status >= 400) {
					throw new StepFailed(
						"page",
						`Step ${index} opened ${step.goto}, and it was answered with status ${outcome.status}, so there is no page to run.`,
					);
				}
			} else if (step.waitFor !== undefined) {
				await waitInPage(run.cdp, { expression: step.waitFor }, step.arg, {
					polling: step.polling ?? "raf",
					timeoutMs: run.remaining(),
				});
			} else if (step.until !== undefined) {
				try {
					await waitInPage(
						run.cdp,
						{ source: stepSource(step.until) },
						step.arg,
						{ polling: step.polling ?? "raf", timeoutMs: run.remaining() },
					);
				} catch (error) {
					// A step file that can say what it is still waiting for
					// (it takes `explain`) says it, once, in the failure.
					if (
						error?.name === "TimeoutError" &&
						step.arg?.explain === undefined
					) {
						const said = await pageValue(
							run.cdp,
							`(${stepSource(step.until)})(${literal({ ...step.arg, explain: true })})`,
						).catch(() => undefined);
						if (typeof said === "string")
							error.message = `${error.message} The page was still waiting: ${said}.`;
					}
					throw error;
				}
			} else if (step.eval !== undefined) {
				// The page function called with its argument, as one expression
				// the page evaluates (literal).
				outcome.value = await pageValue(
					run.cdp,
					`(${step.eval})(${literal(step.arg ?? null)})`,
				);
			} else if (step.call !== undefined) {
				outcome.value = await evaluate(run.cdp, step.call, step.arg);
			} else if (step.dispatch !== undefined) {
				const count = await pageValue(
					run.cdp,
					`(({ selector, event }) => {
	const found = document.querySelectorAll(selector);
	for (const element of found) {
		element.dispatchEvent(new Event(event, { bubbles: true }));
	}
	return found.length;
})(${literal({ selector: step.dispatch, event: step.event ?? "change" })})`,
				);
				if (!count)
					throw new StepFailed(
						"page",
						`No element matches ${step.dispatch}, so the ${step.event ?? "change"} event went nowhere.`,
					);
			} else if (step.files !== undefined || step.draw !== undefined) {
				// A worker's own input, which no page function can give: a file
				// chosen in the browser's file chooser, or a stroke drawn with
				// the pointer. The step file names the element (called with
				// `find`), and Playwright gives the input as the browser does:
				// the chosen file set on the file input with the input and
				// change events a choice fires, or the pointer pressed at one
				// point of the element, moved to another and released.
				const name = step.files ?? step.draw;
				const handle = await page.evaluateHandle(
					`(${stepSource(name)})(${literal({ ...step.arg, find: true })})`,
				);
				try {
					const element = handle.asElement();
					if (!element)
						throw new StepFailed(
							"page",
							`${name} found no element for ${JSON.stringify(step.arg)}, so nothing was given to it.`,
						);
					if (step.files !== undefined) {
						await element.setInputFiles({
							name: step.file.name,
							mimeType: step.file.mimeType,
							buffer: Buffer.from(step.file.base64, "base64"),
						});
					} else {
						// The element brought to the middle of the window, as a
						// person scrolls what they draw on into view, clear of
						// what the page pins to the window's edges: at once (the
						// page's stylesheet may ask a scroll to glide), and then
						// until the element stands in one place two frames running,
						// so no scroll of the page's own still moves it.
						await element.evaluate(async (target) => {
							target.scrollIntoView({
								block: "center",
								inline: "center",
								behavior: "instant",
							});
							const frame = () =>
								new Promise((resolve) => requestAnimationFrame(resolve));
							let last = null;
							for (;;) {
								await frame();
								const { x, y, width, height } = target.getBoundingClientRect();
								const now = `${x} ${y} ${width} ${height}`;
								if (now === last) return;
								last = now;
							}
						});
						const box = await element.boundingBox();
						if (!box || box.width < 1 || box.height < 1)
							throw new StepFailed(
								"page",
								`${name} found an element with no box to draw in for ${JSON.stringify(step.arg)}.`,
							);
						// A point is a fraction of the box across and down, and
						// optionally whole pixels more each way.
						const at = ([x, y, dx = 0, dy = 0]) => [
							box.x + box.width * x + dx,
							box.y + box.height * y + dy,
						];
						// A drag ("drag": whole pixels across and down) is made of
						// strokes from the element's middle that each stay inside
						// it and the window, as a person drags a map further than
						// it shows in several strokes; after each, the page's
						// answer to it ("answeredBy") and the page quiet again, so
						// each stroke is one answer however fast the page is.
						const strokes =
							step.drag === undefined
								? [step.stroke]
								: dragStrokes(step.drag, box, page.viewportSize());
						for (const stroke of strokes) {
							// Every point of the stroke lands on the element itself:
							// one that lands on something the page lays over it, or
							// outside the window, would press or move nothing the
							// element hears.
							for (const point of stroke) {
								const [x, y] = at(point);
								const covering = await element.evaluate(
									(target, [left, top]) => {
										const hit = document.elementFromPoint(left, top);
										return hit === target || target.contains(hit)
											? null
											: (hit?.outerHTML ?? "nothing").slice(0, 200);
									},
									[x, y],
								);
								if (covering !== null)
									throw new StepFailed(
										"page",
										`${name}'s stroke for ${JSON.stringify(step.arg)} would land at (${x}, ${y}) on ${covering}, not on the element, so nothing would be drawn.`,
									);
							}
							const since = run.answered.length;
							const [from, ...through] = stroke;
							await page.mouse.move(...at(from));
							await page.mouse.down();
							for (const point of through) await page.mouse.move(...at(point));
							await page.mouse.up();
							if (step.drag !== undefined) {
								await run.awaitRequest(step.answeredBy, since, null);
								await runQuiet(run, true);
							}
						}
						// A canvas shows the stroke it took: one that shows none
						// heard none of it.
						const drew = await element.evaluate((target) => {
							if (!(target instanceof HTMLCanvasElement)) return true;
							if (!target.isConnected) return false;
							const { width, height } = target;
							const pixels = target
								.getContext("2d")
								.getImageData(0, 0, width, height).data;
							for (let i = 3; i < pixels.length; i += 4)
								if (pixels[i]) return true;
							return false;
						});
						if (!drew)
							throw new StepFailed(
								"page",
								`${name}'s stroke for ${JSON.stringify(step.arg)} left nothing drawn on the canvas, so the page heard none of it.`,
							);
					}
				} finally {
					await handle.dispose();
				}
			} else if (step.advance !== undefined) {
				// A form shown one question a screen stepped forward as a person
				// steps it: the step file presses the form's own Next ("next")
				// until it answers otherwise, and after each press the page's
				// answer to the request it sent ("answeredBy") and the page quiet
				// are waited for before it is asked again. Its last answer is the
				// outcome's value; any but true and those "passes" names ends the
				// run where a missed wait does, with "orSkipTo".
				outcome.advanced = 0;
				for (;;) {
					const from = run.answered.length;
					const said = await waitInPage(
						run.cdp,
						{ source: stepSource(step.advance) },
						step.arg,
						{ polling: "raf", timeoutMs: run.remaining() },
					);
					if (said !== "next") {
						outcome.value = said;
						break;
					}
					outcome.advanced += 1;
					await run.awaitRequest(step.answeredBy, from);
					await runQuiet(run, Boolean(step.timers));
				}
				lastMissed = outcome.value !== true;
				const passes = step.passes ?? [true];
				if (!passes.includes(outcome.value) && step.orSkipTo !== undefined) {
					skipTo = step.orSkipTo;
					missed = true;
				}
			} else if (step.click !== undefined) {
				dialogsAtClick = run.dialogs.length;
				const clicked = await pageValue(run.cdp, clickExpression(step.click));
				if (!clicked)
					throw new StepFailed(
						"page",
						`No element matches ${step.click}, so nothing was clicked.`,
					);
			} else if (step.awaitRequest !== undefined) {
				const entry = await run.awaitRequest(
					step.awaitRequest,
					step.sinceMark ? answeredAtMark : (step.from ?? 0),
					step.orDialog ? dialogsAtClick : null,
				);
				if (entry.dialog !== undefined) {
					// The page answered with a dialog. Once it is quiet, a request
					// it still sent after the dialog is awaited as any other; one
					// it never sent is unsent.
					await run.idle();
					const sent = run.answeredRequest(step.awaitRequest, step.from ?? 0);
					if (sent !== undefined) {
						outcome.request = sent;
					} else {
						outcome.unsent = entry.dialog;
						unsent = true;
					}
				} else {
					outcome.request = entry;
				}
			} else if (step.followRedirect !== undefined) {
				// When HQ's answer to the request sent the page elsewhere, the
				// redirected document has loaded.
				const entry = await run.awaitRequest(
					step.followRedirect,
					step.from ?? 0,
				);
				outcome.redirect = entry.redirect ?? null;
				if (entry.redirectLoaded) await entry.redirectLoaded;
			} else if (step.settle !== undefined) {
				await runQuiet(run, Boolean(step.timers));
			} else {
				throw new StepFailed(
					"request",
					`Step ${index} names no action the driver knows: ${JSON.stringify(step)}.`,
				);
			}
		} catch (error) {
			if (error instanceof StepFailed)
				throw Object.assign(error, { outcomes, failedStep: index });
			throw Object.assign(
				new StepFailed(
					timeoutKind(error),
					`Step ${index} (${JSON.stringify(step).slice(0, 300)}) failed: ${error.message}`,
				),
				{
					outcomes,
					failedStep: index,
				},
			);
		}
		outcome.seconds = (Date.now() - started) / 1000;
		outcomes.push(outcome);
	}
	return outcomes;
}

async function runOperation(message) {
	const run = new PageRun(Date.now() + (message.deadlineMs ?? 60000));
	runPages += 1;
	const name = `run-${runPages}`;
	const owner = {
		name,
		serving: run,
		statics: { editors: 0, missing: 0 },
		close: async () => {},
	};
	RUN_PAGES.set(name, owner);
	const context = await browser.newContext({
		baseURL: ORIGIN,
		javaScriptEnabled: true,
		// Every request the run's page sends names it (RUN_PAGES).
		extraHTTPHeaders: { [PAGE_HEADER]: name },
		// The window the run's pages are laid out in (a phone's, for what a
		// worker sees on a small screen), or Playwright's own desktop window.
		...(message.viewport ? { viewport: message.viewport } : {}),
	});
	const started = Date.now();
	let outcomes = [];
	let failure = null;
	try {
		const cookies = message.cookies ?? [];
		if (cookies.length) {
			await context.addCookies(
				cookies.map(({ name, value }) => ({ name, value, url: ORIGIN })),
			);
		}
		await context.addInitScript({ content: stepCall("page/polls") });
		if (message.timers) {
			await context.addInitScript({ content: stepCall("page/timers") });
		}
		if (message.seed) {
			await context.addInitScript({
				content: stepCall("page/seed", message.seed),
			});
		}
		await context.route("**/*", (route) => run.route(route));
		const page = await context.newPage();
		await run.watch(context, page);
		page.on("console", (entry) => {
			if (entry.type() === "error")
				run.consoleErrors.push({
					error: entry.text(),
					url: entry.location()?.url ?? "",
				});
		});
		page.on("dialog", (dialog) => {
			run.dialogs.push({ type: dialog.type(), message: dialog.message() });
			// While a "recover" step takes the page back where a run starts, the
			// page is left as a person leaves it: the page's question whether to
			// leave (a form still open asks) is answered yes. Otherwise every
			// dialog is dismissed and kept for the outcome.
			if (run.leaving) dialog.accept().catch(() => {});
			else dialog.dismiss().catch(() => {});
			run.notify();
		});
		outcomes = await runSteps(page, run, message.steps ?? []);
	} catch (error) {
		failure = error;
		outcomes = error.outcomes ?? outcomes;
	}
	trace(`draining ${run.inFlight.size} requests`);
	await run.drain();
	trace("closing the context");
	await context.close().catch(() => {});
	trace(`closed; draining ${run.inFlight.size} requests`);
	await run.drain();
	// A request of the page that arrives once its run is over is a stray.
	owner.serving = null;
	RUN_PAGES.delete(name);
	failure = withStrays(failure);
	const result = {
		outcomes,
		requests: run.requests,
		pageErrors: run.pageErrors,
		consoleErrors: run.consoleErrors,
		dialogs: run.dialogs,
		seconds: (Date.now() - started) / 1000,
	};
	if (failure) {
		const kind = failure instanceof StepFailed ? failure.kind : "internal";
		return {
			ok: false,
			error: {
				kind,
				message: failure.message,
				failedStep: failure.failedStep ?? null,
				...(failure.strays ? { strays: failure.strays } : {}),
				run: result,
			},
		};
	}
	return { ok: true, result };
}

// -- the rest ----------------------------------------------------------------

function stats() {
	return {
		views: viewPage.stats(),
		vellum: vellumPage.stats(),
		strays,
	};
}

async function handle(message) {
	switch (message.op) {
		case "shutdown":
			send({ id: message.id, ok: true, result: {} });
			await viewPage.close();
			await vellumPage.close();
			await browser.close();
			server.close();
			process.exit(0);
			return;
		case "run":
		case "view":
		case "vellum":
		case "idle": {
			const operate = {
				run: runOperation,
				view: runView,
				vellum: runVellum,
				idle: runIdle,
			}[message.op];
			runningOp = message.op;
			try {
				send({ id: message.id, ...(await operate(message)) });
			} finally {
				runningOp = null;
			}
			return;
		}
		case "static":
			registeredStatics.set(message.path, {
				body: Buffer.from(message.bodyBase64, "base64"),
				contentType: message.contentType,
			});
			send({ id: message.id, ok: true, result: {} });
			return;
		case "stats":
			send({ id: message.id, ok: true, result: stats() });
			return;
		default:
			send({
				id: message.id,
				ok: false,
				error: {
					kind: "request",
					message: `The driver has no operation "${message.op}"; it knows run, view, vellum, idle, static, stats and shutdown.`,
				},
			});
	}
}

let running = null;

function onLine(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		console.error(
			`The editor driver read a line that is not JSON: ${line.slice(0, 200)}`,
		);
		process.exit(2);
	}
	if (message.reply !== undefined) {
		const pending = pendingReplies.get(message.reply);
		if (!pending) {
			console.error(
				`The editor driver got a reply to request ${message.reply}, which it is not waiting on.`,
			);
			process.exit(2);
		}
		pendingReplies.delete(message.reply);
		pending.resolve(message);
		return;
	}
	if (message.phaseReady !== undefined) {
		const pending = pendingPhases.get(message.phaseReady);
		if (!pending) {
			console.error(
				`The editor driver was told phase ${message.phaseReady} is ready, and it is not waiting on it.`,
			);
			process.exit(2);
		}
		pendingPhases.delete(message.phaseReady);
		pending.resolve(message);
		return;
	}
	if (running) {
		send({
			id: message.id,
			ok: false,
			error: {
				kind: "request",
				message: "The driver runs one operation at a time, and one is running.",
			},
		});
		return;
	}
	running = handle(message)
		.catch((error) => {
			send({
				id: message.id,
				ok: false,
				error: { kind: "internal", message: String(error?.stack ?? error) },
			});
		})
		.finally(() => {
			running = null;
		});
}

async function main() {
	server = createServer((request, response) => {
		handleRequest(request, response).catch((error) => {
			console.error(`The origin failed a request: ${error?.stack ?? error}`);
			response.destroy();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	serverPort = server.address().port;
	browser = await chromium.launch({
		headless: true,
		args: [
			`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${serverPort}, MAP * ~NOTFOUND`,
			"--disable-features=BackForwardCache",
		],
	});
	await viewPage.open();
	await viewPage.page.goto(new URL(PROBE_PATH, ORIGIN).href);
	await viewPage.page.goto("about:blank");
	const lines = createInterface({ input: process.stdin });
	lines.on("line", onLine);
	lines.on("close", async () => {
		// Python closed its end: nothing more will be asked or answered.
		for (const pending of pendingReplies.values())
			pending.reject(new Error("The Python client went away."));
		for (const pending of pendingPhases.values())
			pending.reject(new Error("The Python client went away."));
		await browser.close().catch(() => {});
		process.exit(0);
	});
	send({
		ready: true,
		chromium: browser.version(),
		playwright: playwrightVersion,
		origin: ORIGIN,
		port: serverPort,
		editors: EDITORS,
		navigationHeaders: probeHeaders,
		recycleLoads: RECYCLE_LOADS,
		vellumRecycleRuns: VELLUM_RECYCLE_RUNS,
		latencyMs: LATENCY_MS,
	});
}

main().catch((error) => {
	console.error(
		`The editor driver could not start Chromium: ${error?.stack ?? error}`,
	);
	process.exit(1);
});
