import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	CasePropertyRenamePlanError,
	type RenameCasePropertiesMutation,
} from "@/lib/doc/casePropertyRenames";
import {
	CasePropertySemanticProvenanceRequiredError,
	diffDocsToMutations,
} from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const FORM = testUuid("20000000-0000-4000-8000-000000000000");
const FIELD_A = testUuid("30000000-0000-4000-8000-000000000001");
const FIELD_B = testUuid("30000000-0000-4000-8000-000000000002");
const FIELD_NEW = testUuid("30000000-0000-4000-8000-000000000003");
const OPERATION = testUuid("40000000-0000-4000-8000-000000000000");

function fixture(): BlueprintDoc {
	return {
		appId: "app",
		appName: "App",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: ["a", "b", "c"].map((name) => ({
					name,
					label: proseText(name.toUpperCase()),
					data_type: "text" as const,
				})),
			},
		],
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "edit_patient",
				name: "Edit patient",
				type: "followup",
				caseOperations: [
					{
						uuid: OPERATION,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [{ property: "a", value: term(literal("value")) }],
					},
				],
			},
		},
		fields: {
			[FIELD_A]: {
				uuid: FIELD_A,
				id: "question_a",
				kind: "text",
				label: proseText("A"),
				caseWrite: { caseType: "patient", property: "a" },
			},
			[FIELD_B]: {
				uuid: FIELD_B,
				id: "question_b",
				kind: "text",
				label: proseText("B"),
				caseWrite: { caseType: "patient", property: "b" },
			},
		},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD_A, FIELD_B] },
		fieldParent: { [FIELD_A]: FORM, [FIELD_B]: FORM },
	};
}

function catalogOnlyFixture(): BlueprintDoc {
	const doc = fixture();
	return {
		...doc,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

function rename(
	...renames: RenameCasePropertiesMutation["renames"]
): RenameCasePropertiesMutation {
	return { kind: "renameCaseProperties", renames };
}

function admittedRename(
	...renames: RenameCasePropertiesMutation["renames"]
): AdmittedMutationBatch {
	return admitMutationBatch([rename(...renames)]);
}

function apply(
	doc: BlueprintDoc,
	mutations: readonly Mutation[] | AdmittedMutationBatch,
): BlueprintDoc {
	const admitted = admitMutationBatch(mutations);
	return produce(doc, (draft) => {
		applyMutations(draft, admitted);
	});
}

function caseWriteProperty(
	doc: BlueprintDoc,
	fieldUuid: typeof FIELD_A | typeof FIELD_B,
): string | undefined {
	const field = doc.fields[fieldUuid];
	return field !== undefined && "caseWrite" in field
		? field.caseWrite?.property
		: undefined;
}

function expectRoundTrip(prev: BlueprintDoc, next: BlueprintDoc): Mutation[] {
	const mutations = diffDocsToMutations(prev, next);
	expect(toPersistableDoc(apply(prev, mutations))).toEqual(
		toPersistableDoc(next),
	);
	return mutations;
}

describe("explicit app-wide case-property rename", () => {
	it("applies chains, swaps, and cycles simultaneously while field ids stay local", () => {
		const start = fixture();
		const chain = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "fresh" },
			),
		);
		expect(chain.fields[FIELD_A].id).toBe("question_a");
		expect(chain.fields[FIELD_B].id).toBe("question_b");
		expect(caseWriteProperty(chain, FIELD_A)).toBe("b");
		expect(caseWriteProperty(chain, FIELD_B)).toBe("fresh");
		expect(chain.forms[FORM].caseOperations?.[0]?.writes?.[0]?.property).toBe(
			"b",
		);
		expect(
			chain.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["b", "fresh", "c"]);

		const swap = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "a" },
			),
		);
		expect(caseWriteProperty(swap, FIELD_A)).toBe("b");
		expect(caseWriteProperty(swap, FIELD_B)).toBe("a");
		expect(
			swap.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["b", "a", "c"]);

		const cycle = apply(
			start,
			admittedRename(
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "c" },
				{ caseType: "patient", from: "c", to: "a" },
			),
		);
		expect(
			cycle.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["b", "c", "a"]);
	});

	it.each([
		["self-rename", [{ caseType: "patient", from: "a", to: "a" }]],
		[
			"duplicate-source",
			[
				{ caseType: "patient", from: "a", to: "fresh" },
				{ caseType: "patient", from: "a", to: "other" },
			],
		],
		[
			"duplicate-destination",
			[
				{ caseType: "patient", from: "a", to: "fresh" },
				{ caseType: "patient", from: "b", to: "fresh" },
			],
		],
		["source-missing", [{ caseType: "patient", from: "missing", to: "fresh" }]],
		["occupied-destination", [{ caseType: "patient", from: "a", to: "b" }]],
		[
			"standard-scalar-property",
			[{ caseType: "patient", from: "a", to: "case_name" }],
		],
	] as const)(
		"rejects a non-bijective or inadmissible relation: %s",
		(reason, entries) => {
			expect(() => apply(fixture(), admittedRename(...entries))).toThrowError(
				expect.objectContaining({
					name: CasePropertyRenamePlanError.name,
					issue: expect.objectContaining({ reason }),
				}),
			);
		},
	);

	it("rejects a mixed batch at canonical admission", () => {
		expect(() =>
			admitMutationBatch([
				rename({ caseType: "patient", from: "a", to: "fresh" }),
				{ kind: "setAppName", name: "Mixed" },
			]),
		).toThrow();
	});
});

describe("endpoint diff keeps local carrier edits local", () => {
	it("round-trips writer add and removal without manufacturing rename intent", () => {
		const start = fixture();
		const withWriter = apply(start, [
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: FIELD_NEW,
					id: "question_fresh",
					kind: "text",
					label: proseText("Fresh"),
					caseWrite: { caseType: "patient", property: "fresh" },
				},
			},
		]);
		expectRoundTrip(start, withWriter);
		const removed = apply(withWriter, [
			{ kind: "removeField", uuid: FIELD_NEW },
		]);
		expectRoundTrip(withWriter, removed);
	});

	it("round-trips a local field caseWrite retarget without moving peer carriers", () => {
		const start = fixture();
		const retargeted = apply(start, [
			{
				kind: "updateField",
				uuid: FIELD_A,
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "fresh" },
				},
			},
		]);
		const mutations = expectRoundTrip(start, retargeted);
		expect(mutations).toContainEqual({
			kind: "updateField",
			uuid: FIELD_A,
			targetKind: "text",
			patch: {
				caseWrite: { caseType: "patient", property: "fresh" },
			},
		});
		expect(caseWriteProperty(retargeted, FIELD_B)).toBe("b");
		expect(
			retargeted.forms[FORM].caseOperations?.[0]?.writes?.[0]?.property,
		).toBe("a");
	});

	it("round-trips a case-operation write destination edit", () => {
		const start = fixture();
		const changed = produce(start, (draft) => {
			const operation = draft.forms[FORM].caseOperations?.[0];
			if (operation?.writes?.[0] !== undefined) {
				operation.writes[0].property = "b";
			}
		});
		const mutations = expectRoundTrip(start, changed);
		expect(mutations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "updateForm",
					uuid: FORM,
					caseOperationPatch: {
						operation: "remove-write",
						uuid: OPERATION,
						property: "a",
					},
				}),
				expect.objectContaining({
					kind: "updateForm",
					uuid: FORM,
					caseOperationPatch: expect.objectContaining({
						operation: "add-write",
						uuid: OPERATION,
						value: expect.objectContaining({ property: "b" }),
					}),
				}),
			]),
		);
	});

	it("round-trips independent catalog add and removal", () => {
		const start = fixture();
		const added = apply(start, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "fresh", label: proseText("Fresh") },
			},
		]);
		expectRoundTrip(start, added);
		const removed = apply(added, [
			{
				kind: "removeCaseProperty",
				caseType: "patient",
				property: "fresh",
			},
		]);
		expectRoundTrip(added, removed);
	});
});

describe("case-property placement anchors", () => {
	it.each([
		["missing", "missing"],
		["wrong case type", "household_only"],
		["self", "fresh"],
	] as const)("rejects a %s anchor", (_label, after) => {
		const start = fixture();
		start.caseTypes?.push({
			name: "household",
			properties: [
				{ name: "household_only", label: proseText("Household only") },
			],
		});
		expect(
			mutationTargetsInvalid(start, [
				{
					kind: "addCaseProperty",
					caseType: "patient",
					property: { name: "fresh", label: proseText("Fresh") },
					after,
				},
			]),
		).toBe(true);
	});

	it("rejects an anchor removed earlier in the same batch", () => {
		expect(
			mutationTargetsInvalid(fixture(), [
				{
					kind: "removeCaseProperty",
					caseType: "patient",
					property: "b",
				},
				{
					kind: "addCaseProperty",
					caseType: "patient",
					property: { name: "fresh", label: proseText("Fresh") },
					after: "b",
				},
			]),
		).toBe(true);
	});

	it("uses null for first, a same-type name for middle, and omission only for append", () => {
		const start = catalogOnlyFixture();
		const first = apply(start, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "first", label: proseText("First") },
				after: null,
			},
		]);
		const middle = apply(first, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "middle", label: proseText("Middle") },
				after: "a",
			},
		]);
		const end = apply(middle, [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "end", label: proseText("End") },
			},
		]);
		expect(
			end.caseTypes?.[0]?.properties.map((property) => property.name),
		).toEqual(["first", "a", "middle", "b", "c", "end"]);
	});
});

describe("endpoint ambiguity and exact command provenance", () => {
	it("refuses an exact full-carrier rename without provenance", () => {
		const start = fixture();
		const command = admittedRename({
			caseType: "patient",
			from: "a",
			to: "fresh",
		});
		const renamed = apply(start, command);
		expect(() => diffDocsToMutations(start, renamed)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
		expect(
			diffDocsToMutations(start, renamed, {
				casePropertyRename: command,
			}),
		).toEqual(command);
	});

	it("still refuses a rename-shaped subdelta when the app name also changes", () => {
		const start = fixture();
		const renamed = apply(
			start,
			admittedRename({
				caseType: "patient",
				from: "a",
				to: "fresh",
			}),
		);
		const renamedAndRetitled = produce(renamed, (draft) => {
			draft.appName = "Retitled app";
		});

		expect(() => diffDocsToMutations(start, renamedAndRetitled)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
	});

	it("still refuses a rename-shaped subdelta when an unrelated field label also changes", () => {
		const start = fixture();
		const renamed = apply(
			start,
			admittedRename({
				caseType: "patient",
				from: "a",
				to: "fresh",
			}),
		);
		const renamedAndRelabeled = produce(renamed, (draft) => {
			const field = draft.fields[FIELD_B];
			if (field !== undefined && "label" in field) {
				field.label = proseText("New question label");
			}
		});

		expect(() => diffDocsToMutations(start, renamedAndRelabeled)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
	});

	it("rejects provenance that does not reproduce the complete endpoint", () => {
		const start = fixture();
		const renamed = apply(
			start,
			admittedRename({
				caseType: "patient",
				from: "a",
				to: "fresh",
			}),
		);
		expect(() =>
			diffDocsToMutations(start, renamed, {
				casePropertyRename: admittedRename({
					caseType: "patient",
					from: "b",
					to: "other",
				}),
			}),
		).toThrow(CasePropertySemanticProvenanceRequiredError);
	});

	it("returns the exact recorded command instead of synthesized carrier edits", () => {
		const start = fixture();
		const command = admittedRename(
			{ caseType: "patient", from: "a", to: "b" },
			{ caseType: "patient", from: "b", to: "a" },
		);
		// The provenance path is defined by replaying the exact recorded
		// semantic command, not by reconstructing local carrier edits.
		const replayed = apply(start, command);
		expect(
			diffDocsToMutations(start, replayed, {
				casePropertyRename: command,
			}),
		).toEqual(command);
	});

	it("uses an exact recorded non-rename catalog replacement only to construct its granular inverse", () => {
		const start = catalogOnlyFixture();
		const forward = admitMutationBatch([
			{
				kind: "removeCaseProperty",
				caseType: "patient",
				property: "a",
			},
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "fresh", label: proseText("Fresh") },
			},
		]);
		const replaced = apply(start, forward);

		expect(() => diffDocsToMutations(replaced, start)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);
		const inverse = diffDocsToMutations(replaced, start, {
			recordedNonRenameForward: forward,
		});
		expect(inverse).not.toContainEqual(
			expect.objectContaining({ kind: "renameCaseProperties" }),
		);
		expect(toPersistableDoc(apply(replaced, inverse))).toEqual(
			toPersistableDoc(start),
		);
	});

	it("constructs a local writer-retarget inverse from its exact ordinary command without widening rename authority", () => {
		const start = fixture();
		const forward = admitMutationBatch([
			{
				kind: "updateField",
				uuid: FIELD_A,
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "fresh" },
				},
			},
		]);
		const retargeted = apply(start, forward);
		const inverse = diffDocsToMutations(retargeted, start, {
			recordedNonRenameForward: forward,
		});

		expect(inverse).toContainEqual({
			kind: "updateField",
			uuid: FIELD_A,
			targetKind: "text",
			patch: {
				caseWrite: { caseType: "patient", property: "a" },
			},
		});
		expect(inverse).not.toContainEqual(
			expect.objectContaining({ kind: "renameCaseProperties" }),
		);
		expect(toPersistableDoc(apply(retargeted, inverse))).toEqual(
			toPersistableDoc(start),
		);
	});

	it("rejects an explicit rename or mismatched replay presented as ordinary provenance", () => {
		const start = fixture();
		const command = admittedRename({
			caseType: "patient",
			from: "a",
			to: "fresh",
		});
		const renamed = apply(start, command);
		expect(() =>
			diffDocsToMutations(renamed, start, {
				recordedNonRenameForward: command,
			}),
		).toThrow(CasePropertySemanticProvenanceRequiredError);
		expect(() =>
			diffDocsToMutations(renamed, start, {
				recordedNonRenameForward: admitMutationBatch([
					{ kind: "setAppName", name: "Wrong" },
				]),
			}),
		).toThrow(CasePropertySemanticProvenanceRequiredError);
	});
});
