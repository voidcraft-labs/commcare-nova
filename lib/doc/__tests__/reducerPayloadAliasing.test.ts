/**
 * A mutation batch survives being applied more than once.
 *
 * This is not a hypothetical. `applyBlueprintChange` derives a prospective
 * document from the batch to work out the case-store schema change, and then
 * `commitGuardedBatch` applies the SAME batch again onto the freshly loaded
 * document — so every server-side save runs the reducers over one batch twice.
 *
 * Both runs go through Immer's `produce`, which FREEZES what it returns. So a
 * reducer that splices its mutation's payload object straight into the draft
 * makes that payload part of a frozen state; the second run's in-place edit of
 * the same object then throws `Cannot assign to read only property`, and the
 * save 500s. The rule is simply: a reducer clones what it stores.
 *
 * The batches below are the shapes that actually reach the server now that the
 * builder persists the commands it dispatched rather than a diff of two
 * documents — an add and a later edit of the same thing land in ONE batch,
 * where a diff would have collapsed them into a single add.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import { asUuid, type BlueprintDoc, type Mutation } from "@/lib/doc/types";
import { literal, term } from "@/lib/domain/predicate";

const MODULE = asUuid("11111111-1111-4111-8111-111111111111");
const FORM = asUuid("22222222-2222-4222-8222-222222222222");
const OPERATION = asUuid("33333333-3333-4333-8333-333333333333");
const COLUMN = asUuid("44444444-4444-4444-8444-444444444444");
const FIELD = asUuid("55555555-5555-4555-8555-555555555555");

function base(): BlueprintDoc {
	return buildDoc({
		appName: "Twice",
		modules: [
			{
				uuid: MODULE,
				name: "Cases",
				caseType: "patient",
				forms: [
					{
						uuid: FORM,
						name: "Register",
						type: "registration",
						fields: [
							f({
								uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [{ name: "patient", properties: [] }],
	});
}

/**
 * Apply the batch the way the server does: twice, each through `produce`, and
 * each from its OWN copy of the prior document.
 *
 * The second run starting fresh is the whole point — `commitGuardedBatch`
 * re-applies onto the document it just loaded from the database, which does not
 * carry the first run's work. So every insert in the batch inserts AGAIN, and
 * the object it inserts the second time is the payload the first run already
 * left frozen inside a produced state. (Re-applying onto the first result
 * instead proves nothing: the adds all short-circuit as no-ops, and Immer
 * drafts frozen base state so the later edits pass either way.)
 */
function applyTwice(batch: Mutation[]): BlueprintDoc {
	produce(base(), (draft) => {
		applyMutations(draft, batch);
	});
	return produce(base(), (draft) => {
		applyMutations(draft, batch);
	});
}

describe("a batch applies twice", () => {
	it("adds a case-operation link and then edits it", () => {
		const doc = applyTwice([
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {},
				caseOperationChange: {
					operation: "add",
					value: {
						uuid: OPERATION,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
					},
				},
			},
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid: OPERATION,
					value: {
						uuid: OPERATION,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: null,
								relationship: "child",
							},
						],
					},
				},
				caseOperationPatch: {
					operation: "add-link",
					uuid: OPERATION,
					value: {
						identifier: "parent",
						targetType: "patient",
						target: null,
						relationship: "child",
					},
					index: 0,
				},
			},
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid: OPERATION,
					value: {
						uuid: OPERATION,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "parent",
								targetType: "household",
								target: null,
								relationship: "child",
							},
						],
					},
				},
				caseOperationPatch: {
					operation: "update-link",
					uuid: OPERATION,
					identifier: "parent",
					patch: { targetType: "household" },
				},
			},
		]);

		const links = doc.forms[FORM].caseOperations?.[0]?.links;
		expect(links).toHaveLength(1);
		expect(links?.[0].targetType).toBe("household");
	});

	it("adds a case-operation write and then edits it", () => {
		const write = { property: "status", value: term(literal("new")) };
		const operation = {
			uuid: OPERATION,
			id: "update_patient",
			action: "update" as const,
			caseType: "patient",
			target: { kind: "session" as const },
		};
		const doc = applyTwice([
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {},
				caseOperationChange: { operation: "add", value: operation },
			},
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid: OPERATION,
					value: { ...operation, writes: [write] },
				},
				caseOperationPatch: {
					operation: "add-write",
					uuid: OPERATION,
					value: write,
					index: 0,
				},
			},
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid: OPERATION,
					value: {
						...operation,
						writes: [{ property: "status", value: term(literal("filed")) }],
					},
				},
				caseOperationPatch: {
					operation: "update-write",
					uuid: OPERATION,
					property: "status",
					patch: { value: term(literal("filed")) },
				},
			},
		]);

		const writes = doc.forms[FORM].caseOperations?.[0]?.writes;
		expect(writes).toHaveLength(1);
		expect(writes?.[0].value).toEqual(term(literal("filed")));
	});

	it("adds a case-list column and then renames it", () => {
		const doc = applyTwice([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: { caseListConfig: null },
				ensureCaseListConfig: true,
			},
			{
				kind: "addColumn",
				moduleUuid: MODULE,
				column: {
					uuid: COLUMN,
					kind: "plain",
					field: "case_name",
					header: "Name",
				},
				afterInList: null,
				afterInDetail: null,
			},
			{
				kind: "updateColumn",
				moduleUuid: MODULE,
				uuid: COLUMN,
				column: {
					uuid: COLUMN,
					kind: "plain",
					field: "case_name",
					header: "Patient name",
				},
			},
		]);

		const columns = doc.modules[MODULE].caseListConfig?.columns;
		expect(columns).toHaveLength(1);
		expect(columns?.[0].header).toBe("Patient name");
	});

	it("adds a field and then edits its label", () => {
		const doc = applyTwice([
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: FIELD,
					kind: "text",
					id: "notes",
					label: "Notes",
				},
			},
			{
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
				patch: { label: "Visit notes" },
			},
		]);

		const field = doc.fields[FIELD];
		expect("label" in field && field.label).toBe("Visit notes");
	});
});
