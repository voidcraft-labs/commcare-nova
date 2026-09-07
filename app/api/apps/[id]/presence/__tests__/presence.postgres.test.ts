/**
 * The presence write route against a real Postgres testcontainer, the
 * POST/DELETE half of the relay.
 *
 * What this pins:
 *   - POST server-stamps `userId` (never trusts a client-asserted one), keys the
 *     row at `(app_id, user_id, session_id)`, and stamps `updated_at` +
 *     `expire_at`; avatar/email come from the SESSION, never the body.
 *   - A user's two tabs (two `sessionId`s) write two distinct rows, one DELETE
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
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createPerTestAppDb } from "@/lib/db/__tests__/perTestAppDb";
import type { AppDatabase } from "@/lib/db/pg";

const { requireSessionMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
}));

const { GET, POST, DELETE } = await import("../route");
const { commitAppProjectMoveInTransaction } = await import("@/lib/db/apps");

/** Per-tab session ids are shape-pinned to UUIDs. */
const SESS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const USER = "user-1";
const PROJECT = "project-1";
const DESTINATION = "project-2";

const h = setupAppStateTestDb("presence_route_", { authSchema: "migrated" });

let appDb: Kysely<AppDatabase>;

function sessionFor(userId: string) {
	return { user: { id: userId } };
}

async function freshAppId(): Promise<string> {
	const appId = `presence-${crypto.randomUUID()}`;
	await h.seedAppWithBlueprint(
		buildDoc({
			appName: "Presence test",
			modules: [
				{
					name: "Workflow",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		}),
		{ id: appId, owner: USER, projectId: PROJECT },
	);
	await h.seedProjectMember(USER, PROJECT, "editor");
	return appId;
}

async function commitMove(
	db: Kysely<AppDatabase>,
	appId: string,
	insideTransaction?: () => Promise<void>,
) {
	return db.transaction().execute(async (tx) => {
		const result = await commitAppProjectMoveInTransaction(
			tx,
			{
				appId,
				expectedFromProjectId: PROJECT,
				toProjectId: DESTINATION,
				actorUserId: USER,
				assetIdMap: new Map(),
			},
			{
				batchId: crypto.randomUUID(),
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

/** Consume the native response and own any request body left by early refusal. */
async function call(
	handler: (
		req: Request,
		ctx: { params: Promise<{ id: string }> },
	) => Promise<Response>,
	req: Request,
	appId: string,
): Promise<number> {
	try {
		const res = await handler(req, { params: Promise.resolve({ id: appId }) });
		await res.text();
		return res.status;
	} finally {
		if (!req.bodyUsed) await req.body?.cancel();
	}
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

function outcome<T>(
	promise: Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
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
		expect(
			(row?.expire_at.getTime() ?? 0) - (row?.updated_at.getTime() ?? 0),
		).toBe(60_000);
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
		});
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
		const moverDb = createPerTestAppDb(h.uri());
		const gateKey = 7_311_201;
		const gate = new Client({ connectionString: h.uri() });
		let post: Promise<{ value: number } | { error: unknown }> | undefined;
		let move: Promise<{ value: unknown } | { error: unknown }> | undefined;
		try {
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

			post = outcome(
				call(
					POST,
					postReq(appId, {
						sessionId: SESS_A,
						name: "Ada",
						color: "#abcdef",
						location: { kind: "home" },
					}),
					appId,
				),
			);
			await waitForBlockedLocks(gate, 1);
			move = outcome(commitMove(moverDb.appDb, appId));
			// Presence already holds `apps FOR SHARE`; the move queues behind it,
			// then removes that now-stale source-placement row in its own commit.
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);

			await expect(post).resolves.toEqual({ value: 200 });
			await expect(move).resolves.toEqual({ value: { kind: "moved" } });
		} finally {
			await gate.end();
			await Promise.allSettled([post, move]);
			await moverDb.destroy();
		}

		expect(await readPresence(appId, USER, SESS_A)).toBeUndefined();
		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
	}, 15_000);

	it("move-first lets a waiting presence heartbeat reauthorize and recreate a fresh row", async () => {
		const appId = await freshAppId();
		await h.seedProjectMember(USER, PROJECT, "owner");
		await h.seedProjectMember(USER, DESTINATION, "owner");
		const moverDb = createPerTestAppDb(h.uri());
		const observer = new Client({ connectionString: h.uri() });
		let markMoveInside!: () => void;
		const moveInside = new Promise<void>((resolve) => {
			markMoveInside = resolve;
		});
		let allowMoveCommit!: () => void;
		const moveCommitAllowed = new Promise<void>((resolve) => {
			allowMoveCommit = resolve;
		});

		let move: Promise<{ value: unknown } | { error: unknown }> | undefined;
		let post: Promise<{ value: number } | { error: unknown }> | undefined;
		try {
			await observer.connect();
			move = outcome(
				commitMove(moverDb.appDb, appId, async () => {
					markMoveInside();
					await moveCommitAllowed;
				}),
			);
			await Promise.race([
				moveInside,
				move.then((result) => {
					throw new Error(`Move ended before gate: ${JSON.stringify(result)}`);
				}),
			]);
			post = outcome(
				call(
					POST,
					postReq(appId, {
						sessionId: SESS_A,
						name: "Ada",
						color: "#abcdef",
						location: { kind: "home" },
					}),
					appId,
				),
			);
			await waitForBlockedLocks(observer, 1);
			allowMoveCommit();

			await expect(move).resolves.toEqual({ value: { kind: "moved" } });
			await expect(post).resolves.toEqual({ value: 200 });
		} finally {
			allowMoveCommit();
			markMoveInside();
			await Promise.allSettled([move, ...(post !== undefined ? [post] : [])]);
			await observer.end();
			await moverDb.destroy();
		}

		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
		expect(await readPresence(appId, USER, SESS_A)).toBeDefined();
	}, 15_000);

	it("GET returns only live current-app rows with private caching, then refuses lost membership", async () => {
		const appId = await freshAppId();
		await call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		await call(
			POST,
			postReq(appId, {
				sessionId: SESS_B,
				name: "Expired",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		await appDb
			.updateTable("presence")
			.set({ expire_at: new Date(0) })
			.where("session_id", "=", SESS_B)
			.execute();
		const otherAppId = await freshAppId();
		await call(
			POST,
			postReq(otherAppId, {
				sessionId: SESS_A,
				name: "Other app",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			otherAppId,
		);
		const response = await GET(
			new Request(`http://localhost/api/apps/${appId}/presence`),
			{ params: Promise.resolve({ id: appId }) },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		const stored = await readPresence(appId, USER, SESS_A);
		expect(await response.json()).toEqual([
			{
				userId: USER,
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
				image: null,
				email: "",
				updatedAt: stored?.updated_at.getTime(),
			},
		]);
		await h
			.pool()
			.query(
				'DELETE FROM auth_member WHERE "userId" = $1 AND "organizationId" = $2',
				[USER, PROJECT],
			);
		const denied = await GET(
			new Request(`http://localhost/api/apps/${appId}/presence`),
			{ params: Promise.resolve({ id: appId }) },
		);
		expect(denied.status).toBe(404);
		expect(denied.headers.get("cache-control")).toBe("private, no-store");
		await denied.json();
	});

	it.each(["userId", "image", "email"])(
		"rejects client-supplied identity %s before writing",
		async (key) => {
			const appId = await freshAppId();
			expect(
				await call(
					POST,
					postReq(appId, {
						sessionId: SESS_A,
						name: "Ada",
						color: "#abcdef",
						location: { kind: "home" },
						[key]: "someone-else",
					}),
					appId,
				),
			).toBe(400);
			expect(await readPresence(appId, USER, SESS_A)).toBeUndefined();
		},
	);

	it("DELETE cannot remove another user's row with the same browser-session id", async () => {
		const appId = await freshAppId();
		await call(
			POST,
			postReq(appId, {
				sessionId: SESS_A,
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			}),
			appId,
		);
		await h.seedProjectMember("other-user", PROJECT, "viewer");
		requireSessionMock.mockResolvedValue(sessionFor("other-user"));
		expect(
			await call(DELETE, deleteReq(appId, { sessionId: SESS_A }), appId),
		).toBe(200);
		expect(await readPresence(appId, USER, SESS_A)).toBeDefined();
	});

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
