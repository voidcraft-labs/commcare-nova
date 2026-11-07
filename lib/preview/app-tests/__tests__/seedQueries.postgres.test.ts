import { sql } from "kysely";
import { expect, it } from "vitest";
import { appTestNamespace } from "@/lib/case-store/appTestNamespace";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { __setAppDbForTests } from "@/lib/db/pg";
import { createEvaluationApp } from "../../engine/__tests__/evaluationFixture";
import { startAppTest } from "../service";

const h = setupAppStateTestDb("app_test_seed_queries_", {
	authSchema: "migrated",
});

it("seeds the complete case-type catalog in one insert without changing live schemas", async () => {
	const scope = { appId: "app", projectId: "project", actorUserId: "author" };
	const doc = await createEvaluationApp(
		[
			{
				name: "Clients",
				caseType: "client",
				forms: [{ name: "Register", type: "registration" }],
			},
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Register", type: "registration" }],
			},
		],
		[],
	);
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const before =
		await sql`SELECT * FROM public.case_type_schemas ORDER BY app_id, case_type`.execute(
			h.db(),
		);
	let inserts = 0;
	__setAppDbForTests(
		h.db().withPlugin({
			transformQuery(args) {
				if (
					args.node.kind === "InsertQueryNode" &&
					args.node.into?.table.identifier.name === "case_type_schemas"
				)
					inserts++;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		}),
	);
	const started = await startAppTest(scope, {
		requestId: "start",
		expectedBlueprintSeq: 0,
		input: { purpose: "Read the complete catalog" },
	});
	expect(inserts).toBe(1);
	const rows = await sql<{
		case_type: string;
	}>`SELECT case_type FROM ${sql.id(appTestNamespace(started.testId), "case_type_schemas")} ORDER BY case_type`.execute(
		h.db(),
	);
	expect(rows.rows.map((row) => row.case_type)).toEqual([
		"client",
		"commcare-case-claim",
		"commcare-user",
		"visit",
	]);
	expect(
		(
			await sql`SELECT * FROM public.case_type_schemas ORDER BY app_id, case_type`.execute(
				h.db(),
			)
		).rows,
	).toEqual(before.rows);
});
