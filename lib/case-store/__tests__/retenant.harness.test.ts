// Real-Postgres tests for the cross-tenant case re-tenant (`retenantAppCases`),
// the case-store half of moving an app between Projects. Uses the testcontainer
// `db` fixture (transactional, rolled back per test). A single UPDATE opens no
// nested BEGIN, so the standard transactional fixture works — no per-test
// database needed.

import { retenantAppCasesOn } from "../retenant";
import { expect, makeCaseRow, test } from "../sql/__tests__/setup";

test("moves only the named app's source-Project rows", async ({ db }) => {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({ app_id: "app-1", project_id: "P-src" }),
			makeCaseRow({ app_id: "app-1", project_id: "P-src" }),
			// Already at the destination — must not be touched / double-counted.
			makeCaseRow({ app_id: "app-1", project_id: "P-dst" }),
			// A different app in the same source Project — must stay put.
			makeCaseRow({ app_id: "app-2", project_id: "P-src" }),
		])
		.execute();

	const { moved } = await retenantAppCasesOn(db, {
		appId: "app-1",
		fromProjectId: "P-src",
		toProjectId: "P-dst",
	});
	expect(moved).toBe(2);

	const app1AtDst = await db
		.selectFrom("cases")
		.selectAll()
		.where("app_id", "=", "app-1")
		.where("project_id", "=", "P-dst")
		.execute();
	expect(app1AtDst).toHaveLength(3);

	const app1AtSrc = await db
		.selectFrom("cases")
		.selectAll()
		.where("app_id", "=", "app-1")
		.where("project_id", "=", "P-src")
		.execute();
	expect(app1AtSrc).toHaveLength(0);

	const app2AtSrc = await db
		.selectFrom("cases")
		.selectAll()
		.where("app_id", "=", "app-2")
		.where("project_id", "=", "P-src")
		.execute();
	expect(app2AtSrc).toHaveLength(1);
});

test("is idempotent — a re-run after the move matches zero rows", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([makeCaseRow({ app_id: "app-x", project_id: "P-a" })])
		.execute();

	const first = await retenantAppCasesOn(db, {
		appId: "app-x",
		fromProjectId: "P-a",
		toProjectId: "P-b",
	});
	expect(first.moved).toBe(1);

	const second = await retenantAppCasesOn(db, {
		appId: "app-x",
		fromProjectId: "P-a",
		toProjectId: "P-b",
	});
	expect(second.moved).toBe(0);
});

test("no-ops when source and destination are the same Project", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([makeCaseRow({ app_id: "app-y", project_id: "P-same" })])
		.execute();

	const { moved } = await retenantAppCasesOn(db, {
		appId: "app-y",
		fromProjectId: "P-same",
		toProjectId: "P-same",
	});
	expect(moved).toBe(0);
});
