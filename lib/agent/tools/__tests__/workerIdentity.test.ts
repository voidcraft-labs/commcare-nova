import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { AuthoringScope } from "@/lib/agent/authoring/bindings";
import { parseQueryValue } from "@/lib/agent/authoring/queryExpressions";
import { createEvaluationApp } from "@/lib/preview/engine/__tests__/evaluationFixture";
import { evaluateForm } from "@/lib/preview/engine/evaluateForm";
import {
	previewAsMe,
	previewAsPersona,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { evaluatePreviewSearchExpression } from "@/lib/preview/engine/searchExpressionEvaluation";
import { getUsersTool } from "../users";

it("the worker readings returned to authors execute in their stated scopes and follow the simulated worker", async () => {
	const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
	const { data } = await harness.runTool(getUsersTool, {});
	const readings = { ...data.builtInIdentity, ...data.builtInPlaces };
	const doc = await createEvaluationApp({
		name: "Approvals",
		case_type: "approval",
		forms: [
			{
				name: "Approve",
				type: "registration",
				recordName: "'Approval'",
				fields: [
					{ kind: "text", id: "note", label: "Note" },
					...Object.entries(readings).map(([id, reading]) => ({
						kind: "hidden",
						id,
						calculate: reading.formExpression,
						caseWrite: { caseType: "approval", property: id },
					})),
				],
			},
		],
	});
	const actor = {
		id: "nova-member",
		name: "Amina Diallo",
		email: "amina@example.org",
	};
	const primaryPlace = testUuid("worker-primary-place");
	const anotherPlace = testUuid("worker-another-place");
	const persona = {
		uuid: testUuid("review-worker"),
		name: "Preview supervisor",
		description: "Fictional Preview identity",
		locations: { primaryUuid: primaryPlace, additionalUuids: [anotherPlace] },
	};
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Approve",
	)?.uuid;
	if (!formUuid) throw new Error("Approval form missing");
	const scope = new AuthoringScope({ doc });
	for (const [identity, expected] of [
		[
			previewAsMe(actor, doc),
			{
				workerId: actor.id,
				loginName: actor.email,
				displayName: actor.name,
				primaryPlace: "",
				assignedPlaces: "",
				primarySharingGroup: "",
			},
		],
		[
			previewAsPersona(actor, persona, doc),
			{
				workerId: persona.uuid,
				loginName: persona.name,
				displayName: persona.name,
				primaryPlace,
				assignedPlaces: `${primaryPlace} ${anotherPlace}`,
				primarySharingGroup: primaryPlace,
			},
		],
	] as const) {
		if (!identity) throw new Error("Identity is unavailable");
		const result = await evaluateForm(
			doc,
			{ formUuid, answers: [] },
			{
				identity,
				cases: { rows: [], indices: [] },
				lookup: {
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				},
			},
		);
		expect(result.valid).toBe(true);
		for (const [key, value] of Object.entries(expected)) {
			expect(result.fields.find((field) => field.path === key)?.value).toBe(
				value,
			);
		}
		expect(result.submission).toMatchObject({
			kind: "registration",
			primary: {
				properties: Object.fromEntries(
					Object.entries(expected).filter(([, value]) => value !== ""),
				),
			},
		});
		for (const key of [
			"workerId",
			"loginName",
			"primaryPlace",
			"assignedPlaces",
			"primarySharingGroup",
		] as const) {
			const expression = parseQueryValue(readings[key].recordExpression, scope);
			expect(
				evaluatePreviewSearchExpression(
					expression,
					previewSessionValues(identity),
				),
			).toBe(expected[key]);
		}
	}
	expect(doc.userPropertyOrder ?? []).toEqual([]);
});
