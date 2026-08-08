/**
 * The relay `/stream` route against a real Postgres testcontainer, the SSE
 * channel every builder session opens, now driven by LISTEN/NOTIFY.
 *
 * What this pins against a REAL Postgres LISTEN/NOTIFY (a mocked listen can't):
 *
 *   - Replay from a cursor: a committed `app_changes` row past the cursor
 *     is delivered as an `event: mutation` frame carrying `id:<seq>`.
 *   - LIVE delivery: a `commitGuardedBatch` after the stream is open pokes
 *     `nova_app_stream`, the dedicated LISTEN connection dispatches it, and the
 *     route's pump SELECTs + emits the new batch: end-to-end NOTIFY delivery.
 *   - Lookup delivery: the initial and poke-driven frames are complete Project
 *     manifests with exact decimal revisions and NO SSE `id:` line, so they
 *     cannot advance the mutation reconnect cursor.
 *   - Reload below retention: a cursor under `head − RETENTION_COUNT` emits
 *     `event: reload` and closes without replaying.
 *   - Reconnect via `Last-Event-ID`: the header sets the cursor, so a reconnect
 *     resumes past the frames it already saw.
 *   - Blueprint migrations, fold baselines, and Project moves freshly
 *     reauthorize before advancing the live cursor, then emit `event: reload`,
 *     never a browser `mutation` frame. The complete suffix is admitted before
 *     that decision, and only the baseline and Project-move kinds may be empty.
 *     Destination editor/viewer and same-Project access
 *     reload; source-only loss revokes; a transient denial retries from M-1.
 *   - A gap (first delivered seq isn't cursor+1) emits `event: reload`.
 *   - Bounded revocation, CONFIRMED-only: a ban (`isUserActive → false`), a
 *     membership loss (`AppAccessError`), and a session-identity change each
 *     close the stream with `event: revoked`; a TRANSIENT blip (a null session,
 *     an `isUserActive` throw, a non-`AppAccessError` scope throw) does NOT.
 *   - The mutation frame carries the projected reconciler shape, `runId` ridden
 *     through, no server-only `ts` on the wire.
 *   - Presence roster snapshots in the projected client shape (`updatedAt` is
 *     epoch millis, no `expire_at`); one malformed row rejects the entire
 *     current page, so no partial roster is emitted.
 *   - Connect admission is authorization-only: a denied user gets the IDOR-safe
 *     404, with no stream body.
 *   - Teardown: abort and cancel each disown the subscriptions, pumps, and
 *     intervals.
 *
 * Session/account resolution and the membership-row read are mocked; the route
 * still runs its real authorization transaction against the per-test Postgres.
 * The route's cursor/frame logic, reload and revocation state machine,
 * teardown, plus the real LISTEN/NOTIFY path are the code under test.
 *
 * Runs on the per-test-database harness booted by the case-store testcontainer
 * `globalSetup`: the app-state migrations create the `apps` / `app_changes`
 * / `presence` tables; the data layer is pointed at the per-test database via
 * `__setAppDbForTests`, and the dedicated LISTEN client at the same database via
 * `__setListenerConfigForTests`.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { createReconciler, type MutationFrame } from "@/lib/collab/reconciler";
import {
	createPerTestAppDb,
	type PerTestAppDb,
} from "@/lib/db/__tests__/perTestAppDb";
import { RETENTION_COUNT } from "@/lib/db/constants";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import {
	type LookupOptionsSource,
	lookupOptionsSourceSchema,
	type PersistableDoc,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

// ── Auth mocks (no Better Auth / membership tables for the relay) ──────────
const {
	requireSessionMock,
	getSessionSafeMock,
	resolveAppScopeMock,
	resolveAppScopeInTransactionMock,
	isUserActiveMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	getSessionSafeMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	resolveAppScopeInTransactionMock: vi.fn(),
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
/* `reauthorizeStreamScope` keeps its real shape: `withAppTx` around
 * `resolveAppScopeInTransaction`, so a test programs ONE mock and it drives the
 * connect gate, the app-change reauthorization, and the cadence re-check alike,
 * each on a genuine transaction against the per-test database. */
vi.mock("@/lib/db/appAccess", async () => {
	const { withAppTx } = await import("@/lib/db/pg");
	return {
		resolveAppScope: resolveAppScopeMock,
		resolveAppScopeInTransaction: resolveAppScopeInTransactionMock,
		reauthorizeStreamScope: (appId: string, userId: string) =>
			withAppTx((tx) =>
				resolveAppScopeInTransactionMock(tx, appId, userId, "view"),
			),
		AppAccessError: MockAppAccessError,
	};
});
vi.mock("@/lib/db/api-keys", () => ({
	isUserActive: isUserActiveMock,
}));
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: vi.fn(async () => "editor"),
	projectRoleForInTransaction: vi.fn(async () => "editor"),
}));

/* The route reads its revocation cadence from `NOVA_STREAM_CADENCE_MS` at
 * MODULE LOAD, so set it before the dynamic import below: a short cadence lets
 * the revocation tests observe a `revoked` frame in well under a second instead
 * of waiting the prod ~10 s. Prod never sets this var. */
const originalStreamEnv = {
	cadence: process.env.NOVA_STREAM_CADENCE_MS,
};
process.env.NOVA_STREAM_CADENCE_MS = "150";

const { GET } = await import("../route");
const { POST: presencePost } = await import("../../presence/route");
const { __setStreamReadTestHooksForTests } = await import(
	"@/lib/db/streamReadTestHooks"
);
const {
	__forceListenerDisconnectForTests,
	__setListenerConfigForTests,
	__setNextListenerCloseBarrierForTests,
	closeStreamListener,
	subscribeLookupProject,
} = await import("@/lib/db/streamListener");
const { commitGuardedBatch, completeAndSettleRun } = await import(
	"@/lib/db/apps"
);
const { createExplicitBlankApp } = await import("@/lib/db/appGenesis");
const { createLookupTable } = await import("@/lib/lookup/service");

const USER = "user-1";
const OTHER_USER = "user-2";
const PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const GENESIS_SEQ = 1;
const LOOKUP_MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const LOOKUP_FORM = testUuid("20000000-0000-4000-8000-000000000000");
const LOOKUP_FIELD = testUuid("30000000-0000-4000-8000-000000000000");
const LOOKUP_OPTION_A = testUuid("40000000-0000-4000-8000-000000000000");
const LOOKUP_OPTION_B = testUuid("50000000-0000-4000-8000-000000000000");
const LOOKUP_SOURCE_A = lookupOptionsSourceSchema.parse({
	kind: "lookup",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
});
const LOOKUP_SOURCE_B = lookupOptionsSourceSchema.parse({
	kind: "lookup",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ac",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890af",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890b0",
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "stream_relay_" });

let appDb: Kysely<AppDatabase>;
let harness: PerTestAppDb;

/** A minimal session shape the route reads (`session.user.id`). */
function sessionFor(userId: string) {
	return { user: { id: userId } } as never;
}

/**
 * Seed a canonically-created app, then reserve `head` ordinary rows after its
 * immutable genesis baseline. Test-local row numbers are suffix offsets:
 * logical 1 is durable sequence 2.
 */
async function seedApp(head: number): Promise<string> {
	const { appId } = await createExplicitBlankApp(USER, PROJECT, "run-seed", {
		status: "complete",
	});
	await appDb.transaction().execute(async (tx) => {
		await tx
			.updateTable("apps")
			.set({ mutation_seq: GENESIS_SEQ + head })
			.where("id", "=", appId)
			.execute();
	});
	return appId;
}

async function withAppChangeAdmissionDisabled(
	body: () => Promise<void>,
): Promise<void> {
	await sql`
		ALTER TABLE app_changes
		DISABLE TRIGGER app_changes_admit_insert
	`.execute(appDb);
	try {
		await body();
	} finally {
		await sql`
			ALTER TABLE app_changes
			ENABLE TRIGGER app_changes_admit_insert
		`.execute(appDb);
	}
}

/** Insert one `app_changes` row directly. */
async function writeEntry(
	appId: string,
	seq: number,
	opts: {
		kind?: "autosave" | "chat" | "blueprint-migration";
		runId?: string;
		mutations?: readonly Mutation[];
	} = {},
): Promise<void> {
	const kind = opts.kind ?? "autosave";
	const durableSeq = GENESIS_SEQ + seq;
	const insert = async () => {
		await appDb
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq: durableSeq,
				batch_id: crypto.randomUUID(),
				run_id: opts.runId ?? null,
				actor_id: USER,
				kind,
				mutations: JSON.stringify(
					opts.mutations ?? [{ kind: "setAppName", name: `v${seq}` }],
				),
				from_project_id: null,
				to_project_id: null,
			})
			.execute();
	};
	if (opts.mutations?.length === 0) {
		await withAppChangeAdmissionDisabled(insert);
	} else {
		await insert();
	}
}

/** Insert an intentionally untrusted mutation payload, bypassing the typed
 * writer so the stream's persisted-history parser is exercised directly. */
async function writeRawEntry(
	appId: string,
	seq: number,
	mutations: unknown,
): Promise<void> {
	const durableSeq = GENESIS_SEQ + seq;
	await withAppChangeAdmissionDisabled(async () => {
		await appDb
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq: durableSeq,
				batch_id: crypto.randomUUID(),
				run_id: null,
				actor_id: USER,
				kind: "autosave",
				mutations: JSON.stringify(mutations),
				from_project_id: null,
				to_project_id: null,
			})
			.execute();
	});
}

/** Insert the one exact fold-horizon shape admitted by the immutable baseline
 * table. The test app has no post-genesis blueprint change, so its genesis
 * snapshot is also the exact snapshot at this new horizon. */
async function writeBaselineMarker(appId: string, seq: number): Promise<void> {
	const durableSeq = GENESIS_SEQ + seq;
	await appDb.transaction().execute(async (tx) => {
		await tx
			.updateTable("apps")
			.set({ mutation_seq: durableSeq })
			.where("id", "=", appId)
			.execute();
		await sql`
			UPDATE blueprint_entities
			SET data = data
			WHERE app_id = ${appId}
		`.execute(tx);
		const genesis = await tx
			.selectFrom("app_change_fold_baselines")
			.select(["snapshot", "project_id"])
			.where("app_id", "=", appId)
			.where("seq", "=", GENESIS_SEQ)
			.executeTakeFirstOrThrow();
		await tx
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq: durableSeq,
				batch_id: "fold-baseline:canonical-identity-foundation",
				run_id: null,
				actor_id: "system:canonical-identity-foundation",
				kind: "fold-baseline",
				mutations: JSON.stringify([]),
				from_project_id: null,
				to_project_id: null,
			})
			.execute();
		await tx
			.insertInto("app_change_fold_baselines")
			.values({
				app_id: appId,
				seq: durableSeq,
				project_id: genesis.project_id,
				snapshot: JSON.stringify(genesis.snapshot),
				snapshot_digest: sql<string>`
					nova_app_change_fold_snapshot_digest(
						${JSON.stringify(genesis.snapshot)}::jsonb
					)
				`,
			})
			.execute();
	});
}

async function writeEmptyProjectMove(
	appId: string,
	fromProjectId: string,
	toProjectId: string,
): Promise<void> {
	await appDb.transaction().execute(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select(["project_id", "mutation_seq"])
			.where("id", "=", appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		expect(app.project_id).toBe(fromProjectId);
		const seq = Number(app.mutation_seq) + 1;
		await tx
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq,
				batch_id: `project-move:${appId}`,
				run_id: null,
				actor_id: USER,
				kind: "project-move",
				mutations: "[]",
				from_project_id: fromProjectId,
				to_project_id: toProjectId,
			})
			.execute();
		await tx
			.updateTable("apps")
			.set({ project_id: toProjectId, mutation_seq: seq })
			.where("id", "=", appId)
			.execute();
	});
}

function lookupSourceMutation(optionsSource: LookupOptionsSource): Mutation {
	return {
		kind: "updateField",
		uuid: LOOKUP_FIELD,
		targetKind: "single_select",
		patch: { optionsSource },
	};
}

function lookupReceiverDoc(appId: string): PersistableDoc {
	return {
		appId,
		appName: "Lookup receiver",
		connectType: null,
		caseTypes: null,
		modules: {
			[LOOKUP_MODULE]: {
				uuid: LOOKUP_MODULE,
				id: "lookups",
				name: "Lookups",
			},
		},
		forms: {
			[LOOKUP_FORM]: {
				uuid: LOOKUP_FORM,
				id: "intake",
				name: "Intake",
				type: "survey",
			},
		},
		fields: {
			[LOOKUP_FIELD]: {
				uuid: LOOKUP_FIELD,
				id: "status",
				kind: "single_select",
				label: proseText("Status"),
				optionsSource: {
					kind: "inline",
					options: [
						{
							uuid: LOOKUP_OPTION_A,
							value: "active",
							label: proseText("Active"),
						},
						{
							uuid: LOOKUP_OPTION_B,
							value: "closed",
							label: proseText("Closed"),
						},
					],
				},
			},
		},
		moduleOrder: [LOOKUP_MODULE],
		formOrder: { [LOOKUP_MODULE]: [LOOKUP_FORM] },
		fieldOrder: { [LOOKUP_FORM]: [LOOKUP_FIELD] },
	};
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

/** Create one lookup table through the real transactional write + NOTIFY path. */
async function writeLookupTable(projectId: string, tag: string): Promise<void> {
	await createLookupTable(
		{ projectId, actorId: USER, role: "editor" },
		{
			name: `Table ${tag}`,
			tag,
			columns: [{ wireName: "code", label: "Code", dataType: "text" }],
		},
	);
}

/** Establish the shared listener before opening the route under test. This
 * removes the listener's legitimate initial-connect catch-up poke, so a reader
 * that recovers below proves its OWN timer retried without any new notification. */
async function warmStreamListener(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("stream listener did not connect")),
			2_000,
		);
		let unsubscribe = () => {};
		unsubscribe = subscribeLookupProject(PROJECT, () => {
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
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
	if (opts.lastEventId) {
		headers.set(
			"Last-Event-ID",
			String(GENESIS_SEQ + Number(opts.lastEventId)),
		);
	}
	const url = new URL(`http://localhost/api/apps/${appId}/stream`);
	url.searchParams.set("since", String(GENESIS_SEQ + (opts.since ?? 0)));
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
	// and the loop exits: NEVER race `read()` against a timeout.
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
	resolveAppScopeInTransactionMock.mockReset();
	isUserActiveMock.mockReset();
	// Default: the actor is a live, active, authorized member.
	getSessionSafeMock.mockResolvedValue(sessionFor(USER));
	isUserActiveMock.mockResolvedValue(true);
	resolveAppScopeMock.mockResolvedValue({
		projectId: PROJECT,
		role: "editor",
		actorUserId: USER,
	});
	resolveAppScopeInTransactionMock.mockImplementation(
		async (tx: Transaction<AppDatabase>, appId: string, userId: string) => {
			const app = await tx
				.selectFrom("apps")
				.select(["mutation_seq", "status"])
				.where("id", "=", appId)
				.executeTakeFirst();
			if (!app) throw new MockAppAccessError("not_found");
			return {
				projectId: PROJECT,
				role: "editor",
				canEdit: true,
				baseSeq: Number(app.mutation_seq),
				status: app.status,
				actorUserId: userId,
			};
		},
	);
});

afterEach(async () => {
	__setStreamReadTestHooksForTests(null);
	__setNextListenerCloseBarrierForTests(null);
	// Close the dedicated LISTEN client BEFORE the per-test DROP DATABASE, a
	// leaked LISTEN connection would be force-terminated by the drop and its
	// reconnect timer would spin against a vanished database. `harness.destroy()`
	// quiesces the pool before ending it: the ordinary straggling pump/roster
	// read would otherwise race `Pool.end()` and orphan a mid-connect client,
	// which `end()` then waits on forever: see `perTestAppDb.ts`.
	await closeStreamListener();
	__setListenerConfigForTests(null);
	__setAppDbForTests(null);
	await harness.destroy();
});

afterAll(() => {
	if (originalStreamEnv.cadence === undefined) {
		delete process.env.NOVA_STREAM_CADENCE_MS;
	} else {
		process.env.NOVA_STREAM_CADENCE_MS = originalStreamEnv.cadence;
	}
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
		expect(mutations.map((f) => f.id)).toEqual(["2", "3", "4"]);
		const first = mutations[0];
		if (!first) throw new Error("no mutation frames were replayed");
		expect((first.data as { seq: number }).seq).toBe(2);
	});

	it("replays canonical lookup-source replacements through Postgres and raw HTTP SSE", async () => {
		const appId = await seedApp(2);
		const setSource = lookupSourceMutation(LOOKUP_SOURCE_A);
		const replaceSource = lookupSourceMutation(LOOKUP_SOURCE_B);

		await writeEntry(appId, 1, { mutations: [setSource] });
		await writeEntry(appId, 2, { mutations: [replaceSource] });

		/* Hop 1: the canonical nested source has survived the writer-side
		 * JSON.stringify plus Postgres' jsonb decode. */
		const persistedRow = await appDb
			.selectFrom("app_changes")
			.select("mutations")
			.where("app_id", "=", appId)
			.where("seq", "=", 3)
			.executeTakeFirstOrThrow();
		const persisted = (
			persistedRow.mutations as unknown as Record<string, unknown>[]
		)[0];
		if (!persisted) throw new Error("persisted mutation is missing");
		expect(persisted).not.toHaveProperty("optionsSource");
		expect(persisted.patch).toEqual({ optionsSource: LOOKUP_SOURCE_B });

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) =>
				current.filter((frame) => frame.event === "mutation").length >= 2,
		});
		const mutationFrames = frames.filter((frame) => frame.event === "mutation");
		expect(mutationFrames.map((frame) => frame.id)).toEqual(["2", "3"]);

		const docStore = createBlueprintDocStore();
		docStore.getState().load(lookupReceiverDoc(appId));
		docStore.getState().startTracking();
		const reconciler = createReconciler(
			docStore,
			{
				appId,
				baseSeq: GENESIS_SEQ,
				baseDoc: docStore.getState(),
				/* A different user makes these historical frames remote, matching a
				 * normal reconnecting collaborator rather than a pending self-echo. */
				userId: "reconnecting-receiver",
			},
			{
				put: async () => ({ ok: true, seq: 4 }),
				canEdit: () => true,
				reload: async () => {
					throw new Error("contiguous replay must not reload");
				},
				resubscribe: () => {},
				scheduleRetry: () => () => {},
			},
		);

		try {
			for (const [index, expectedSource] of [
				LOOKUP_SOURCE_A,
				LOOKUP_SOURCE_B,
			].entries()) {
				const rawFrame = mutationFrames[index]?.data as
					| MutationFrame
					| undefined;
				if (!rawFrame) throw new Error(`missing mutation frame ${index + 1}`);
				const rawMutation = rawFrame.mutations[0] as
					| Record<string, unknown>
					| undefined;
				if (!rawMutation)
					throw new Error(`missing mutation payload ${index + 1}`);

				/* Hop 2: the route's JSON.stringify and the raw SSE parser's
				 * JSON.parse preserve the one canonical nested source. */
				expect(rawMutation).not.toHaveProperty("optionsSource");
				expect(rawMutation.patch).toEqual({ optionsSource: expectedSource });

				reconciler.onFrame(rawFrame);
				const field = docStore.getState().fields[LOOKUP_FIELD];
				if (field?.kind !== "single_select") {
					throw new Error("lookup receiver field is missing");
				}
				expect(field.optionsSource).toEqual(expectedSource);
			}

			expect(reconciler.getSnapshot().baseSeq).toBe(3);
		} finally {
			reconciler.dispose();
		}
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
					expectedProjectId: PROJECT,
					batchId: crypto.randomUUID(),
					mutations: admitMutationBatch([{ kind: "setAppName", name: "Live" }]),
					actorUserId: USER,
					kind: "autosave",
				});
			},
			predicate: (f) => f.some((x) => x.event === "mutation" && x.id === "2"),
		});

		const frame = frames.find((f) => f.event === "mutation" && f.id === "2");
		if (!frame) throw new Error("the live mutation frame never arrived");
		expect((frame.data as { mutations: unknown[] }).mutations).toEqual([
			{ kind: "setAppName", name: "Live" },
		]);
	});

	it("retries a failed accepted-mutation read without another poke", async () => {
		const appId = await seedApp(1);
		await writeEntry(appId, 1);
		await warmStreamListener();

		let attempts = 0;
		__setStreamReadTestHooksForTests({
			beforeMutationRead() {
				attempts += 1;
				if (attempts === 1) throw new Error("injected mutation read failure");
			},
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.some((x) => x.event === "mutation" && x.id === "2"),
		});

		expect(attempts).toBe(2);
		expect(frames.some((x) => x.event === "mutation" && x.id === "2")).toBe(
			true,
		);
	});

	it("retries a failed initial lookup-manifest read without another poke", async () => {
		const appId = await seedApp(0);
		await writeLookupTable(PROJECT, "retry_table");
		await warmStreamListener();

		let attempts = 0;
		__setStreamReadTestHooksForTests({
			beforeLookupManifestRead() {
				attempts += 1;
				if (attempts === 1) throw new Error("injected manifest read failure");
			},
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) =>
				f.some(
					(x) =>
						x.event === "lookup-revision" &&
						(x.data as { tables?: { tag?: string }[] }).tables?.some(
							(table) => table.tag === "retry_table",
						),
				),
		});

		expect(attempts).toBe(2);
		expect(
			frames.some(
				(frame) =>
					frame.event === "lookup-revision" &&
					(frame.data as { projectRevision?: string }).projectRevision === "1",
			),
		).toBe(true);
	});

	it("announces the run-lifecycle status on connect and re-announces when the cadence sees it change", async () => {
		const appId = await seedApp(0);
		await appDb
			.updateTable("apps")
			.set({ status: "generating" })
			.where("id", "=", appId)
			.execute();

		const { frames } = await collectUntil(appId, {
			predicate: (f) =>
				f.some(
					(x) =>
						x.event === "app-status" &&
						(x.data as { status?: string }).status === "complete",
				),
			onOpen: async () => {
				/* The connect-time scope already read `generating` (it resolved
				 * before this callback runs), so this flip is only observable via
				 * the reauthorization cadence — the exact channel that tells a
				 * co-member's tab the build finished. */
				await appDb
					.updateTable("apps")
					.set({ status: "complete" })
					.where("id", "=", appId)
					.execute();
			},
		});

		const statusFrames = frames.filter((x) => x.event === "app-status");
		expect(statusFrames[0]?.data).toEqual({ status: "generating" });
		expect(statusFrames.at(-1)?.data).toEqual({ status: "complete" });
		/* Seq-less: only mutation frames own Last-Event-ID. */
		for (const frame of statusFrames) expect(frame.id).toBeUndefined();
	});

	it("announces completion off the terminal transaction's own notify", async () => {
		/* The real build-completion writer: `completeAndSettleRun` commits
		 * `generating` → `complete` AND pokes the app channel's status lane in
		 * the same transaction, so a connected tab's release does not have to
		 * wait out the reauthorization cadence. This runs the whole path end
		 * to end: terminal transaction → NOTIFY → listener dispatch → status
		 * pump reauthorization → frame. */
		const appId = await seedApp(0);
		const runId = "run-status-notify";
		const nonce = testUuid("60000000-0000-4000-8000-000000000000");
		await appDb
			.updateTable("apps")
			.set({
				status: "generating",
				run_id: runId,
				run_holder_nonce: nonce,
				res_period: "2026-08",
				res_reserved: 100,
				res_settled: false,
				res_user_id: USER,
				res_run_id: runId,
			})
			.where("id", "=", appId)
			.execute();

		const { frames } = await collectUntil(appId, {
			predicate: (f) =>
				f.some(
					(x) =>
						x.event === "app-status" &&
						(x.data as { status?: string }).status === "complete",
				),
			onOpen: async () => {
				const outcome = await completeAndSettleRun(appId, runId, nonce);
				expect(outcome).toBe("owned");
			},
		});

		const statusFrames = frames.filter((x) => x.event === "app-status");
		expect(statusFrames[0]?.data).toEqual({ status: "generating" });
		expect(statusFrames.at(-1)?.data).toEqual({ status: "complete" });
	});

	it("announces the preview project space on connect and again off a deployment write's own notify", async () => {
		/* The deployment lane end to end: the store's fold commits a record
		 * write AND pokes the app channel's deployment lane in the same
		 * transaction, the listener dispatches the marker, and the pump
		 * re-resolves what Preview may name and announces it. This is how a
		 * co-member's publish reaches every open tab's `commcare_project`
		 * without a page load. */
		const { foldDeploymentAttempt, recordRemoteResource } = await import(
			"@/lib/deployment/store"
		);
		const appId = await seedApp(0);
		const scope = {
			appId,
			projectId: PROJECT,
			role: "editor",
			actorUserId: USER,
		};
		const target = { server: "production" as const, domain: "acme" };
		const at = "2026-08-06T00:00:00.000Z";

		const { frames } = await collectUntil(appId, {
			predicate: (f) =>
				f.some(
					(x) =>
						x.event === "preview-project-space" &&
						(x.data as { projectSpace?: string | null }).projectSpace ===
							"acme",
				),
			onOpen: async (currentFrames) => {
				/* The connect-time announce rides the deployment pump's async
				 * resolve, so a write committed before that read would make the
				 * FIRST announce already "acme" — masking the null-is-a-real-answer
				 * property below. Sequence the write after the observed announce. */
				await vi.waitFor(
					() =>
						expect(
							currentFrames().some((x) => x.event === "preview-project-space"),
						).toBe(true),
					{ timeout: 2_000 },
				);
				await foldDeploymentAttempt(
					scope,
					target,
					"preflight",
					{ status: "succeeded", at },
					{ ensure: true },
				);
				await recordRemoteResource(scope, target, {
					kind: "app",
					novaResourceId: appId,
					remoteId: "hq-1",
					ownership: "nova-created",
					pushedRevision: 1,
					uploadedAt: at,
				});
			},
		});

		const spaceFrames = frames.filter(
			(x) => x.event === "preview-project-space",
		);
		/* Connect-time: nothing published yet, and `null` is a real answer
		 * (Preview names nothing), not an omitted frame. */
		expect(spaceFrames[0]?.data).toEqual({ projectSpace: null });
		expect(spaceFrames.at(-1)?.data).toEqual({ projectSpace: "acme" });
		/* Seq-less: only mutation frames own Last-Event-ID. */
		for (const frame of spaceFrames) expect(frame.id).toBeUndefined();
	});

	it("emits an initial full lookup manifest without an SSE mutation id", async () => {
		const appId = await seedApp(0);

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.some((x) => x.event === "lookup-revision"),
		});

		const frame = frames.find((x) => x.event === "lookup-revision");
		expect(frame?.id).toBeUndefined();
		expect(frame?.data).toEqual({
			projectId: PROJECT,
			projectRevision: "0",
			tables: [],
		});
	});

	it("delivers a live lookup commit as an authoritative Project manifest", async () => {
		const appId = await seedApp(0);

		const { frames } = await collectUntil(appId, {
			since: 0,
			async onOpen() {
				await delay(300);
				await writeLookupTable(PROJECT, "live_table");
			},
			predicate: (f) =>
				f.some(
					(x) =>
						x.event === "lookup-revision" &&
						(x.data as { tables?: { tag?: string }[] }).tables?.some(
							(table) => table.tag === "live_table",
						),
				),
		});

		const frame = frames
			.filter((x) => x.event === "lookup-revision")
			.find((x) =>
				(x.data as { tables?: { tag?: string }[] }).tables?.some(
					(table) => table.tag === "live_table",
				),
			);
		if (!frame) throw new Error("live lookup manifest never arrived");
		expect(frame.id).toBeUndefined();
		expect((frame.data as { projectRevision?: string }).projectRevision).toBe(
			"1",
		);
	});

	it("reconnect catch-up reads durable lookup state committed while the listener is closing", async () => {
		const appId = await seedApp(0);
		await warmStreamListener();

		const { frames } = await collectUntil(appId, {
			since: 0,
			async onOpen(currentFrames) {
				await vi.waitFor(
					() =>
						expect(
							currentFrames().some(
								(frame) => frame.event === "lookup-revision",
							),
						).toBe(true),
					{ timeout: 2_000 },
				);

				const closeBarrier = deferredVoid();
				__setNextListenerCloseBarrierForTests(closeBarrier.promise);
				try {
					/* Detach the old client's notification handler synchronously, then
					 * commit while replacement is blocked behind its serialized close. */
					__forceListenerDisconnectForTests();
					await writeLookupTable(PROJECT, "gap_table");
					expect(
						currentFrames().some(
							(frame) =>
								frame.event === "lookup-revision" &&
								(frame.data as { tables?: { tag?: string }[] }).tables?.some(
									(table) => table.tag === "gap_table",
								),
						),
					).toBe(false);
				} finally {
					closeBarrier.resolve();
				}
			},
			predicate: (f) =>
				f.some(
					(frame) =>
						frame.event === "lookup-revision" &&
						(frame.data as { tables?: { tag?: string }[] }).tables?.some(
							(table) => table.tag === "gap_table",
						),
				),
		});

		const converged = frames
			.filter((frame) => frame.event === "lookup-revision")
			.at(-1);
		if (!converged) throw new Error("reconnect manifest never arrived");
		expect(
			(converged.data as { projectRevision?: string }).projectRevision,
		).toBe("1");
	});

	it("coalesced lookup pokes converge on the complete latest manifest", async () => {
		const appId = await seedApp(0);

		const { frames } = await collectUntil(appId, {
			since: 0,
			async onOpen() {
				await delay(300);
				await Promise.all([
					writeLookupTable(PROJECT, "alpha_table"),
					writeLookupTable(PROJECT, "beta_table"),
				]);
			},
			predicate: (f) =>
				f.some((x) => {
					if (x.event !== "lookup-revision") return false;
					const tags = (x.data as { tables?: { tag: string }[] }).tables?.map(
						(table) => table.tag,
					);
					return tags?.includes("alpha_table") && tags.includes("beta_table");
				}),
		});

		const latest = frames.filter((x) => x.event === "lookup-revision").at(-1);
		if (!latest) throw new Error("coalesced lookup manifest never arrived");
		expect(
			(latest.data as { tables?: { tag: string }[] }).tables?.map(
				(table) => table.tag,
			),
		).toEqual(["alpha_table", "beta_table"]);
		expect((latest.data as { projectRevision?: string }).projectRevision).toBe(
			"2",
		);
	});

	it("does not relay lookup changes from another Project", async () => {
		const appId = await seedApp(0);

		const { frames } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 1_200,
			async onOpen() {
				await delay(300);
				await writeLookupTable(OTHER_PROJECT, "foreign_table");
			},
			predicate: () => false,
		});

		const manifests = frames.filter((x) => x.event === "lookup-revision");
		expect(manifests.length).toBeGreaterThan(0);
		expect(
			manifests.every(
				(frame) =>
					(frame.data as { projectId?: string }).projectId === PROJECT &&
					!(frame.data as { tables?: { tag: string }[] }).tables?.some(
						(table) => table.tag === "foreign_table",
					),
			),
		).toBe(true);
	});

	it("delivers a live presence roster frame after a POST to the presence route (real NOTIFY)", async () => {
		const appId = await seedApp(0);
		const sessionId = crypto.randomUUID();

		const { frames } = await collectUntil(appId, {
			since: 0,
			async onOpen() {
				// Let the LISTEN attach, then POST presence through the real route:
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
			since: 0,
			predicate: (f) => f.some((x) => x.event === "reload"),
		});

		const reload = frames.find((f) => f.event === "reload");
		expect(reload).toBeDefined();
		// A `reload` is seq-less: no `id:` line.
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

	it("emits no partial mutation suffix and one seq-less protocol failure when durable history is malformed", async () => {
		const appId = await seedApp(2);
		await writeEntry(appId, 1);
		await writeRawEntry(appId, 2, [
			{ kind: "setAppName", name: "invalid", unexpected: true },
		]);

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) =>
				current.some((frame) => frame.event === "protocol-failure"),
		});

		const failures = frames.filter(
			(frame) => frame.event === "protocol-failure",
		);
		expect(failures).toEqual([
			{
				event: "protocol-failure",
				data: { reason: "malformed-app-change-suffix" },
			},
		]);
		expect(failures[0]?.id).toBeUndefined();
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
	});

	it("reauthorizes and reloads for a same-Project blueprint migration", async () => {
		const appId = await seedApp(1);
		await writeEntry(appId, 1, { kind: "blueprint-migration" });
		let reauthorizations = 0;
		__setStreamReadTestHooksForTests({
			beforeAppChangeReauthorization() {
				reauthorizations += 1;
			},
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.some((x) => x.event === "reload"),
		});

		expect(reauthorizations).toBe(1);
		expect(frames.some((f) => f.event === "reload")).toBe(true);
		expect(frames.some((f) => f.event === "mutation")).toBe(false);
	});

	it("reauthorizes and reloads for an exact fold baseline", async () => {
		const appId = await seedApp(1);
		await writeBaselineMarker(appId, 1);
		let reauthorizations = 0;
		__setStreamReadTestHooksForTests({
			beforeAppChangeReauthorization() {
				reauthorizations += 1;
			},
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) => current.some((frame) => frame.event === "reload"),
		});

		expect(reauthorizations).toBe(1);
		expect(frames.find((frame) => frame.event === "reload")?.data).toEqual({
			reason: "app-changed",
		});
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
	});

	it("reauthorizes and reloads for an empty Project move without a browser mutation frame", async () => {
		const appId = await seedApp(0);
		await writeEmptyProjectMove(appId, PROJECT, OTHER_PROJECT);
		let reauthorizations = 0;
		__setStreamReadTestHooksForTests({
			beforeAppChangeReauthorization() {
				reauthorizations += 1;
			},
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) => current.some((frame) => frame.event === "reload"),
		});

		expect(reauthorizations).toBe(1);
		expect(frames.find((frame) => frame.event === "reload")?.data).toEqual({
			reason: "app-changed",
		});
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
	});

	it("validates pre-baseline rows as part of the complete durable suffix", async () => {
		const appId = await seedApp(2);
		await writeRawEntry(appId, 1, [
			{
				kind: "retired-pre-horizon-vocabulary",
				payload: 9_007_199_254_740_992,
			},
		]);
		await writeBaselineMarker(appId, 2);

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) =>
				current.some((frame) => frame.event === "protocol-failure"),
		});

		expect(
			frames.find((frame) => frame.event === "protocol-failure")?.data,
		).toEqual({ reason: "malformed-app-change-suffix" });
		expect(frames.some((frame) => frame.event === "reload")).toBe(false);
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
	});

	it("admits every post-baseline body before reloading for the baseline", async () => {
		const appId = await seedApp(3);
		await writeRawEntry(appId, 1, [{ kind: "retired-pre-horizon-vocabulary" }]);
		await writeBaselineMarker(appId, 2);
		await writeRawEntry(appId, 3, [
			{ kind: "setAppName", name: "invalid", unexpected: true },
		]);
		await appDb
			.updateTable("apps")
			.set({ mutation_seq: GENESIS_SEQ + 3 })
			.where("id", "=", appId)
			.execute();

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) =>
				current.some((frame) => frame.event === "protocol-failure"),
		});

		expect(
			frames.filter((frame) => frame.event === "protocol-failure"),
		).toEqual([
			{
				event: "protocol-failure",
				data: { reason: "malformed-app-change-suffix" },
			},
		]);
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
		expect(frames.some((frame) => frame.event === "reload")).toBe(false);
	});

	it("rejects an empty blueprint migration before emitting any suffix frame", async () => {
		const appId = await seedApp(1);
		await writeEntry(appId, 1, { kind: "blueprint-migration", mutations: [] });

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) =>
				current.some((frame) => frame.event === "protocol-failure"),
		});

		expect(
			frames.filter((frame) => frame.event === "protocol-failure"),
		).toEqual([
			{
				event: "protocol-failure",
				data: { reason: "malformed-app-change-suffix" },
			},
		]);
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
		expect(frames.some((frame) => frame.event === "reload")).toBe(false);
	});

	it("emits no ordinary replay frames before a later blueprint migration", async () => {
		const appId = await seedApp(2);
		await writeEntry(appId, 1);
		await writeEntry(appId, 2, { kind: "blueprint-migration" });

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) => current.some((frame) => frame.event === "reload"),
		});

		const reload = frames.find((frame) => frame.event === "reload");
		expect(reload?.id).toBeUndefined();
		expect(reload?.data).toEqual({ reason: "app-changed" });
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
	});

	it.each([
		["editor", true],
		["viewer", false],
	] as const)(
		"reloads after app-change reauthorization succeeds as destination %s",
		async (role, canEdit) => {
			const appId = await seedApp(1);
			await writeEntry(appId, 1, { kind: "blueprint-migration" });
			resolveAppScopeInTransactionMock
				.mockResolvedValueOnce({
					projectId: PROJECT,
					role: "editor",
					canEdit: true,
					baseSeq: GENESIS_SEQ + 1,
					status: "complete",
					actorUserId: USER,
				})
				.mockResolvedValue({
					projectId: OTHER_PROJECT,
					role,
					canEdit,
					baseSeq: GENESIS_SEQ + 1,
					actorUserId: USER,
				});

			const { frames } = await collectUntil(appId, {
				since: 0,
				predicate: (current) =>
					current.some((frame) => frame.event === "reload"),
			});

			const reload = frames.find((frame) => frame.event === "reload");
			expect(reload?.id).toBeUndefined();
			expect(reload?.data).toEqual({ reason: "app-changed" });
			expect(frames.some((frame) => frame.event === "revoked")).toBe(false);
		},
	);

	it("keeps cursor M-1 across transient app-change reauthorization and retries row M", async () => {
		const appId = await seedApp(2);
		await writeEntry(appId, 1);
		await writeEntry(appId, 2, { kind: "blueprint-migration" });
		let attempts = 0;
		__setStreamReadTestHooksForTests({
			beforeAppChangeReauthorization() {
				attempts += 1;
				if (attempts === 1)
					throw new Error("transient reauthorization failure");
			},
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) => current.some((frame) => frame.event === "reload"),
		});

		expect(attempts).toBe(2);
		const reload = frames.find((frame) => frame.event === "reload");
		expect(reload?.id).toBeUndefined();
		expect(reload?.data).toEqual({ reason: "app-changed" });
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
	});

	it("revokes seq-less when a source-only user loses view after an app change", async () => {
		const appId = await seedApp(2);
		await writeEntry(appId, 1);
		await writeEntry(appId, 2, { kind: "blueprint-migration" });
		resolveAppScopeInTransactionMock
			.mockResolvedValueOnce({
				projectId: PROJECT,
				role: "editor",
				canEdit: true,
				baseSeq: GENESIS_SEQ + 2,
				status: "complete",
				actorUserId: USER,
			})
			.mockRejectedValue(new MockAppAccessError("not_member"));

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (current) =>
				current.some((frame) => frame.event === "revoked"),
		});

		const revoked = frames.find((frame) => frame.event === "revoked");
		expect(revoked?.id).toBeUndefined();
		expect(revoked?.data).toEqual({ reason: "access-revoked" });
		expect(frames.some((frame) => frame.event === "mutation")).toBe(false);
		expect(frames.some((frame) => frame.event === "reload")).toBe(false);
	});

	it("resumes past already-seen frames on a Last-Event-ID reconnect", async () => {
		const appId = await seedApp(3);
		await writeEntry(appId, 1);
		await writeEntry(appId, 2);
		await writeEntry(appId, 3);

		// Logical Last-Event-ID 2 maps past durable seq 3, so durable seq 4 replays.
		const { frames } = await collectUntil(appId, {
			lastEventId: "2",
			predicate: (f) =>
				f.some((x) => x.event === "mutation" && x.id === "4") &&
				f.some((x) => x.event === "lookup-revision"),
		});

		const mutations = frames.filter((f) => f.event === "mutation");
		expect(mutations.map((f) => f.id)).toEqual(["4"]);
		/* The initial lookup manifest rides the same EventSource but is seq-less,
		 * so the browser's mutation Last-Event-ID remains 3. */
		const lookupFrames = frames.filter((f) => f.event === "lookup-revision");
		expect(lookupFrames.length).toBeGreaterThan(0);
		expect(lookupFrames.every((f) => f.id === undefined)).toBe(true);
	});

	it("mutation frame carries the projected client shape (runId ridden through, no ts)", async () => {
		const appId = await seedApp(1);
		// A chat commit carries a runId: it must ride through for the reconciler's
		// echo classification.
		await writeEntry(appId, 1, { kind: "chat", runId: "run-abc" });

		const { frames } = await collectUntil(appId, {
			since: 0,
			predicate: (f) => f.some((x) => x.event === "mutation" && x.id === "2"),
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
		if (!presence) throw new Error("no presence frame arrived");
		const entry = (presence.data as Record<string, unknown>[])[0];
		expect(entry?.userId).toBe(USER);
		// The wire shape is exactly the reconciler/presence-relevant fields:
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

	it("emits no partial presence roster when any stored row is malformed", async () => {
		const appId = await seedApp(0);
		await writePresence(appId, "good");
		await writePresence(appId, "bad", {
			location: { kind: "not-a-real-kind" },
		});

		const { frames } = await collectUntil(appId, {
			since: 0,
			timeoutMs: 3_000,
			/* The independent lookup current page proves initial stream delivery ran;
			 * the malformed presence page must not publish its valid subset. */
			predicate: (f) => f.some((x) => x.event === "lookup-revision"),
		});

		expect(frames.some((frame) => frame.event === "presence")).toBe(false);
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

	it("revokes within the cadence when membership is lost", async () => {
		const appId = await seedApp(0);
		// Connect-time scope passes; the cadence re-check then denies with a REAL
		// `AppAccessError` (the only membership-loss signal that revokes).
		resolveAppScopeInTransactionMock
			.mockResolvedValueOnce({
				projectId: PROJECT,
				role: "editor",
				canEdit: true,
				baseSeq: GENESIS_SEQ,
				status: "complete",
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
		// A cookie that now resolves to a DIFFERENT user: the cadence closes on
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
		// Every cadence signal is transient/ambiguous: an authorized collaborator
		// must NOT be booted.
		getSessionSafeMock.mockResolvedValue(null);
		isUserActiveMock.mockRejectedValue(new Error("pool exhausted"));
		resolveAppScopeInTransactionMock
			.mockResolvedValueOnce({
				projectId: PROJECT,
				role: "editor",
				canEdit: true,
				baseSeq: GENESIS_SEQ,
				status: "complete",
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

	it.each([
		[
			"Project",
			{
				projectId: OTHER_PROJECT,
				role: "editor",
				canEdit: true,
			},
		],
		[
			"role",
			{
				projectId: PROJECT,
				role: "admin",
				canEdit: true,
			},
		],
		[
			"canEdit",
			{
				projectId: PROJECT,
				role: "editor",
				canEdit: false,
			},
		],
	] as const)(
		"reloads seq-less when captured %s changes",
		async (_name, fresh) => {
			const appId = await seedApp(0);
			resolveAppScopeInTransactionMock
				.mockResolvedValueOnce({
					projectId: PROJECT,
					role: "editor",
					canEdit: true,
					baseSeq: GENESIS_SEQ,
					actorUserId: USER,
				})
				.mockResolvedValue({
					...fresh,
					baseSeq: GENESIS_SEQ,
					actorUserId: USER,
				});

			const { frames } = await collectUntil(appId, {
				since: 0,
				predicate: (current) =>
					current.some((frame) => frame.event === "reload"),
			});

			const reload = frames.find((frame) => frame.event === "reload");
			expect(reload?.id).toBeUndefined();
			expect(reload?.data).toEqual({ reason: "authorization-changed" });
			expect(frames.some((frame) => frame.event === "revoked")).toBe(false);
		},
	);

	it("returns the IDOR-safe 404 when connect-time authorization denies", async () => {
		const appId = await seedApp(0);
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		resolveAppScopeInTransactionMock.mockRejectedValue(
			new MockAppAccessError("not_member"),
		);

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

	it("tears down pumps, subscriptions, intervals, and the abort listener on abort only", async () => {
		const appId = await seedApp(1);
		await writeEntry(appId, 1);
		await warmStreamListener();
		let mutationAttempts = 0;
		let lookupAttempts = 0;
		__setStreamReadTestHooksForTests({
			beforeMutationRead() {
				mutationAttempts += 1;
				throw new Error("keep mutation retry pending until abort");
			},
			beforeLookupManifestRead() {
				lookupAttempts += 1;
			},
		});
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		const controller = new AbortController();
		const res = await GET(
			new Request(`http://localhost/api/apps/${appId}/stream?since=1`, {
				signal: controller.signal,
			}),
			{ params: Promise.resolve({ id: appId }) },
		);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("stream had no body");

		/* Let both readers start with a mutation retry pending, then exercise only
		 * req.signal abort. Drain through
		 * done without reader.cancel(), so this path cannot accidentally rely on the
		 * underlying stream's cancel hook for cleanup. */
		await vi.waitFor(() => expect(mutationAttempts).toBe(1));
		await reader.read();
		controller.abort();
		let done = false;
		while (!done) {
			const result = await reader.read().catch(() => ({ done: true as const }));
			done = result.done;
		}

		expect(controller.signal.aborted).toBe(true);
		const attemptsAtAbort = { mutationAttempts, lookupAttempts };
		await writeLookupTable(PROJECT, "after_abort");
		await delay(400);
		expect({ mutationAttempts, lookupAttempts }).toEqual(attemptsAtAbort);
	});

	it("tears down on stream cancel without requiring request abort", async () => {
		const appId = await seedApp(0);
		await warmStreamListener();
		let mutationAttempts = 0;
		let lookupAttempts = 0;
		__setStreamReadTestHooksForTests({
			beforeMutationRead() {
				mutationAttempts += 1;
				throw new Error("keep mutation retry pending until cancel");
			},
			beforeLookupManifestRead() {
				lookupAttempts += 1;
			},
		});
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		const controller = new AbortController();
		const res = await GET(
			new Request(`http://localhost/api/apps/${appId}/stream?since=1`, {
				signal: controller.signal,
			}),
			{ params: Promise.resolve({ id: appId }) },
		);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("stream had no body");

		await vi.waitFor(() => expect(mutationAttempts).toBe(1));
		await reader.cancel();
		expect(controller.signal.aborted).toBe(false);
		const attemptsAtCancel = { mutationAttempts, lookupAttempts };
		await writeLookupTable(PROJECT, "after_cancel");
		await delay(400);
		expect({ mutationAttempts, lookupAttempts }).toEqual(attemptsAtCancel);
		/* A second consumer-level cancel is a no-op at the stream layer; the
		 * route's teardown is independently idempotent for cancel+abort races. */
		controller.abort();
		expect(controller.signal.aborted).toBe(true);
	});
});
