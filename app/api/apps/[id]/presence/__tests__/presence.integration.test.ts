/**
 * The presence write route against a real Postgres testcontainer — the
 * POST/DELETE half of the relay.
 *
 * What this pins:
 *   - POST server-stamps `userId` (never trusts a client-asserted one), keys the
 *     row at `(app_id, user_id, session_id)`, and stamps `updated_at` +
 *     `expire_at`; avatar/email come from the SESSION, never the body.
 *   - A user's two tabs (two `sessionId`s) write two distinct rows — one DELETE
 *     removes only its own session.
 *   - Each POST opportunistically sweeps the app's expired rows (bounds the
 *     table; the roster read already filters expired rows).
 *   - Both verbs reauthorize in the same transaction as the row mutation and
 *     notification (a denial 404s, IDOR-safe); malformed input 400s.
 *
 * Only `requireSession` is mocked. Apps, memberships, presence writes, and the
 * shared membership gate all hit the per-test Postgres directly.
 */

import type { Kysely } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createPerTestAppDb } from "@/lib/db/__tests__/perTestAppDb";
import type { AppDatabase } from "@/lib/db/pg";

const { requireSessionMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
}));

const { POST, DELETE } = await import("../route");
const { commitAppProjectMoveInTransaction } = await import("@/lib/db/apps");
const { setTransactionWriterVersion } = await import("@/lib/db/pg");

/** Per-tab session ids are shape-pinned to UUIDs. */
const SESS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const USER = "user-1";
const PROJECT = "project-1";
const DESTINATION = "project-2";

const h = setupAppStateTestDb("presence_route_");

let appDb: Kysely<AppDatabase>;

function sessionFor(userId: string) {
	return { user: { id: userId } } as never;
}

async function freshAppId(): Promise<string> {
	const appId = `presence-${crypto.randomUUID()}`;
	await h.seedApp({ id: appId, owner: USER, project_id: PROJECT });
	await h.seedProjectMember(USER, PROJECT, "editor");
	return appId;
}

async function enableMoves(): Promise<void> {
	// The migrated floors already satisfy the move-activation CHECK.
	await h
		.db()
		.updateTable("lookup_reference_compatibility")
		.set({ project_moves_enabled: true })
		.where("id", "=", 1)
		.execute();
}

async function commitMove(
	db: Kysely<AppDatabase>,
	appId: string,
	insideTransaction?: () => Promise<void>,
) {
	return db.transaction().execute(async (tx) => {
		await setTransactionWriterVersion(tx, 1);
		const result = await commitAppProjectMoveInTransaction(
			tx,
			{
				appId,
				expectedFromProjectId: PROJECT,
				toProjectId: DESTINATION,
				actorUserId: USER,
				assetIdMap: new Map(),
				attemptedRealIds: new Set(),
			},
			{
				batchId: crypto.randomUUID(),
				declaredWriterVersion: 1,
				streamReceiverVersion: 2,
			},
		);
		await insideTransaction?.();
		return result;
	});
}

function postReq(appId: string, body: unknown): Request {
	return new Request(`http://localhost/api/apps/${appId}/presence`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

function deleteReq(appId: string, body: unknown): Request {
	return new Request(`http://localhost/api/apps/${appId}/presence`, {
		method: "DELETE",
		body: JSON.stringify(body),
	});
}

/**
 * Invoke a presence route handler and ALWAYS drain both body streams, returning
 * the status.
 *
 * Draining is load-bearing under the async-leak gate, not a convenience:
 * `postReq`/`deleteReq` build real `Request`s with a JSON body, and the route
 * returns a bodied `Response` on every path. An unconsumed body stream — request
 * OR response — leaves its pull promise pending, which `--detect-async-leaks`
 * flags. The RESPONSE is drained here so a status-only assertion still settles
 * it; the REQUEST is drained on paths that short-circuit before the route's own
 * `readJsonBody` (the scope-denial 404 rejects at `resolveAppScope` first),
 * guarded on `bodyUsed` so a body the route already consumed is never re-read.
 */
async function call(
	handler: (
		req: Request,
		ctx: { params: Promise<{ id: string }> },
	) => Promise<Response>,
	req: Request,
	appId: string,
): Promise<number> {
	const res = await handler(req, { params: Promise.resolve({ id: appId }) });
	await res.text();
	if (!req.bodyUsed) await req.text();
	return res.status;
}

/** Read one presence row back. */
async function readPresence(appId: string, userId: string, sessionId: string) {
	return appDb
		.selectFrom("presence")
		.selectAll()
		.where("app_id", "=", appId)
		.where("user_id", "=", userId)
		.where("session_id", "=", sessionId)
		.executeTakeFirst();
}

async function waitForBlockedLocks(
	observer: Client,
	minimum: number,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const result = await observer.query<{ count: string }>(`
			SELECT count(*)::text AS count
			FROM pg_locks AS locks
			JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
			WHERE activity.datname = current_database()
			  AND NOT locks.granted
		`);
		if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${minimum} blocked database lock(s).`);
}

beforeEach(async () => {
	appDb = h.db();
	requireSessionMock.mockReset();
	requireSessionMock.mockResolvedValue(sessionFor(USER));
});

describe("/presence route (Postgres)", () => {
	it("POST upserts a row keyed (app_id,user_id,session_id) with a server-stamped userId", async () => {
		const appId = await freshAppId();
		const status = await call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		expect(status).toBe(200);

		const row = await readPresence(appId, USER, SESS_A);
		expect(row).toBeDefined();
		expect(row?.user_id).toBe(USER);
		expect(row?.session_id).toBe(SESS_A);
		expect(row?.name).toBe("Ada");
		expect(row?.location).toEqual({ kind: "home" });
		expect(row?.expire_at).toBeDefined();
		// No image on the session → stored as an explicit null.
		expect(row?.image).toBeNull();
	});

	it("POST stamps avatar + email from the SESSION, never the body (a client can't wear someone else's identity)", async () => {
		const appId = await freshAppId();
		requireSessionMock.mockResolvedValue({
			user: {
				id: USER,
				image: "https://lh3.googleusercontent.com/a/ada",
				email: "ada@dimagi.com",
			},
		} as never);
		// A body-supplied `image`/`email` isn't even accepted: the strict body
		// schema 400s an unknown key (pinned by the malformed-body test below), so
		// the session is structurally the ONLY identity source.
		const status = await call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		expect(status).toBe(200);
		const row = await readPresence(appId, USER, SESS_A);
		expect(row?.image).toBe("https://lh3.googleusercontent.com/a/ada");
		expect(row?.email).toBe("ada@dimagi.com");
	});

	it("re-POST of the same session upserts in place (no duplicate row)", async () => {
		const appId = await freshAppId();
		const base = { name: "Ada", color: "#abcdef", location: { kind: "home" } };
		await call(POST, postReq(appId, { ...base, sessionId: SESS_A }), appId);
		await call(
			POST,
			postReq(appId, { ...base, name: "Ada B.", sessionId: SESS_A }),
			appId,
		);

		const rows = await appDb
			.selectFrom("presence")
			.selectAll()
			.where("app_id", "=", appId)
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("Ada B.");
	});

	it("keeps two tabs' sessions distinct; DELETE removes only the named session", async () => {
		const appId = await freshAppId();
		const base = { name: "Ada", color: "#abcdef", location: { kind: "home" } };
		await call(POST, postReq(appId, { ...base, sessionId: SESS_A }), appId);
		await call(POST, postReq(appId, { ...base, sessionId: SESS_B }), appId);

		await call(DELETE, deleteReq(appId, { sessionId: SESS_A }), appId);

		expect(await readPresence(appId, USER, SESS_A)).toBeUndefined();
		expect(await readPresence(appId, USER, SESS_B)).toBeDefined();
	});

	it("sweeps the app's expired rows on a POST (bounds the table)", async () => {
		const appId = await freshAppId();
		// A dead session whose TTL already lapsed.
		await appDb
			.insertInto("presence")
			.values({
				app_id: appId,
				user_id: "ghost",
				session_id: crypto.randomUUID(),
				name: "Ghost",
				image: null,
				email: "",
				color: "#000000",
				location: JSON.stringify({ kind: "home" }),
				updated_at: new Date(Date.now() - 120_000),
				expire_at: new Date(Date.now() - 60_000),
			})
			.execute();

		const status = await call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		expect(status).toBe(200);

		const rows = await appDb
			.selectFrom("presence")
			.select("session_id")
			.where("app_id", "=", appId)
			.execute();
		// The expired ghost was swept; only the fresh (future-`expire_at`) row survives.
		expect(rows.map((r) => r.session_id)).toEqual([SESS_A]);
	});

	it("presence-writer-first commits before a Project move purges the stale roster", async () => {
		const appId = await freshAppId();
		await h.seedProjectMember(USER, PROJECT, "owner");
		await h.seedProjectMember(USER, DESTINATION, "owner");
		await enableMoves();
		const moverDb = createPerTestAppDb(h.uri());
		const gateKey = 7_311_201;
		const gate = new Client({ connectionString: h.uri() });
		await gate.connect();
		await gate.query("SELECT pg_advisory_lock($1)", [gateKey]);
		await gate.query(`
			CREATE FUNCTION test_pause_presence_writer_first() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(${gateKey});
				RETURN NEW;
			END
			$$;
			CREATE TRIGGER test_pause_presence_writer_first_trigger
				BEFORE INSERT ON presence
				FOR EACH ROW EXECUTE FUNCTION test_pause_presence_writer_first();
		`);

		const post = call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		let gateHeld = true;
		let move: Promise<unknown> | undefined;
		try {
			await waitForBlockedLocks(gate, 1);
			move = commitMove(moverDb.appDb, appId);
			// Presence already holds `apps FOR SHARE`; the move queues behind it,
			// then removes that now-stale source-placement row in its own commit.
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			gateHeld = false;

			await expect(post).resolves.toBe(200);
			await expect(move).resolves.toEqual({ kind: "moved" });
		} finally {
			if (gateHeld) {
				await gate
					.query("SELECT pg_advisory_unlock($1)", [gateKey])
					.catch(() => {});
			}
			await Promise.allSettled([post, ...(move ? [move] : [])]);
			await gate.end().catch(() => {});
			await moverDb.destroy();
		}

		expect(await readPresence(appId, USER, SESS_A)).toBeUndefined();
		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
	}, 15_000);

	it("move-first lets a waiting presence heartbeat reauthorize and recreate a fresh row", async () => {
		const appId = await freshAppId();
		await h.seedProjectMember(USER, PROJECT, "owner");
		await h.seedProjectMember(USER, DESTINATION, "owner");
		await enableMoves();
		const moverDb = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		await observer.connect();
		let markMoveInside!: () => void;
		const moveInside = new Promise<void>((resolve) => {
			markMoveInside = resolve;
		});
		let allowMoveCommit!: () => void;
		const moveCommitAllowed = new Promise<void>((resolve) => {
			allowMoveCommit = resolve;
		});

		const move = commitMove(moverDb.appDb, appId, async () => {
			markMoveInside();
			await moveCommitAllowed;
		});
		let post: Promise<number> | undefined;
		try {
			await moveInside;
			post = call(
				POST,
				postReq(appId, {
					sessionId: SESS_A,
					name: "Ada",
					color: "#abcdef",
					location: { kind: "home" },
				}),
				appId,
			);
			await waitForBlockedLocks(observer, 1);
			allowMoveCommit();

			await expect(move).resolves.toEqual({ kind: "moved" });
			await expect(post).resolves.toBe(200);
		} finally {
			allowMoveCommit();
			await Promise.allSettled([move, ...(post ? [post] : [])]);
			await observer.end().catch(() => {});
			await moverDb.destroy();
		}

		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
		expect(await readPresence(appId, USER, SESS_A)).toBeDefined();
	}, 15_000);

	it("POST 404s when scope resolution denies (IDOR-safe)", async () => {
		const appId = await freshAppId();
		await h
			.pool()
			.query(
				'DELETE FROM auth_member WHERE "userId" = $1 AND "organizationId" = $2',
				[USER, PROJECT],
			);

		const status = await call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		expect(status).toBe(404);
	});

	it("POST 400s on a malformed body (unknown key / bad location)", async () => {
		const appId = await freshAppId();
		const status = await call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "not-a-real-kind" },
			}),
			appId,
		);
		expect(status).toBe(400);
	});

	it("POST 400s a non-UUID sessionId (the per-tab key is shape-pinned)", async () => {
		const appId = await freshAppId();
		const status = await call(
			POST,
			postReq(appId, {
				sessionId: "not-a-uuid",
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		expect(status).toBe(400);
	});
});
