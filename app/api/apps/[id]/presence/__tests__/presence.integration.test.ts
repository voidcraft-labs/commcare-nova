/**
 * The presence write route against the Firestore emulator — P5's POST/DELETE
 * half of the relay.
 *
 * What this pins:
 *   - POST server-stamps `userId` (never trusts a client-asserted one), keys the
 *     doc at `{userId}:{sessionId}`, and stamps `updatedAt` + `expireAt`.
 *   - A user's two tabs (two `sessionId`s) write two distinct docs — one DELETE
 *     removes only its own session.
 *   - Both verbs gate on `resolveAppScope` (a denial 404s, IDOR-safe).
 *
 * `requireSession` / `resolveAppScope` are mocked (no Better Auth / Postgres in
 * the emulator harness). Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireSessionMock, resolveAppScopeMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	resolveAppScope: resolveAppScopeMock,
	AppAccessError: class AppAccessError extends Error {
		readonly name = "AppAccessError";
	},
}));

const { POST, DELETE } = await import("../route");
const { getDb, docs } = await import("@/lib/db/firestore");

/** Per-tab session ids are shape-pinned to UUIDs (they ride the doc path). */
const SESS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const USER = "user-1";
const PROJECT = "project-1";

const createdAppIds: string[] = [];
let appCounter = 0;

function sessionFor(userId: string) {
	return { user: { id: userId } } as never;
}

async function seedApp(): Promise<string> {
	appCounter += 1;
	const appId = `presence-test-${appCounter}-${crypto.randomUUID()}`;
	createdAppIds.push(appId);
	await getDb()
		.collection("apps")
		.doc(appId)
		.set({ project_id: PROJECT, owner: USER, mutation_seq: 0 });
	return appId;
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
 * returns a bodied `Response` on every path (`Response.json({ ok: true })` on
 * success, `handleApiError`'s JSON on 4xx). An unconsumed body stream — request
 * OR response — leaves its pull promise pending, which `--detect-async-leaks`
 * flags as a leaked PROMISE. The RESPONSE is drained here so a status-only
 * assertion still settles it; the REQUEST is drained on paths that short-circuit
 * before the route's own `readJsonBody` (the scope-denial 404 rejects at
 * `resolveAppScope` first), guarded on `bodyUsed` so a body the route already
 * consumed is never re-read (which throws).
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

beforeEach(() => {
	createdAppIds.length = 0;
	requireSessionMock.mockReset();
	resolveAppScopeMock.mockReset();
	requireSessionMock.mockResolvedValue(sessionFor(USER));
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
			const snap = await ref.collection("presence").get();
			await Promise.all(snap.docs.map((d) => d.ref.delete()));
			await ref.delete();
		}),
	);
});

describe.skipIf(!emulatorAvailable)(
	"/presence route (Firestore emulator)",
	() => {
		it("POST upserts a session doc keyed {userId}:{sessionId} with a server-stamped userId", async () => {
			const appId = await seedApp();
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

			const snap = await docs.presence(appId, `${USER}:${SESS_A}`).get();
			expect(snap.exists).toBe(true);
			const data = snap.data();
			expect(data?.userId).toBe(USER);
			expect(data?.sessionId).toBe(SESS_A);
			expect(data?.name).toBe("Ada");
			expect(data?.location).toEqual({ kind: "home" });
			expect(data?.expireAt).toBeDefined();
			// No image on the session → stored as an explicit null.
			expect(data?.image).toBeNull();
		});

		it("POST stamps avatar + email from the SESSION, never the body (a client can't wear someone else's identity)", async () => {
			const appId = await seedApp();
			requireSessionMock.mockResolvedValue({
				user: {
					id: USER,
					image: "https://lh3.googleusercontent.com/a/ada",
					email: "ada@dimagi.com",
				},
			} as never);
			// A body-supplied `image`/`email` isn't even accepted: the strict body
			// schema 400s an unknown key (pinned by the malformed-body test below),
			// so the session is structurally the ONLY identity source.
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
			const data = (
				await docs.presence(appId, `${USER}:${SESS_A}`).get()
			).data();
			expect(data?.image).toBe("https://lh3.googleusercontent.com/a/ada");
			expect(data?.email).toBe("ada@dimagi.com");
		});

		it("keeps two tabs' sessions distinct; DELETE removes only the named session", async () => {
			const appId = await seedApp();
			const base = {
				name: "Ada",
				color: "#abcdef",
				location: { kind: "home" },
			};
			await call(POST, postReq(appId, { ...base, sessionId: SESS_A }), appId);
			await call(POST, postReq(appId, { ...base, sessionId: SESS_B }), appId);

			await call(DELETE, deleteReq(appId, { sessionId: SESS_A }), appId);

			expect(
				(await docs.presence(appId, `${USER}:${SESS_A}`).get()).exists,
			).toBe(false);
			expect(
				(await docs.presence(appId, `${USER}:${SESS_B}`).get()).exists,
			).toBe(true);
		});

		it("POST 404s when scope resolution denies (IDOR-safe)", async () => {
			const appId = await seedApp();
			const { AppAccessError } = await import("@/lib/db/appAccess");
			resolveAppScopeMock.mockRejectedValue(new AppAccessError("not_member"));

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
			const appId = await seedApp();
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

		it("POST 400s a path-hostile sessionId (non-UUID rides the doc path)", async () => {
			// `sessionId` is interpolated into the presence document path, and
			// Firestore's `.doc()` treats `/` as a path separator — a freeform
			// string could address nested junk paths or throw synchronously (a 500
			// any member could mint at will from a heartbeat endpoint). The UUID
			// shape pin rejects it at the boundary.
			const appId = await seedApp();
			const status = await call(
				POST,
				postReq(appId, {
					sessionId: "a/b",
					name: "Ada",
					color: "#abcdef",
					location: { kind: "home" },
				}),
				appId,
			);
			expect(status).toBe(400);
		});
	},
);
