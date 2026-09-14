import { expect, it } from "vitest";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { evaluateFormTool } from "@/lib/agent/tools/evaluateForm";
import { getAuthDb } from "@/lib/auth/db";
import {
	buildCaseTypeMap,
	withProjectContext,
	withSchemaContext,
} from "@/lib/case-store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createEvaluationApp } from "@/lib/preview/engine/__tests__/evaluationFixture";
import { loadFormEvaluationContext } from "../evaluationContext";

const h = setupAppStateTestDb("authoring_evaluation_", {
	authSchema: "migrated",
});
const actor = "evaluator";
const projectId = "evaluation-project";

it("uses the authorized worker's records and makes no case or blueprint writes", async () => {
	const source = await createEvaluationApp({
		name: "Loans",
		case_type: "loan",
		forms: [
			{
				name: "Return",
				type: "close",
				fields: [
					{
						kind: "text",
						id: "condition",
						label: "Condition",
						required: true,
						caseWrite: { caseType: "loan", property: "condition" },
					},
				],
			},
		],
	});
	const appId = await h.seedAppWithBlueprint(source, {
		owner: actor,
		projectId,
	});
	const doc = { ...source, appId };
	const schema = await withSchemaContext();
	await schema.applySchemaChange({
		appId,
		caseType: "loan",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	await h.seedProjectMember("other-worker", projectId, "editor");
	const row = {
		case_type: "loan",
		case_name: "Drill",
		properties: { condition: "Good" },
		status: "open" as const,
		opened_on: new Date(),
		modified_on: new Date(),
		closed_on: null,
		external_id: null,
		parent_case_id: null,
	};
	const own = await withProjectContext(projectId, actor, actor);
	const ownCase = await own.insert({ appId, row });
	const other = await withProjectContext(
		projectId,
		"other-worker",
		"other-worker",
	);
	const otherCase = await other.insert({
		appId,
		row: { ...row, case_name: "Saw" },
	});
	const workspace = makeToolWorkspaceHarness(doc, {
		appId,
		userId: actor,
		projectId,
	}).workspace;
	const beforeRows = await own.query({ appId, caseType: "loan" });
	const beforeApp = await h
		.db()
		.selectFrom("apps")
		.selectAll()
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Return",
	)?.uuid;
	const moduleUuid = doc.moduleOrder.find(
		(id) => doc.modules[id].name === "Loans",
	);
	if (!formUuid || !moduleUuid)
		throw new Error("Evaluation fixture is incomplete.");
	const outcome = await workspace.invoke({
		toolName: "evaluateForm",
		execute: (ctx) =>
			evaluateFormTool.execute(
				{
					moduleUuid,
					formUuid,
					answers: [{ path: "condition", value: "Worn" }],
					caseIds: [ownCase.caseId],
				},
				ctx,
			),
	});
	expect(outcome.data).toMatchObject({
		valid: true,
		proposedValues: {
			kind: "close",
			caseIds: [ownCase.caseId],
			patch: { properties: { condition: "Worn" } },
		},
	});
	expect(outcome.data).not.toHaveProperty("submission");
	expect(outcome.data).toHaveProperty("proposedValues", {
		kind: "close",
		caseIds: [ownCase.caseId],
		patch: { properties: { condition: "Worn" } },
	});
	expect(await own.query({ appId, caseType: "loan" })).toEqual(beforeRows);
	expect(await own.count({ appId, caseType: "commcare-user" })).toBe(0);
	expect(
		await h
			.db()
			.selectFrom("apps")
			.selectAll()
			.where("id", "=", appId)
			.executeTakeFirstOrThrow(),
	).toEqual(beforeApp);
	const refused = await workspace.invoke({
		toolName: "evaluateForm",
		execute: (ctx) =>
			evaluateFormTool.execute(
				{ moduleUuid, formUuid, answers: [], caseIds: [otherCase.caseId] },
				ctx,
			),
	});
	expect(refused.data).toHaveProperty("error");
	const foreign = makeToolWorkspaceHarness(doc, {
		appId,
		userId: actor,
		projectId: "different-project",
	}).workspace;
	await expect(
		foreign.invoke({
			toolName: "evaluateForm",
			execute: (ctx) => loadFormEvaluationContext(ctx),
		}),
	).rejects.toThrow();
	const auth = await getAuthDb();
	await auth
		.deleteFrom("auth_member")
		.where("userId", "=", actor)
		.where("organizationId", "=", projectId)
		.execute();
	await expect(
		workspace.invoke({
			toolName: "evaluateForm",
			execute: (ctx) => loadFormEvaluationContext(ctx),
		}),
	).rejects.toThrow();
});
