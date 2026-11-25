import { sql } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	recordWebFormActivity,
	recordWebPreviewRestore,
	type WebActivityEntry,
} from "../webFormActivityStore";

const h = setupAppStateTestDb("web_form_activity_", { authSchema: "migrated" });
afterEach(() => vi.unstubAllEnvs());

it("shares an authorized notice across workers and suppresses a protected title after access changes", async () => {
	vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-preview-activity-test");
	const projectId = "visit-team";
	const actorId = "viewer";
	const appId = await h.seedApp({ owner: actorId, project_id: projectId });
	const app = await h
		.db()
		.selectFrom("apps")
		.select("mutation_seq")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const baseSeq = Number(app.mutation_seq);
	const scope = { appId, projectId, actorId, workerId: "field-a", baseSeq };
	const other = { ...scope, workerId: "field-b" };
	const entry: WebActivityEntry = {
		formUuid: "visit-form",
		caseIds: ["case-a"],
	};
	const open = {
		entry,
		namespace: "sample-form",
		key: "shared",
		title: "Visit north",
		workerName: "Ada",
		windowSeconds: 300,
		kind: "opened" as const,
		mayReadEntry: async () => true,
	};
	const restore = () =>
		h.withTransaction((tx) => recordWebPreviewRestore(tx, other, "sync"));
	await restore();
	expect(
		await h.withTransaction((tx) => recordWebFormActivity(tx, scope, open)),
	).toBeNull();
	expect(
		await h.withTransaction((tx) =>
			recordWebFormActivity(tx, scope, { ...open, kind: "submitted" }),
		),
	).toBeNull();
	expect(
		await h.withTransaction((tx) => recordWebFormActivity(tx, other, open)),
	).toMatchObject({ title: "Visit north", kind: "submitted" });
	const unrelated = {
		...open,
		entry: { ...entry, caseIds: ["case-b"] },
		mayReadEntry: async (_tx: unknown, wanted: WebActivityEntry) =>
			wanted.caseIds.includes("case-b"),
	};
	expect(
		await h.withTransaction((tx) =>
			recordWebFormActivity(tx, other, unrelated),
		),
	).toBeNull();
	expect(
		await h.withTransaction((tx) =>
			recordWebFormActivity(tx, other, {
				...open,
				namespace: "different-form",
			}),
		),
	).toBeNull();
	await restore();
	// Put the recorded restore after the submit even on a millisecond-resolution clock.
	await sql`UPDATE public.preview_web_restores SET restored_at = GREATEST(restored_at,
		(SELECT max(event_at) FROM public.preview_form_activity WHERE app_id=${appId} AND project_id=${projectId}) + interval '1 millisecond')
		WHERE project_id=${projectId} AND app_id=${appId} AND actor_id=${actorId} AND worker_id=${other.workerId}`.execute(
		h.db(),
	);
	expect(
		await h.withTransaction((tx) => recordWebFormActivity(tx, other, open)),
	).toBeNull();
	await h.removeProjectMember(actorId, projectId);
	await expect(
		h.withTransaction((tx) => recordWebFormActivity(tx, other, open)),
	).rejects.toThrow();
	await expect(restore()).rejects.toThrow();
});
