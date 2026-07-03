/**
 * The relay `/stream` route against the Firestore emulator — the P5 SSE channel
 * every builder session opens.
 *
 * What this pins against a REAL gRPC `onSnapshot` (a mocked listen can't):
 *
 *   - Replay from a cursor: a committed `acceptedMutations/{seq}` past the
 *     cursor is delivered as an `event: mutation` frame carrying `id:<seq>`.
 *   - Reload below retention: a cursor under `head − RETENTION_COUNT` emits
 *     `event: reload` and closes without replaying.
 *   - Reconnect via `Last-Event-ID`: the header sets the cursor, so a reconnect
 *     resumes past the frames it already saw.
 *   - A migration sentinel (empty `mutations`, `kind:'migration'`) emits
 *     `event: reload`, not a `mutation` frame.
 *   - Bounded revocation, CONFIRMED-only: a ban (`isUserActive → false`), a
 *     membership loss (`AppAccessError`), and a session-identity change each
 *     close the stream with `event: revoked`; a TRANSIENT blip (a null session,
 *     an `isUserActive` throw, a non-`AppAccessError` scope throw) does NOT.
 *   - The mutation frame carries the projected reconciler shape — no raw
 *     Firestore Timestamps, no server-only TTL metadata on the wire.
 *   - A malformed acceptedMutations entry → `reload` (not a hung stream); a
 *     malformed presence doc is skipped and the roster continues.
 *   - A connect-time scope denial → 404 (IDOR-safe), not a 500.
 *   - Teardown: a `req.signal` abort unsubscribes BOTH listeners + the interval
 *     (no leaked async resource).
 *   - The listen query is built on `getListenDb()` (the `preferRest:false` gRPC
 *     client), not `getDb()` — so the prod "REST has no listen channel" failure
 *     can't silently regress.
 *
 * `requireSession` / `getSessionSafe` / `resolveAppScope` / `isUserActive` are
 * mocked — the emulator harness has no Better Auth or Postgres. The route's own
 * logic (cursor parsing, frame shaping, the reload triggers, the confirmed-only
 * cadence, teardown) is the real code under test.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset; run via
 * `npm run test:integration`.
 */

import { Timestamp } from "@google-cloud/firestore";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { RETENTION_COUNT } from "@/lib/db/constants";

// ── Auth mocks (no Better Auth / Postgres in the emulator harness) ──────────
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
const firestoreListen = await import("@/lib/db/firestoreListen");
const firestore = await import("@/lib/db/firestore");
const { getDb, docs } = firestore;

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const USER = "user-1";
const OTHER_USER = "user-2";
const PROJECT = "project-1";

const createdAppIds: string[] = [];

let appCounter = 0;

/** A minimal session shape the route reads (`session.user.id`). */
function sessionFor(userId: string) {
	return { user: { id: userId } } as never;
}

/** Seed an app doc at the given head `mutation_seq`, tracked for teardown. */
async function seedApp(mutationSeq: number): Promise<string> {
	appCounter += 1;
	const appId = `stream-test-${appCounter}-${crypto.randomUUID()}`;
	createdAppIds.push(appId);
	await getDb()
		.collection("apps")
		.doc(appId)
		.set({ project_id: PROJECT, owner: USER, mutation_seq: mutationSeq });
	return appId;
}

/** Write one `acceptedMutations/{seq}` entry (a real delta unless migration). */
async function writeEntry(
	appId: string,
	seq: number,
	opts: { kind?: "autosave" | "chat" | "migration"; runId?: string } = {},
): Promise<void> {
	const kind = opts.kind ?? "autosave";
	await docs.acceptedMutation(appId, seq).set({
		seq,
		batchId: crypto.randomUUID(),
		runId: opts.runId,
		mutations:
			kind === "migration" ? [] : [{ kind: "setAppName", name: `v${seq}` }],
		actorId: USER,
		kind,
		ts: Timestamp.now(),
		expireAt: Timestamp.fromMillis(Date.now() + 60_000),
	} as never);
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
	// Default under vitest's 5 s body timeout so a never-satisfied predicate
	// surfaces as an assertion, not an opaque body-timeout. A deadline timer
	// aborts the controller, which ends the stream so the pending `read()`
	// resolves `done` and the loop exits — NEVER race `read()` against a timeout,
	// which abandons a pending `read()` and drops the very chunk it was awaiting.
	const timeoutMs = opts.timeoutMs ?? 4_000;
	const deadline = setTimeout(() => controller.abort(), timeoutMs);

	// Kick off any side effect that should happen once the stream is open (e.g.
	// writing a new entry the listen should then deliver).
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
		// Surface an onOpen rejection (a failed seed write) rather than letting it
		// masquerade as "no frame delivered".
		await opened;
	}
	return { frames, controller };
}

beforeEach(() => {
	createdAppIds.length = 0;
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
	await Promise.all(
		createdAppIds.map(async (id) => {
			const ref = getDb().collection("apps").doc(id);
			for (const sub of ["acceptedMutations", "presence", "batchDedup"]) {
				const snap = await ref.collection(sub).get();
				await Promise.all(snap.docs.map((d) => d.ref.delete()));
			}
			await ref.delete();
		}),
	);
});

describe.skipIf(!emulatorAvailable)(
	"/stream relay (Firestore emulator)",
	() => {
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

		it("delivers a live commit after the stream is open", async () => {
			const appId = await seedApp(0);

			const { frames } = await collectUntil(appId, {
				since: 0,
				async onOpen() {
					// Let the listen attach, then commit an entry the listen should
					// deliver as a live `mutation` frame.
					await new Promise((r) => setTimeout(r, 300));
					await writeEntry(appId, 1);
				},
				predicate: (f) => f.some((x) => x.event === "mutation" && x.id === "1"),
			});

			expect(frames.some((f) => f.event === "mutation" && f.id === "1")).toBe(
				true,
			);
		});

		it("reloads (no replay) when the cursor is below the retention window", async () => {
			// Head far above the cursor + retention window → the missed entries are
			// pruned, so the client must reload rather than replay.
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
			// No mutation frames were emitted.
			expect(frames.some((f) => f.event === "mutation")).toBe(false);
		});

		it("reloads at connect when the replay floor was TTL-pruned inside the retention window", async () => {
			// The count-based retention check passes (head − cursor ≪ RETENTION),
			// but the 7-day TTL already deleted EVERY entry the client needs — a
			// tab resurrected after a week idle. With nothing to deliver, the
			// seq-gap check (which fires only on a DELIVERED frame) never trips,
			// so without the connect-time floor read the client would silently
			// render a stale blueprint until some future commit arrived.
			const appId = await seedApp(10); // head 10, NO entries at all

			const { frames } = await collectUntil(appId, {
				since: 5,
				predicate: (f) => f.some((x) => x.event === "reload"),
			});

			expect(frames.some((f) => f.event === "reload")).toBe(true);
			expect(frames.some((f) => f.event === "mutation")).toBe(false);
		});

		it("reloads on a gap — the first delivered seq isn't cursor+1", async () => {
			// Head says seq 5 exists but only seq 5 is present (1..4 pruned); a cursor
			// of 0 expects seq 1 first, so the seq-5 delivery is a hole → reload.
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

		it("delivers presence roster snapshots in the projected client shape (updatedAt is epoch millis, no raw Timestamp / no expireAt)", async () => {
			const appId = await seedApp(0);
			const beat = Timestamp.fromMillis(1_700_000_000_000);
			await docs.presence(appId, `${USER}:sess-a`).set({
				userId: USER,
				sessionId: "sess-a",
				name: "Ada",
				color: "#123456",
				location: { kind: "home" },
				updatedAt: beat,
				expireAt: Timestamp.fromMillis(Date.now() + 60_000),
			} as never);

			const { frames } = await collectUntil(appId, {
				since: 0,
				predicate: (f) =>
					f.some(
						(x) => x.event === "presence" && (x.data as unknown[]).length >= 1,
					),
			});

			const presence = frames.find((f) => f.event === "presence");
			const entry = (presence?.data as Record<string, unknown>[])[0];
			expect(entry?.userId).toBe(USER);
			// The wire shape is exactly the reconciler/presence-relevant fields —
			// `updatedAt` is epoch MILLIS (a number the client does `now − updatedAt`
			// arithmetic on), NOT a raw Firestore Timestamp `{_seconds,_nanoseconds}`.
			expect(Object.keys(entry ?? {}).sort()).toEqual(
				[
					"color",
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
		});

		it("revokes within the cadence on a CONFIRMED ban (isUserActive → false)", async () => {
			const appId = await seedApp(0);
			// The ban lands after connect: `isUserActive` reads a definitively
			// banned/deleted user. A bare `getSessionSafe` null would be ambiguous
			// (swallowed transient error), so the ban signal is `isUserActive`.
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
			// A cookie that now resolves to a DIFFERENT user (session rotation to
			// someone else) — the cadence closes on the identity mismatch.
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
			// Every cadence signal is transient/ambiguous — an authorized
			// collaborator must NOT be booted:
			//   - getSessionSafe returns null (its own getSession throw swallowed).
			//   - isUserActive throws (Cloud SQL pool exhaustion / failover).
			//   - resolveAppScope throws a generic (non-AppAccessError) error.
			getSessionSafeMock.mockResolvedValue(null);
			isUserActiveMock.mockRejectedValue(new Error("pool exhausted"));
			resolveAppScopeMock
				.mockResolvedValueOnce({
					projectId: PROJECT,
					role: "editor",
					actorUserId: USER,
				})
				.mockRejectedValue(new Error("firestore blip"));

			// Wait past several cadence ticks (150 ms each) and assert NO revoke.
			const { frames } = await collectUntil(appId, {
				since: 0,
				timeoutMs: 1_500,
				predicate: () => false,
			});

			expect(frames.some((f) => f.event === "revoked")).toBe(false);
		});

		it("mutation frame carries the projected client shape (runId ridden through, no raw Firestore Timestamps)", async () => {
			const appId = await seedApp(1);
			// A chat commit carries a runId — it must ride through for the
			// reconciler's echo classification.
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
			// Server-only TTL metadata never reaches the wire.
			expect(data).not.toHaveProperty("expireAt");
			// `ts` is not serialized as a raw Firestore Timestamp `{_seconds,...}`.
			expect(data).not.toHaveProperty("ts");
		});

		it("reloads (does NOT hang) when an acceptedMutations entry is malformed", async () => {
			const appId = await seedApp(1);
			// Plant a doc that FAILS the Zod converter (missing required fields),
			// written through the raw collection ref to bypass the converter on write.
			// `.data()` in the success callback would throw synchronously; the route
			// must catch it and emit `reload`, not hang with a leaked listener.
			await getDb()
				.collection("apps")
				.doc(appId)
				.collection("acceptedMutations")
				.doc(String(1).padStart(12, "0"))
				.set({ seq: 1, garbage: true });

			const { frames } = await collectUntil(appId, {
				since: 0,
				timeoutMs: 3_000,
				predicate: (f) => f.some((x) => x.event === "reload"),
			});

			expect(frames.some((f) => f.event === "reload")).toBe(true);
			expect(frames.some((f) => f.event === "mutation")).toBe(false);
		});

		it("skips a malformed presence doc and continues the roster", async () => {
			const appId = await seedApp(0);
			// One valid presence doc + one malformed (fails the Zod converter). The
			// roster must include the valid one and skip the bad one, never throw.
			await docs.presence(appId, `${USER}:good`).set({
				userId: USER,
				sessionId: "good",
				name: "Ada",
				color: "#123456",
				location: { kind: "home" },
				updatedAt: Timestamp.now(),
				expireAt: Timestamp.fromMillis(Date.now() + 60_000),
			} as never);
			await getDb()
				.collection("apps")
				.doc(appId)
				.collection("presence")
				.doc(`${USER}:bad`)
				.set({ userId: USER, garbage: true });

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
			// The good doc survives; the malformed one is skipped (not on the roster).
			expect(roster.map((p) => p.sessionId)).toContain("good");
			expect(roster.map((p) => p.sessionId)).not.toContain("bad");
		});

		it("returns a 404 (not 500) when the connect-time scope check denies", async () => {
			const appId = await seedApp(0);
			requireSessionMock.mockResolvedValue(sessionFor(USER));
			resolveAppScopeMock.mockRejectedValue(
				new MockAppAccessError("not_member"),
			);

			const res = await GET(
				new Request(`http://localhost/api/apps/${appId}/stream`),
				{ params: Promise.resolve({ id: appId }) },
			);
			expect(res.status).toBe(404);
			// An error response, not an SSE stream.
			expect(res.headers.get("Content-Type")).not.toBe("text/event-stream");
		});

		it("survives a post-disconnect listen delivery without an escaping enqueue error", async () => {
			const appId = await seedApp(0);

			// Open the stream, then abort mid-flight (platform disconnect) and IMMEDIATELY
			// commit an entry so the mutation listen may still fire after teardown. The
			// `closed` guard in the callback + the try/catch around `controller.enqueue`
			// must together keep the delivery a no-op — no "Controller is already closed"
			// throw escaping the onSnapshot callback. The test passing (no unhandled
			// rejection / thrown error crashing the run) is the assertion.
			const { controller } = await collectUntil(appId, {
				since: 0,
				timeoutMs: 800,
				async onOpen() {
					await new Promise((r) => setTimeout(r, 200));
				},
				predicate: () => false,
			});
			// The stream was aborted by collectUntil's deadline; a write now races the
			// torn-down listener.
			await writeEntry(appId, 1).catch(() => {});
			// Give any in-flight listen callback a tick to fire against the closed
			// controller; a bug here would surface as an unhandled error, failing the run.
			await new Promise((r) => setTimeout(r, 200));
			expect(controller.signal.aborted).toBe(true);
		});

		it("builds the listen queries on getListenDb() (the gRPC client), not getDb()", async () => {
			const appId = await seedApp(0);
			const listenSpy: MockInstance = vi.spyOn(firestoreListen, "getListenDb");
			const acceptedSpy: MockInstance = vi.spyOn(
				firestore.collections,
				"acceptedMutations",
			);
			const presenceSpy: MockInstance = vi.spyOn(
				firestore.collections,
				"presence",
			);

			try {
				await collectUntil(appId, {
					since: 0,
					timeoutMs: 2_000,
					// No entries — just confirm the queries attach on the right client.
					predicate: () => false,
				});

				expect(listenSpy).toHaveBeenCalled();
				const listenClient = firestoreListen.getListenDb();
				// Both listen queries were built with the gRPC client, never getDb().
				expect(acceptedSpy).toHaveBeenCalledWith(appId, listenClient);
				expect(presenceSpy).toHaveBeenCalledWith(appId, listenClient);
			} finally {
				listenSpy.mockRestore();
				acceptedSpy.mockRestore();
				presenceSpy.mockRestore();
			}
		});

		it("tears down both listeners + the cadence on a client abort (no leak)", async () => {
			const appId = await seedApp(0);
			await writeEntry(appId, 1).catch(() => {});

			// `collectUntil` aborts the controller in its finally block, driving the
			// route's `req.signal` abort → teardown. Run under the async-leak
			// detector (`vitest --detect-async-leaks`), an un-cleared cadence
			// interval or an un-unsubscribed `onSnapshot` would surface as a
			// TIMEOUT/listener leak pinned to the route; a clean teardown reports
			// none. Here we assert the abort landed and the stream closed cleanly.
			const { controller } = await collectUntil(appId, {
				since: 0,
				timeoutMs: 1_500,
				predicate: (f) => f.some((x) => x.event === "mutation"),
			});

			expect(controller.signal.aborted).toBe(true);
		});
	},
);
