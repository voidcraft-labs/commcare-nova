/**
 * The relay `/stream` route against a real Postgres testcontainer — the SSE
 * channel every builder session opens, now driven by LISTEN/NOTIFY.
 *
 * What this pins against a REAL Postgres LISTEN/NOTIFY (a mocked listen can't):
 *
 *   - Replay from a cursor: a committed `accepted_mutations` row past the cursor
 *     is delivered as an `event: mutation` frame carrying `id:<seq>`.
 *   - LIVE delivery: a `commitGuardedBatch` after the stream is open pokes
 *     `nova_app_stream`, the dedicated LISTEN connection dispatches it, and the
 *     route's pump SELECTs + emits the new batch — end-to-end NOTIFY delivery.
 *   - Reload below retention: a cursor under `head − RETENTION_COUNT` emits
 *     `event: reload` and closes without replaying.
 *   - Reconnect via `Last-Event-ID`: the header sets the cursor, so a reconnect
 *     resumes past the frames it already saw.
 *   - A migration sentinel (empty `mutations`, `kind:'migration'`) emits
 *     `event: reload`, not a `mutation` frame.
 *   - A gap (first delivered seq isn't cursor+1) emits `event: reload`.
 *   - Bounded revocation, CONFIRMED-only: a ban (`isUserActive → false`), a
 *     membership loss (`AppAccessError`), and a session-identity change each
 *     close the stream with `event: revoked`; a TRANSIENT blip (a null session,
 *     an `isUserActive` throw, a non-`AppAccessError` scope throw) does NOT.
 *   - The mutation frame carries the projected reconciler shape — `runId` ridden
 *     through, no server-only `ts` on the wire.
 *   - Presence roster snapshots in the projected client shape (`updatedAt` is
 *     epoch millis, no `expire_at`); a row with a malformed `location` is
 *     skipped and the roster continues.
 *   - A connect-time scope denial → 404 (IDOR-safe), not a 500.
 *   - Teardown: a `req.signal` abort tears down the subscription + the intervals
 *     (no leaked async resource).
 *
 * `requireSession` / `getSessionSafe` / `resolveAppScope` / `isUserActive` are
 * mocked — the relay only needs the app row, the stream log, and the presence
 * rows, all of which live in the per-test Postgres. The route's own logic
 * (cursor parsing, frame shaping, the reload triggers, the confirmed-only
 * cadence, teardown) plus the REAL LISTEN/NOTIFY path are the code under test.
 *
 * Runs on the per-test-database harness booted by the case-store testcontainer
 * `globalSetup` — the app-state migrations create the `apps` / `accepted_mutations`
 * / `presence` tables; the data layer is pointed at the per-test database via
 * `__setAppDbForTests`, and the dedicated LISTEN client at the same database via
 * `__setListenerConfigForTests`.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	createPerTestAppDb,
	type PerTestAppDb,
} from "@/lib/db/__tests__/perTestAppDb";
import { RETENTION_COUNT } from "@/lib/db/constants";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";

// ── Auth mocks (no Better Auth / membership tables for the relay) ──────────
const {
	requireSessionMock,
	getSessionSafeMock,
	resolveAppScopeMock,
	isUserActiveMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	getSessionSafeMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	isUserActiveMock: vi.fn(),
}));

/* A real `AppAccessError` (the cadence revokes ONLY on this class, so the mock
 * must throw the genuine one for the `instanceof` gate to fire). */
class MockAppAccessError extends Error {
	readonly name = "AppAccessError";
	constructor(readonly reason: string) {
		super(reason);
	}
}

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
	getSessionSafe: getSessionSafeMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	resolveAppScope: resolveAppScopeMock,
	AppAccessError: MockAppAccessError,
}));
vi.mock("@/lib/db/api-keys", () => ({
	isUserActive: isUserActiveMock,
}));

/* The route reads its revocation cadence from `NOVA_STREAM_CADENCE_MS` at
 * MODULE LOAD, so set it before the dynamic import below — a short cadence lets
 * the revocation tests observe a `revoked` frame in well under a second instead
 * of waiting the prod ~10 s. Prod never sets this var. */
process.env.NOVA_STREAM_CADENCE_MS = "150";

const { GET } = await import("../route");
const { POST: presencePost } = await import("../../presence/route");
const { __setListenerConfigForTests, closeStreamListener } = await import(
	"@/lib/db/streamListener"
);
const { createApp, commitGuardedBatch } = await import("@/lib/db/apps");

const USER = "user-1";
const OTHER_USER = "user-2";
const PROJECT = "project-1";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "stream_relay_" });

let appDb: Kysely<AppDatabase>;
let harness: PerTestAppDb;

/** A minimal session shape the route reads (`session.user.id`). */
function sessionFor(userId: string) {
	return { user: { id: userId } } as never;
}

/**
 * Seed a stored app at `head` `mutation_seq`, owner USER, null Project (so a
 * later `commitGuardedBatch` takes the owner path and needs no auth read).
 * Uses `createApp` (the real write path) then raw-updates the seq + Project.
 */
async function seedApp(head: number): Promise<string> {
	const appId = await createApp(USER, PROJECT, "run-seed", {
		status: "complete",
	});
	await appDb
		.updateTable("apps")
		.set({ mutation_seq: head, project_id: null })
		.where("id", "=", appId)
		.execute();
	return appId;
}

/** Insert one `accepted_mutations` row directly (a real delta unless migration). */
async function writeEntry(
	appId: string,
	seq: number,
	opts: { kind?: "autosave" | "chat" | "migration"; runId?: string } = {},
): Promise<void> {
	const kind = opts.kind ?? "autosave";
	await appDb
		.insertInto("accepted_mutations")
		.values({
			app_id: appId,
			seq,
			batch_id: crypto.randomUUID(),
			run_id: opts.runId ?? null,
			actor_id: USER,
			kind,
			mutations: JSON.stringify(
				kind === "migration" ? [] : [{ kind: "setAppName", name: `v${seq}` }],
			),
		})
		.execute();
}

/** Insert one `presence` row directly. */
async function writePresence(
	appId: string,
	sessionId: string,
	opts: { location?: unknown; updatedAt?: Date } = {},
): Promise<void> {
	const now = new Date();
	await appDb
		.insertInto("presence")
		.values({
			app_id: appId,
			user_id: USER,
			session_id: sessionId,
			name: "Ada",
			image: null,
			email: "ada@dimagi.com",
			color: "#123456",
			location: JSON.stringify(opts.location ?? { kind: "home" }),
			updated_at: opts.updatedAt ?? now,
			expire_at: new Date(now.getTime() + 60_000),
		})
		.execute();
}

/** One parsed SSE frame. */
interface Frame {
	event: string;
	id?: string;
	data: unknown;
}

/** Parse the raw SSE text into frames (split on the blank-line record boundary). */
function parseFrames(raw: string): Frame[] {
	const frames: Frame[] = [];
	for (const block of raw.split("\n\n")) {
		if (!block.trim()) continue;
		const frame: Partial<Frame> = {};
		for (const line of block.split("\n")) {
			if (line.startsWith("event: ")) frame.event = line.slice(7);
			else if (line.startsWith("id: ")) frame.id = line.slice(4);
			else if (line.startsWith("data: "))
				frame.data = JSON.parse(line.slice(6));
		}
		if (frame.event) frames.push(frame as Frame);
	}
	return frames;
}

/**
 * Open the stream and collect frames until `predicate` is satisfied or the
 * timeout elapses. Returns the frames and the `AbortController` driving
 * `req.signal` (so a test can assert teardown). Always cancels the reader.
 */
async function collectUntil(
	appId: string,
	opts: {
		userId?: string;
		since?: number;
		lastEventId?: string;
		predicate: (frames: Frame[]) => boolean;
		timeoutMs?: number;
		onOpen?: (frames: () => Frame[]) => Promise<void> | void;
	},
): Promise<{ frames: Frame[]; controller: AbortController }> {
	const controller = new AbortController();
	const headers = new Headers();
	if (opts.lastEventId) headers.set("Last-Event-ID", opts.lastEventId);
	const url = new URL(`http://localhost/api/apps/${appId}/stream`);
	if (opts.since !== undefined)
		url.searchParams.set("since", String(opts.since));
	const req = new Request(url, { headers, signal: controller.signal });

	requireSessionMock.mockResolvedValue(sessionFor(opts.userId ?? USER));

	const res = await GET(req, { params: Promise.resolve({ id: appId }) });
	const reader = res.body?.getReader();
	if (!reader) throw new Error("stream had no body");

	const decoder = new TextDecoder();
	let raw = "";
	const frames: Frame[] = [];
	// Default under vitest's body timeout so a never-satisfied predicate surfaces
	// as an assertion, not an opaque body-timeout. A deadline timer aborts the
	// controller, which ends the stream so the pending `read()` resolves `done`
	// and the loop exits — NEVER race `read()` against a timeout.
	const timeoutMs = opts.timeoutMs ?? 4_000;
	const deadline = setTimeout(() => controller.abort(), timeoutMs);

	// Kick off any side effect that should happen once the stream is open (e.g.
	// committing a batch the LISTEN should then deliver).
	const opened = Promise.resolve(opts.onOpen?.(() => frames));

	try {
		while (true) {
			const chunk = await reader.read().catch(() => ({
				done: true as const,
				value: undefined,
			}));
			if (chunk.value) {
				raw += decoder.decode(chunk.value, { stream: true });
				frames.length = 0;
				frames.push(...parseFrames(raw));
				if (opts.predicate(frames)) break;
			}
			if (chunk.done) break;
		}
	} finally {
		clearTimeout(deadline);
		controller.abort();
		await reader.cancel().catch(() => {});
		// Surface an onOpen rejection (a failed commit) rather than letting it
		// masquerade as "no frame delivered".
		await opened;
	}
	return { frames, controller };
}

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
	harness = createPerTestAppDb(dbHandle.uri);
	appDb = harness.appDb;
	__setAppDbForTests(appDb);
	__setListenerConfigForTests(dbHandle.uri);

	requireSessionMock.mockReset();
	getSessionSafeMock.mockReset();
	resolveAppScopeMock.mockReset();
	isUserActiveMock.mockReset();
	// Default: the actor is a live, active, authorized member.
	getSessionSafeMock.mockResolvedValue(sessionFor(USER));
	isUserActiveMock.mockResolvedValue(true);
	resolveAppScopeMock.mockResolvedValue({
		projectId: PROJECT,
		role: "editor",
		actorUserId: USER,
	});
});

afterEach(async () => {
	// Close the dedicated LISTEN client BEFORE the per-test DROP DATABASE — a
	// leaked LISTEN connection would be force-terminated by the drop and its
	// reconnect timer would spin against a vanished database. `harness.destroy()`
	// quiesces the pool before ending it: the ordinary straggling pump/roster
	// read would otherwise race `Pool.end()` and orphan a mid-connect client,
	// which `end()` then waits on forever — see `perTestAppDb.ts`.
	await closeStreamListener();
	__setListenerConfigForTests(null);
	__setAppDbForTests(null);
	await harness.destroy();
});

describe("/stream relay (Postgres LISTEN/NOTIFY)", () => {
	it("replays committed entries past the cursor as mutation frames with id:<seq>", async () => {
		const appId = await seedApp(3);
		await writeEntry(appId, 1);
		await writeEntry(appId, 2);
		await writeEntry(appId, 3);

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.filter((x) => x.event === "mutation").length >= 3,
		});

		const mutations = frames.filter((f) => f.event === "mutation");
		expect(mutations.map((f) => f.id)).toEqual(["1", "2", "3"]);
		expect((mutations[0]?.data as { seq: number }).seq).toBe(1);
	});

	it("delivers a live commit after the stream is open (real NOTIFY end-to-end)", async () => {
		const appId = await seedApp(0);

		const { frames } = await collectUntil(appId, {
			since: 0,
			async onOpen() {
				// Let the dedicated LISTEN connection attach, then commit a batch the
				// commit's `pg_notify` should deliver as a live `mutation` frame.
				await delay(300);
				await commitGuardedBatch({
					appId,
					batchId: crypto.randomUUID(),
					mutations: [{ kind: "setAppName", name: "Live" }],
					actorUserId: USER,
					kind: "autosave",
				});
			},
			predicate: (f) => f.some((x) => x.event === "mutation" && x.id === "1"),
		});

		const frame = frames.find((f) => f.event === "mutation" && f.id === "1");
		expect(frame).toBeDefined();
		expect((frame?.data as { mutations: unknown[] }).mutations).toEqual([
			{ kind: "setAppName", name: "Live" },
		]);
	});

	it("delivers a live presence roster frame after a POST to the presence route (real NOTIFY)", async () => {
		const appId = await seedApp(0);
		const sessionId = crypto.randomUUID();

		const { frames } = await collectUntil(appId, {
			since: 0,
			async onOpen() {
				// Let the LISTEN attach, then POST presence through the real route —
				// its `notifyPresence` poke should drive a live roster frame.
				await delay(300);
				const res = await presencePost(
					new Request(`http://localhost/api/apps/${appId}/presence`, {
						method: "POST",
						body: JSON.stringify({
							sessionId,
							name: "Ada",
							color: "#abcdef",
							location: { kind: "home" },
						}),
					}),
					{ params: Promise.resolve({ id: appId }) },
				);
				await res.text();
			},
			predicate: (f) =>
				f.some(
					(x) =>
						x.event === "presence" &&
						(x.data as { sessionId?: string }[]).some(
							(p) => p.sessionId === sessionId,
						),
				),
		});

		const presence = frames.filter((f) => f.event === "presence").at(-1);
		const roster = presence?.data as { sessionId: string }[];
		expect(roster.map((p) => p.sessionId)).toContain(sessionId);
	});

	it("reloads (no replay) when the cursor is below the retention window", async () => {
		// Head far above the cursor + retention window: replaying that many
		// permanent batches is slower than a blueprint reload, so the route reloads.
		const head = RETENTION_COUNT + 50;
		const appId = await seedApp(head);

		const { frames } = await collectUntil(appId, {
			since: 1,
			predicate: (f) => f.some((x) => x.event === "reload"),
		});

		const reload = frames.find((f) => f.event === "reload");
		expect(reload).toBeDefined();
		// A `reload` is seq-less — no `id:` line.
		expect(reload?.id).toBeUndefined();
		expect(frames.some((f) => f.event === "mutation")).toBe(false);
	});

	it("reloads on a gap — the first delivered seq isn't cursor+1", async () => {
		// Head says seq 5 exists but only seq 5 is present; a cursor of 0 expects
		// seq 1 first, so the seq-5 delivery is a hole → reload.
		const appId = await seedApp(5);
		await writeEntry(appId, 5);

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.some((x) => x.event === "reload"),
		});

		expect(frames.some((f) => f.event === "reload")).toBe(true);
		expect(frames.some((f) => f.event === "mutation")).toBe(false);
	});

	it("reloads on a migration sentinel instead of emitting a mutation frame", async () => {
		const appId = await seedApp(1);
		await writeEntry(appId, 1, { kind: "migration" });

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.some((x) => x.event === "reload"),
		});

		expect(frames.some((f) => f.event === "reload")).toBe(true);
		expect(frames.some((f) => f.event === "mutation")).toBe(false);
	});

	it("resumes past already-seen frames on a Last-Event-ID reconnect", async () => {
		const appId = await seedApp(3);
		await writeEntry(appId, 1);
		await writeEntry(appId, 2);
		await writeEntry(appId, 3);

		// Reconnect at Last-Event-ID=2 → only seq 3 replays.
		const { frames } = await collectUntil(appId, {
			lastEventId: "2",
			predicate: (f) => f.some((x) => x.event === "mutation" && x.id === "3"),
		});

		const mutations = frames.filter((f) => f.event === "mutation");
		expect(mutations.map((f) => f.id)).toEqual(["3"]);
	});

	it("mutation frame carries the projected client shape (runId ridden through, no ts)", async () => {
		const appId = await seedApp(1);
		// A chat commit carries a runId — it must ride through for the reconciler's
		// echo classification.
		await writeEntry(appId, 1, { kind: "chat", runId: "run-abc" });

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.some((x) => x.event === "mutation" && x.id === "1"),
		});

		const frame = frames.find((f) => f.event === "mutation");
		const data = frame?.data as Record<string, unknown>;
		// The wire shape is exactly the reconciler-relevant fields.
		expect(Object.keys(data).sort()).toEqual(
			["actorId", "batchId", "kind", "mutations", "runId", "seq"].sort(),
		);
		expect(data.runId).toBe("run-abc");
		expect(data.actorId).toBe(USER);
		// The server-only `ts` timestamp never reaches the wire.
		expect(data).not.toHaveProperty("ts");
	});

	it("delivers presence roster snapshots in the projected client shape (updatedAt epoch millis, no expireAt)", async () => {
		const appId = await seedApp(0);
		await writePresence(appId, "sess-a", {
			updatedAt: new Date(1_700_000_000_000),
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) =>
				f.some(
					(x) => x.event === "presence" && (x.data as unknown[]).length >= 1,
				),
		});

		const presence = frames.filter((f) => f.event === "presence").at(-1);
		const entry = (presence?.data as Record<string, unknown>[])[0];
		expect(entry?.userId).toBe(USER);
		// The wire shape is exactly the reconciler/presence-relevant fields —
		// `updatedAt` is epoch MILLIS (a number the client does `now − updatedAt`
		// arithmetic on).
		expect(Object.keys(entry ?? {}).sort()).toEqual(
			[
				"color",
				"email",
				"image",
				"location",
				"name",
				"sessionId",
				"updatedAt",
				"userId",
			].sort(),
		);
		expect(typeof entry?.updatedAt).toBe("number");
		expect(entry?.updatedAt).toBe(1_700_000_000_000);
		// Server-only TTL metadata never reaches the wire.
		expect(entry).not.toHaveProperty("expireAt");
		expect(entry).not.toHaveProperty("expire_at");
	});

	it("skips a presence row with a malformed location and continues the roster", async () => {
		const appId = await seedApp(0);
		await writePresence(appId, "good");
		// A row whose `location` jsonb fails `locationSchema.parse` — best-effort:
		// skip the bad row, keep the good one, never throw the whole roster.
		await writePresence(appId, "bad", {
			location: { kind: "not-a-real-kind" },
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 3_000,
			predicate: (f) =>
				f.some(
					(x) =>
						x.event === "presence" &&
						(x.data as { sessionId?: string }[]).some(
							(p) => p.sessionId === "good",
						),
				),
		});

		const presence = frames.filter((f) => f.event === "presence").at(-1);
		const roster = presence?.data as { sessionId: string }[];
		expect(roster.map((p) => p.sessionId)).toContain("good");
		expect(roster.map((p) => p.sessionId)).not.toContain("bad");
	});

	it("revokes within the cadence on a CONFIRMED ban (isUserActive → false)", async () => {
		const appId = await seedApp(0);
		// The ban lands after connect: `isUserActive` reads a definitively
		// banned/deleted user.
		isUserActiveMock.mockResolvedValue(false);

		const { frames } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 3_000,
			predicate: (f) => f.some((x) => x.event === "revoked"),
		});

		expect(frames.some((f) => f.event === "revoked")).toBe(true);
	});

	it("revokes within the cadence when membership is lost (resolveAppScope throws AppAccessError)", async () => {
		const appId = await seedApp(0);
		// Connect-time scope passes; the cadence re-check then denies with a REAL
		// `AppAccessError` (the only membership-loss signal that revokes).
		resolveAppScopeMock
			.mockResolvedValueOnce({
				projectId: PROJECT,
				role: "editor",
				actorUserId: USER,
			})
			.mockRejectedValue(new MockAppAccessError("not_member"));

		const { frames } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 3_000,
			predicate: (f) => f.some((x) => x.event === "revoked"),
		});

		expect(frames.some((f) => f.event === "revoked")).toBe(true);
	});

	it("revokes when a different user's session is resolved on the cadence re-check", async () => {
		const appId = await seedApp(0);
		// A cookie that now resolves to a DIFFERENT user — the cadence closes on
		// the identity mismatch.
		getSessionSafeMock.mockResolvedValue(sessionFor(OTHER_USER));

		const { frames } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 3_000,
			predicate: (f) => f.some((x) => x.event === "revoked"),
		});

		expect(frames.some((f) => f.event === "revoked")).toBe(true);
	});

	it("does NOT revoke on a TRANSIENT backend blip (a non-AppAccessError throw, a null session, an isUserActive throw)", async () => {
		const appId = await seedApp(0);
		// Every cadence signal is transient/ambiguous — an authorized collaborator
		// must NOT be booted.
		getSessionSafeMock.mockResolvedValue(null);
		isUserActiveMock.mockRejectedValue(new Error("pool exhausted"));
		resolveAppScopeMock
			.mockResolvedValueOnce({
				projectId: PROJECT,
				role: "editor",
				actorUserId: USER,
			})
			.mockRejectedValue(new Error("db blip"));

		// Wait past several cadence ticks (150 ms each) and assert NO revoke.
		const { frames } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 1_500,
			predicate: () => false,
		});

		expect(frames.some((f) => f.event === "revoked")).toBe(false);
	});

	it("returns a 404 (not 500) when the connect-time scope check denies", async () => {
		const appId = await seedApp(0);
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		resolveAppScopeMock.mockRejectedValue(new MockAppAccessError("not_member"));

		const res = await GET(
			new Request(`http://localhost/api/apps/${appId}/stream`),
			{ params: Promise.resolve({ id: appId }) },
		);
		// Drain the error response body so its stream's pull promise settles under
		// the async-leak gate. The early 404 returns bodied JSON (`handleApiError`).
		await res.text();
		expect(res.status).toBe(404);
		expect(res.headers.get("Content-Type")).not.toBe("text/event-stream");
	});

	it("tears down the subscription + intervals on a client abort (no leak)", async () => {
		const appId = await seedApp(1);
		await writeEntry(appId, 1);

		// `collectUntil` aborts the controller in its finally block, driving the
		// route's `req.signal` abort → teardown. Under the async-leak detector an
		// un-cleared interval or an un-unsubscribed listener would surface as a
		// leak pinned to the route; a clean teardown reports none.
		const { controller } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 1_500,
			predicate: (f) => f.some((x) => x.event === "mutation"),
		});

		expect(controller.signal.aborted).toBe(true);
	});
});
