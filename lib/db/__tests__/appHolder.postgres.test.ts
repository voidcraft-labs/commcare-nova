/**
 * Who a waiting chat request is told holds the app, over real Postgres.
 *
 * Contract: `loadAppHolder` names the holder only to a viewer who is still a
 * member of the Project the request was authorized in, while the app is still
 * in that Project; otherwise it answers "someone" with no id. It reads the app
 * row, the viewer's membership and the holder's name in one snapshot.
 *
 * Plausible failure: a request authorized in one Project waits while the app
 * moves to another, whose member then starts a run; reading the app by its id
 * alone would tell the waiting requester that member's name.
 */
import { sql } from "kysely";
import { beforeEach, expect, it } from "vitest";
import { loadAppHolder } from "../apps";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("app_holder_", { authSchema: "migrated" });

const APP = "app-holder";
const SOURCE = "project-holder-source";
const DESTINATION = "project-holder-destination";
const WAITER = "user-holder-waiter";
const HOLDER = "user-holder-destination-member";

beforeEach(async () => {
	await h.seedProjectMember(WAITER, SOURCE, "editor");
	await h.seedProjectMember(HOLDER, SOURCE, "editor");
	await h.seedProjectMember(HOLDER, DESTINATION, "editor");
	await h.seedApp({
		id: APP,
		owner: WAITER,
		project_id: SOURCE,
		status: "complete",
		run_holder_nonce: "00000000-0000-4000-8000-000000000001",
		run_lock: {
			runId: "run-holder",
			actorUserId: HOLDER,
			expireAt: new Date(Date.now() + 600_000),
		},
	});
});

it("names the holder to a member of the Project the request was authorized in", async () => {
	expect(
		await loadAppHolder(APP, { projectId: SOURCE, viewerUserId: WAITER }),
	).toEqual({ name: HOLDER, userId: HOLDER });
});

it("names no one where the app is no longer in the Project the request was authorized in", async () => {
	/* A request authorized in the destination meets the app in another Project: the shape a
	 * request authorized before a move meets after it, with the waiter a member of both. */
	await h.seedProjectMember(WAITER, DESTINATION, "editor");
	expect(
		await loadAppHolder(APP, { projectId: DESTINATION, viewerUserId: WAITER }),
	).toEqual({ name: "someone", userId: undefined });
});

it("names no one to a viewer who has left the Project", async () => {
	await sql`
		DELETE FROM auth_member WHERE "userId" = ${WAITER} AND "organizationId" = ${SOURCE}
	`.execute(h.db());
	expect(
		await loadAppHolder(APP, { projectId: SOURCE, viewerUserId: WAITER }),
	).toEqual({ name: "someone", userId: undefined });
});

it("names no one where the request has no authorized Project", async () => {
	expect(
		await loadAppHolder(APP, { projectId: undefined, viewerUserId: WAITER }),
	).toEqual({ name: "someone", userId: undefined });
});
