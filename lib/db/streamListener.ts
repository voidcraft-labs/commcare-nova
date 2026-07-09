/**
 * The per-instance realtime LISTEN connection + in-process dispatcher.
 *
 * One dedicated `pg.Client` per process (built from the SAME config source as
 * the case-store pool via `buildDedicatedClientConfig`) holds a persistent
 * `LISTEN nova_app_stream; LISTEN nova_presence;`. The commit path pokes those
 * channels from inside its transaction (`lib/db/pg.ts::notifyAppStream` /
 * `notifyPresence`); this module fans each poke out to the in-process
 * subscribers registered by the `/stream` relay routes.
 *
 * The connection is DEDICATED and lives outside the pool: LISTEN state is
 * per-connection, so a pooled connection Kysely reclaims per query can't hold
 * it. It is lazy — built on the first subscriber — and shared by every open
 * stream in the process (the relay is a fan-out point, not one connection per
 * tab).
 *
 * The poke carries only `(appId, seq?)`; no data rides the channel (Postgres
 * caps a NOTIFY payload at 8000 bytes). Every subscriber treats a poke as
 * "re-query from my cursor", so `seq` is advisory — a catch-up poke passes
 * `0`. That is what makes the reconnect gap loss-free: when the LISTEN
 * connection drops and re-establishes, we poke EVERY subscriber once, and each
 * re-SELECTs everything since its cursor, so no committed batch missed during
 * the gap is lost.
 */

import { Client, type ClientConfig } from "pg";
import { buildDedicatedClientConfig } from "@/lib/case-store/postgres/connection";
import { log } from "@/lib/logger";
import { APP_STREAM_CHANNEL, PRESENCE_CHANNEL } from "./pg";

/** One open stream's callbacks. A poke re-queries; the args are advisory. */
interface Subscriber {
	readonly onMutationPoke: (seq: number) => void;
	readonly onPresencePoke: () => void;
}

/** appId → the streams currently open for it in this process. */
const subscribers = new Map<string, Set<Subscriber>>();

/** The dedicated LISTEN connection; `null` until the first subscriber builds it. */
let client: Client | null = null;
/** In-flight `establish()` so concurrent first-callers share one connect. */
let connecting: Promise<void> | null = null;
/** Pending reconnect; `.unref()`ed so it never keeps the process alive. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Grows the backoff on repeated failures; reset to 0 on a successful connect. */
let reconnectAttempt = 0;
/** Set by `closeStreamListener`; blocks reconnect/dispatch until a new subscribe. */
let torndown = false;
/** Test seam: a connection string the listener uses instead of the pool config. */
let testConnectionString: string | null = null;

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;

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

async function resolveConfig(): Promise<ClientConfig> {
	if (testConnectionString !== null) {
		return { connectionString: testConnectionString };
	}
	return buildDedicatedClientConfig();
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
}

function onNotification(msg: { channel: string; payload?: string }): void {
	if (!msg.payload) return;
	let parsed: { appId?: unknown; seq?: unknown };
	try {
		parsed = JSON.parse(msg.payload);
	} catch (err) {
		log.warn("[streamListener] unparseable notification payload", {
			channel: msg.channel,
			err: err instanceof Error ? err.message : String(err),
		});
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

/** Connect a fresh client, LISTEN on both channels, and fire the catch-up poke. */
async function establish(): Promise<void> {
	const config = await resolveConfig();
	const c = new Client(config);
	c.on("error", handleClientError);
	c.on("notification", onNotification);
	try {
		await c.connect();
		await c.query(`LISTEN ${APP_STREAM_CHANNEL}`);
		await c.query(`LISTEN ${PRESENCE_CHANNEL}`);
	} catch (err) {
		/* A throw AFTER a successful connect (a LISTEN query failing) would
		 * otherwise leak a live connection that was never latched into `client`
		 * — and its still-attached error handler would later discard the
		 * CURRENT healthy client. End it before the reconnect path takes over. */
		c.removeAllListeners("error");
		c.removeAllListeners("notification");
		await c.end().catch(() => {});
		throw err;
	}
	// Torn down while we were connecting — discard this client rather than latch
	// it. The check + assignment are synchronous (no await between), so a
	// concurrent `closeStreamListener` either wins here or clears `client` after.
	if (torndown) {
		c.removeAllListeners("error");
		c.removeAllListeners("notification");
		await c.end().catch(() => {});
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
function discardClient(): void {
	const c = client;
	client = null;
	if (c !== null) {
		c.removeAllListeners("error");
		c.removeAllListeners("notification");
		void c.end().catch(() => {});
	}
}

/** The LISTEN connection errored/dropped — tear it down and reconnect. */
function handleClientError(err: Error): void {
	if (torndown) return;
	log.warn("[streamListener] listen connection error (reconnecting)", {
		err: err.message,
	});
	discardClient();
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
 * Tear down the dedicated LISTEN connection and cancel any pending reconnect.
 * For tests (and process teardown): drops every subscriber, ends the client, and
 * cancels the backoff timer so nothing survives into the next per-test database.
 * The next `subscribeAppStream` re-arms and reconnects fresh.
 */
export async function closeStreamListener(): Promise<void> {
	torndown = true;
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	reconnectAttempt = 0;
	subscribers.clear();
	// Await any in-flight connect so a client it establishes can't latch AFTER
	// this returns (its own `torndown` check discards it, but awaiting closes the
	// race window against the next test's connection).
	const pending = connecting;
	if (pending !== null) await pending.catch(() => {});
	connecting = null;
	const c = client;
	client = null;
	if (c !== null) {
		c.removeAllListeners("error");
		c.removeAllListeners("notification");
		// The connection may already be dead (e.g. a per-test database dropped
		// out from under it) — a failed `end()` is expected teardown noise.
		await c.end().catch(() => {});
	}
}
