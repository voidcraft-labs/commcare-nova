/**
 * The per-instance realtime LISTEN connection + in-process dispatcher.
 *
 * One dedicated `pg.Client` per process (built from the SAME config source as
 * the case-store pool via `buildDedicatedClientConfig`) holds a persistent
 * `LISTEN nova_app_stream; LISTEN nova_presence; LISTEN nova_chat_stream;
 * LISTEN nova_lookup_stream;`. The commit paths poke the channels only after
 * their authoritative rows are visible; this module fans each poke out to the
 * in-process subscribers registered by the `/stream` relay routes.
 *
 * The connection is DEDICATED and lives outside the pool: LISTEN state is
 * per-connection, so a pooled connection Kysely reclaims per query can't hold
 * it. It is lazy — built on the first subscriber — and shared by every open
 * stream in the process (the relay is a fan-out point, not one connection per
 * tab).
 *
 * The pokes carry only identity plus an advisory cursor/revision; no data rides
 * a channel (Postgres caps a NOTIFY payload at 8000 bytes). Every subscriber
 * treats a poke as "re-query authoritative state", so reconnect catch-up uses
 * `0` / `"0"`. When the LISTEN connection re-establishes, every subscriber is
 * poked once and state committed during the gap converges on its next SELECT.
 */

import { Client, type ClientConfig } from "pg";
import { buildDedicatedClientConfig } from "@/lib/case-store/postgres/connection";
import { log } from "@/lib/logger";
import { LOOKUP_REVISION_MAX } from "@/lib/lookup/constants";
import {
	APP_STREAM_CHANNEL,
	CHAT_STREAM_CHANNEL,
	LOOKUP_STREAM_CHANNEL,
	PRESENCE_CHANNEL,
} from "./pg";

/** One open stream's callbacks. A poke re-queries; the args are advisory. */
interface Subscriber {
	readonly onMutationPoke: (seq: number) => void;
	readonly onPresencePoke: () => void;
}

/** appId → the streams currently open for it in this process. */
const subscribers = new Map<string, Set<Subscriber>>();

/** streamId → the chat-stream tailers currently open for it in this process.
 *  Same poke semantics as the app-stream map: a poke means "re-SELECT from
 *  your cursor", so a dropped notification degrades to the next poke or the
 *  reconnect catch-up, never to lost chunks. */
const chatSubscribers = new Map<string, Set<() => void>>();

/** projectId → the lookup-manifest readers open for it in this process.
 * Revisions remain decimal strings end to end because the Project clock is a
 * Postgres bigint and can exceed JavaScript's safe-integer range. */
const lookupSubscribers = new Map<string, Set<(revision: string) => void>>();

/** The dedicated LISTEN connection; `null` until the first subscriber builds it. */
let client: Client | null = null;
/** In-flight `establish()` so concurrent first-callers share one connect. */
let connecting: Promise<void> | null = null;
/**
 * Bounded closure of a discarded dedicated client. A replacement awaits this
 * barrier before it is even constructed, so old and new listener connections
 * never overlap against the exact-fit Cloud SQL connection budget.
 */
let closing: Promise<void> | null = null;
/** Pending reconnect; `.unref()`ed so it never keeps the process alive. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Grows the backoff on repeated failures; reset to 0 on a successful connect. */
let reconnectAttempt = 0;
/** Set by `closeStreamListener`; blocks reconnect/dispatch until a new subscribe. */
let torndown = false;
/** Test seam: a connection string the listener uses instead of the pool config. */
let testConnectionString: string | null = null;
/** Test seam: hold the next discarded client open to create a deterministic
 * notification gap while proving replacement waits behind the close barrier. */
let nextCloseBarrierForTests: Promise<void> | null = null;

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/**
 * Bounds on the dedicated client's open-ended operations. Without them a
 * wedged/starved server can hold `establish()` (and with it the `connecting`
 * promise every subscriber joins and `closeStreamListener` awaits) forever,
 * stranding the realtime listener for the process lifetime:
 *
 *   - `CONNECT_TIMEOUT_MS` bounds `Client.connect()` (pg default: no limit).
 *   - `QUERY_TIMEOUT_MS` bounds the four `LISTEN` commands (pg default: no
 *     limit) — instant on a healthy server.
 *   - `END_TIMEOUT_MS` bounds the graceful `end()`'s wait for the server to
 *     close the socket; past it `endClientBounded` destroys the socket.
 *
 * A timed-out attempt rejects into `ensureConnected`'s catch, where
 * `scheduleReconnect`'s backoff owns the retry.
 */
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 5_000;
const END_TIMEOUT_MS = 2_000;

/**
 * End the dedicated client without letting a wedged server hold the caller:
 * graceful Terminate first, then destroy the socket if it hasn't closed within
 * the bound (destroying resolves the pending `end()` via the socket's close).
 * `connection` is real on every `pg.Client` but absent from its public typing.
 */
async function endClientBounded(c: Client): Promise<void> {
	const stream = (
		c as unknown as { connection: { stream: { destroy(): void } } }
	).connection.stream;
	const timer = setTimeout(() => stream.destroy(), END_TIMEOUT_MS);
	timer.unref();
	try {
		await c.end().catch(() => {});
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Detach and close one client behind the process-wide close barrier. Calls are
 * serialized defensively: today only one client can be live, and preserving
 * that property during later refactors is part of the connection-budget
 * contract.
 */
function closeClientSerialized(c: Client): Promise<void> {
	c.removeAllListeners("error");
	c.removeAllListeners("notification");
	const previous = closing;
	const testBarrier = nextCloseBarrierForTests;
	nextCloseBarrierForTests = null;
	const operation = (async () => {
		if (previous !== null) await previous;
		if (testBarrier !== null) await testBarrier;
		await endClientBounded(c);
	})();
	const tracked = operation.finally(() => {
		if (closing === tracked) closing = null;
	});
	closing = tracked;
	return tracked;
}

/**
 * Point the dedicated listener at an explicit connection string (the per-test
 * Postgres). Pass `null` to clear. Tests drive the REAL LISTEN/NOTIFY path
 * against the testcontainer through this seam rather than the Cloud SQL
 * connector.
 */
export function __setListenerConfigForTests(
	connectionString: string | null,
): void {
	testConnectionString = connectionString;
}

/** Hold only the next listener close. The integration suite uses this to make
 * the otherwise tiny reconnect gap deterministic while committing durable state. */
export function __setNextListenerCloseBarrierForTests(
	barrier: Promise<void> | null,
): void {
	nextCloseBarrierForTests = barrier;
}

/** Simulate the dedicated client's unexpected-error path without reaching into
 * node-postgres internals from a route integration test. */
export function __forceListenerDisconnectForTests(): void {
	if (client === null) {
		throw new Error(
			"Cannot disconnect a stream listener that is not connected.",
		);
	}
	handleClientError(new Error("Forced stream-listener disconnect for test."));
}

async function resolveConfig(): Promise<ClientConfig> {
	if (testConnectionString !== null) {
		return {
			connectionString: testConnectionString,
			connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
			query_timeout: QUERY_TIMEOUT_MS,
		};
	}
	return {
		...(await buildDedicatedClientConfig()),
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
		query_timeout: QUERY_TIMEOUT_MS,
	};
}

/** Run a subscriber callback, never letting a throw escape the dispatcher. */
function safeCall(fn: () => void): void {
	try {
		fn();
	} catch (err) {
		log.warn("[streamListener] subscriber callback threw", {
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Fan a single notification out to the appId's subscribers. */
function dispatch(appId: string, fn: (sub: Subscriber) => void): void {
	const set = subscribers.get(appId);
	if (set === undefined) return;
	for (const sub of set) safeCall(() => fn(sub));
}

/** Poke EVERY subscriber to re-query from its cursor (initial connect + reconnect). */
function dispatchCatchUpAll(): void {
	for (const set of subscribers.values()) {
		for (const sub of set) {
			safeCall(() => sub.onMutationPoke(0));
			safeCall(() => sub.onPresencePoke());
		}
	}
	for (const set of chatSubscribers.values()) {
		for (const onPoke of set) safeCall(onPoke);
	}
	for (const set of lookupSubscribers.values()) {
		for (const onPoke of set) safeCall(() => onPoke("0"));
	}
}

function onNotification(msg: { channel: string; payload?: string }): void {
	if (!msg.payload) return;
	let parsed: {
		appId?: unknown;
		seq?: unknown;
		streamId?: unknown;
		projectId?: unknown;
		revision?: unknown;
	};
	try {
		parsed = JSON.parse(msg.payload);
	} catch (err) {
		log.warn("[streamListener] unparseable notification payload", {
			channel: msg.channel,
			err: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	if (msg.channel === CHAT_STREAM_CHANNEL) {
		const streamId = parsed.streamId;
		if (typeof streamId !== "string") return;
		const set = chatSubscribers.get(streamId);
		if (set === undefined) return;
		for (const onPoke of set) safeCall(onPoke);
		return;
	}
	if (msg.channel === LOOKUP_STREAM_CHANNEL) {
		const { projectId, revision } = parsed;
		if (
			typeof projectId !== "string" ||
			projectId.length === 0 ||
			typeof revision !== "string" ||
			!/^(?:0|[1-9]\d*)$/.test(revision) ||
			BigInt(revision) > LOOKUP_REVISION_MAX
		)
			return;
		const set = lookupSubscribers.get(projectId);
		if (set === undefined) return;
		for (const onPoke of set) safeCall(() => onPoke(revision));
		return;
	}
	const appId = parsed.appId;
	if (typeof appId !== "string") return;
	if (msg.channel === APP_STREAM_CHANNEL) {
		const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
		dispatch(appId, (sub) => sub.onMutationPoke(seq));
	} else if (msg.channel === PRESENCE_CHANNEL) {
		dispatch(appId, (sub) => sub.onPresencePoke());
	}
}

/** Connect a fresh client, LISTEN on all channels, and fire the catch-up poke. */
async function establish(): Promise<void> {
	// A dropped connection may still be inside its bounded graceful close. Do
	// not even construct the replacement until that socket is gone: the Cloud
	// SQL budget has exactly one slot for this process-wide listener.
	const pendingClose = closing;
	if (pendingClose !== null) await pendingClose;
	if (torndown) return;
	const config = await resolveConfig();
	const c = new Client(config);
	c.on("error", handleClientError);
	c.on("notification", onNotification);
	try {
		await c.connect();
		await c.query(`LISTEN ${APP_STREAM_CHANNEL}`);
		await c.query(`LISTEN ${PRESENCE_CHANNEL}`);
		await c.query(`LISTEN ${CHAT_STREAM_CHANNEL}`);
		await c.query(`LISTEN ${LOOKUP_STREAM_CHANNEL}`);
	} catch (err) {
		/* A throw AFTER a successful connect (a LISTEN query failing) would
		 * otherwise leak a live connection that was never latched into `client`
		 * — and its still-attached error handler would later discard the
		 * CURRENT healthy client. End it before the reconnect path takes over. */
		await closeClientSerialized(c);
		throw err;
	}
	// Torn down while we were connecting — discard this client rather than latch
	// it. The check + assignment are synchronous (no await between), so a
	// concurrent `closeStreamListener` either wins here or clears `client` after.
	if (torndown) {
		await closeClientSerialized(c);
		return;
	}
	client = c;
	reconnectAttempt = 0;
	// Every reconnect (and the initial connect) re-primes each subscriber: pokes
	// dropped during the gap are covered because a poke means "re-query from my
	// cursor", so nothing committed in the gap is lost.
	dispatchCatchUpAll();
}

/** Ensure a connection exists; on failure, schedule a backoff reconnect. */
async function ensureConnected(): Promise<void> {
	if (client !== null || torndown) return;
	if (connecting !== null) return connecting;
	connecting = establish()
		.catch((err) => {
			log.warn("[streamListener] initial connect failed (will retry)", {
				err: err instanceof Error ? err.message : String(err),
			});
			scheduleReconnect();
		})
		.finally(() => {
			connecting = null;
		});
	return connecting;
}

/** Drop the current client (a dead LISTEN connection) without touching state. */
function discardClient(): Promise<void> {
	const c = client;
	client = null;
	return c === null ? Promise.resolve() : closeClientSerialized(c);
}

/** The LISTEN connection errored/dropped — tear it down and reconnect. */
function handleClientError(err: Error): void {
	if (torndown) return;
	log.warn("[streamListener] listen connection error (reconnecting)", {
		err: err.message,
	});
	void discardClient();
	scheduleReconnect();
}

function scheduleReconnect(): void {
	if (torndown || reconnectTimer !== null || client !== null) return;
	const delayMs = Math.min(
		RECONNECT_MAX_MS,
		RECONNECT_MIN_MS * 2 ** reconnectAttempt,
	);
	reconnectAttempt += 1;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		if (torndown || client !== null) return;
		/* Route through `ensureConnected` so this establish is recorded in
		 * `connecting` — a subscriber arriving mid-reconnect joins the same
		 * in-flight attempt instead of launching a second client that would
		 * overwrite (and leak) whichever latched first. Its catch already logs
		 * and schedules the next backoff. */
		void ensureConnected();
	}, delayMs);
	// Never let a pending reconnect keep the process (or a test worker) alive.
	reconnectTimer.unref();
}

/**
 * Subscribe an open `/stream` connection to this app's realtime pokes. Registers
 * the callbacks, lazily connects the shared LISTEN client on the first
 * subscriber, and returns an idempotent unsubscribe. The connection is KEPT when
 * the last subscriber leaves (a cheap idle LISTEN is worth more than a
 * reconnect on the next open) — only `closeStreamListener` tears it down.
 */
export function subscribeAppStream(
	appId: string,
	onMutationPoke: (seq: number) => void,
	onPresencePoke: () => void,
): () => void {
	// A new subscriber intends the listener alive — re-arm after a prior teardown.
	torndown = false;
	const sub: Subscriber = { onMutationPoke, onPresencePoke };
	let set = subscribers.get(appId);
	if (set === undefined) {
		set = new Set();
		subscribers.set(appId, set);
	}
	set.add(sub);

	// Lazy connect; failure schedules its own retry inside `ensureConnected`.
	void ensureConnected();

	let unsubscribed = false;
	return () => {
		if (unsubscribed) return;
		unsubscribed = true;
		const current = subscribers.get(appId);
		if (current === undefined) return;
		current.delete(sub);
		if (current.size === 0) subscribers.delete(appId);
	};
}

/**
 * Subscribe an open resumable-chat-stream connection to a stream's chunk-flush
 * pokes (`nova_chat_stream`). Same shared LISTEN client, lazy connect, and
 * idempotent unsubscribe as `subscribeAppStream`.
 */
export function subscribeChatStream(
	streamId: string,
	onPoke: () => void,
): () => void {
	torndown = false;
	let set = chatSubscribers.get(streamId);
	if (set === undefined) {
		set = new Set();
		chatSubscribers.set(streamId, set);
	}
	set.add(onPoke);

	void ensureConnected();

	let unsubscribed = false;
	return () => {
		if (unsubscribed) return;
		unsubscribed = true;
		const current = chatSubscribers.get(streamId);
		if (current === undefined) return;
		current.delete(onPoke);
		if (current.size === 0) chatSubscribers.delete(streamId);
	};
}

/**
 * Subscribe to Project-wide lookup-manifest invalidations. The callback gets
 * the exact decimal revision from Postgres; `"0"` is the advisory catch-up
 * sentinel fired after an initial connect or reconnect. In either case the
 * subscriber re-reads the authoritative full manifest.
 */
export function subscribeLookupProject(
	projectId: string,
	onPoke: (revision: string) => void,
): () => void {
	torndown = false;
	let set = lookupSubscribers.get(projectId);
	if (set === undefined) {
		set = new Set();
		lookupSubscribers.set(projectId, set);
	}
	set.add(onPoke);

	void ensureConnected();

	let unsubscribed = false;
	return () => {
		if (unsubscribed) return;
		unsubscribed = true;
		const current = lookupSubscribers.get(projectId);
		if (current === undefined) return;
		current.delete(onPoke);
		if (current.size === 0) lookupSubscribers.delete(projectId);
	};
}

/**
 * Tear down the dedicated LISTEN connection and cancel any pending reconnect.
 * For tests (and process teardown): drops every subscriber, ends the client, and
 * cancels the backoff timer so nothing survives into the next per-test database.
 * The next subscription re-arms and reconnects fresh.
 */
export async function closeStreamListener(): Promise<void> {
	torndown = true;
	nextCloseBarrierForTests = null;
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	reconnectAttempt = 0;
	subscribers.clear();
	chatSubscribers.clear();
	lookupSubscribers.clear();
	// Await any in-flight connect so a client it establishes can't latch AFTER
	// this returns (its own `torndown` check discards it, but awaiting closes the
	// race window against the next test's connection).
	const pending = connecting;
	if (pending !== null) await pending.catch(() => {});
	connecting = null;
	const c = client;
	client = null;
	if (c !== null) {
		// The connection may already be dead (e.g. a per-test database dropped
		// out from under it) — a failed `end()` is expected teardown noise.
		await closeClientSerialized(c);
	}
	const pendingClose = closing;
	if (pendingClose !== null) await pendingClose.catch(() => {});
}
