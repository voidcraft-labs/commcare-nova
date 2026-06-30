// Real-Postgres tests for the case re-tenant (`retenantAppCases`), the
// case-store half of moving an app between Projects. It keys on `app_id` alone
// and moves every row not already in the destination — idempotent and convergent,
// which is what makes the move self-heal after a crash between the flip and here.
// Uses the testcontainer `db` fixture (transactional, rolled back per test); a
// single UPDATE opens no nested BEGIN, so the standard fixture works.

import { retenantAppCasesOn } from "../retenant";
import { expect, makeCaseRow, test } from "../sql/__tests__/setup";

test("moves only the named app's rows into the destination", async ({ db }) => {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({ app_id: "app-1", project_id: "P-src" }),
			makeCaseRow({ app_id: "app-1", project_id: "P-src" }),
			// Already at the destination — must not be touched / double-counted.
			makeCaseRow({ app_id: "app-1", project_id: "P-dst" }),
			// A different app — must stay put regardless of Project.
			makeCaseRow({ app_id: "app-2", project_id: "P-src" }),
		])
		.execute();

	const { moved } = await retenantAppCasesOn(db, {
		appId: "app-1",
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

	const app1Elsewhere = await db
		.selectFrom("cases")
		.selectAll()
		.where("app_id", "=", "app-1")
		.where("project_id", "!=", "P-dst")
		.execute();
	expect(app1Elsewhere).toHaveLength(0);

	const app2AtSrc = await db
		.selectFrom("cases")
		.selectAll()
		.where("app_id", "=", "app-2")
		.where("project_id", "=", "P-src")
		.execute();
	expect(app2AtSrc).toHaveLength(1);
});

test("converges rows split across Projects onto the destination", async ({
	db,
}) => {
	// The crash-recovery shape: a prior partial move left this app's rows split
	// across two Projects. One re-tenant pulls them all to the destination.
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({ app_id: "app-x", project_id: "P-a" }),
			makeCaseRow({ app_id: "app-x", project_id: "P-b" }),
		])
		.execute();

	const { moved } = await retenantAppCasesOn(db, {
		appId: "app-x",
		toProjectId: "P-dst",
	});
	expect(moved).toBe(2);

	const all = await db
		.selectFrom("cases")
		.selectAll()
		.where("app_id", "=", "app-x")
		.execute();
	expect(all).toHaveLength(2);
	expect(all.every((r) => r.project_id === "P-dst")).toBe(true);
});

test("is idempotent — a re-run after the move matches zero rows", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([makeCaseRow({ app_id: "app-y", project_id: "P-a" })])
		.execute();

	expect(
		(await retenantAppCasesOn(db, { appId: "app-y", toProjectId: "P-b" }))
			.moved,
	).toBe(1);
	expect(
		(await retenantAppCasesOn(db, { appId: "app-y", toProjectId: "P-b" }))
			.moved,
	).toBe(0);
});
