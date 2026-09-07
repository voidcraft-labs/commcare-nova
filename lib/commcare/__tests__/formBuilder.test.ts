/** Planner-to-reducer boundary and private case-action projection.
 * These tests make no agent-loop or external CommCare runtime claim. */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { addFieldMutations } from "@/lib/agent/blueprintHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	deriveCaseWriteInventory,
	fieldSchema,
	proseText,
} from "@/lib/domain";
import { assertAndProjectCaseWriteInventory } from "../caseWriteAdmission";
import { deriveCaseConfig } from "../deriveCaseConfig";
import { runValidation } from "../validator/runner";

const FORM = testUuid("planner-form"),
	GROUP = testUuid("planner-group"),
	ONE = testUuid("planner-one"),
	TWO = testUuid("planner-two"),
	ADDED = testUuid("planner-added");
function admitted(doc: BlueprintDoc) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}
function plannerDoc() {
	return admitted(
		buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: "survey",
							fields: [
								f({ kind: "text", uuid: ONE, id: "one" }),
								f({ kind: "text", uuid: TWO, id: "two" }),
								f({
									kind: "group",
									uuid: GROUP,
									id: "group",
									children: [f({ kind: "text", id: "child" })],
								}),
							],
						},
					],
				},
			],
		}),
	);
}
describe("field planner position and identity", () => {
	it.each([
		{ index: 0, after: null, order: [ADDED, ONE, TWO, GROUP] },
		{ index: 1, after: ONE, order: [ONE, ADDED, TWO, GROUP] },
		{ index: undefined, after: undefined, order: [ONE, TWO, GROUP, ADDED] },
	])(
		"anchors display index $index against the current sibling identity",
		({ index, after, order }) => {
			const doc = plannerDoc(),
				before = structuredClone(doc);
			const field = fieldSchema.parse({
				uuid: ADDED,
				id: "added",
				kind: "text",
				label: proseText("Added"),
			});
			const mutations = admitMutationBatch(
				addFieldMutations(doc, { parentUuid: FORM, field, index }),
			);
			expect(mutations).toEqual([
				{
					kind: "addField",
					parentUuid: FORM,
					field,
					...(after === undefined ? {} : { after }),
				},
			]);
			const changed = produce(doc, (draft) => {
				applyMutations(draft, mutations);
			});
			admitted(changed);
			expect(changed.fieldOrder[FORM]).toEqual(order);
			expect(changed.fieldParent[ADDED]).toBe(FORM);
			expect(doc).toEqual(before);
		},
	);
	it("allows a container parent and refuses a leaf or absent parent", () => {
		const doc = plannerDoc();
		const field = fieldSchema.parse({
			uuid: ADDED,
			id: "added",
			kind: "text",
			label: proseText("Added"),
		});
		for (const parentUuid of [ONE, testUuid("absent")])
			expect(addFieldMutations(doc, { parentUuid, field })).toEqual([]);
		const mutations = admitMutationBatch(
			addFieldMutations(doc, { parentUuid: GROUP, field }),
		);
		const changed = produce(doc, (draft) => {
			applyMutations(draft, mutations);
		});
		admitted(changed);
		expect(changed.fieldParent[ADDED]).toBe(GROUP);
		expect(changed.fieldOrder[GROUP].at(-1)).toBe(ADDED);
	});
	it("detaches the planned field from caller-owned nested prose", () => {
		const doc = plannerDoc();
		const field = fieldSchema.parse({
			uuid: ADDED,
			id: "added",
			kind: "text",
			label: proseText("Before"),
		});
		const planned = addFieldMutations(doc, { parentUuid: FORM, field });
		const before = structuredClone(planned);
		if (field.kind !== "text") throw new Error("Expected text field");
		field.label = proseText("After");
		expect(planned).toEqual(before);
	});
});
describe("private case-write projection", () => {
	it.each([false, true])(
		"separates primary and child writers by destination, nested=$0",
		(nested) => {
			const primary = f({
				kind: "text",
				uuid: ONE,
				id: "patient_name",
				caseWrite: { caseType: "patient", property: "case_name" },
			});
			const child = f({
				kind: "text",
				uuid: TWO,
				id: "referral_name",
				caseWrite: { caseType: "referral", property: "case_name" },
			});
			const reason = f({
				kind: "text",
				uuid: ADDED,
				id: "reason",
				caseWrite: { caseType: "referral", property: "reason" },
			});
			const doc = admitted(
				buildDoc({
					caseTypes: [
						{ name: "patient", properties: [] },
						{
							name: "referral",
							parent_type: "patient",
							properties: [{ name: "reason", label: proseText("Reason") }],
						},
					],
					modules: [
						{
							name: "Patients",
							caseType: "patient",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [
								{
									uuid: FORM,
									name: "Register",
									type: "registration",
									fields: [
										primary,
										...(nested
											? [
													f({
														kind: "group",
														id: "details",
														children: [child, reason],
													}),
												]
											: [child, reason]),
									],
								},
							],
						},
						{
							name: "Referrals",
							caseType: "referral",
							caseListOnly: true,
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [],
						},
					],
				}),
			);
			const before = structuredClone(doc);
			const inventory = deriveCaseWriteInventory(
				doc,
				FORM,
				{ caseType: "patient" },
				"registration",
			);
			const config = deriveCaseConfig(
				doc,
				assertAndProjectCaseWriteInventory(inventory),
			);
			expect(
				config.caseNames?.map((w) => ({
					uuid: w.fieldUuid,
					property: w.property,
					path: w.path.toXPath(),
				})),
			).toEqual([
				{ uuid: ONE, property: "case_name", path: "/data/patient_name" },
			]);
			expect(config.caseProperties).toBeUndefined();
			expect(config.childCases).toHaveLength(1);
			const projected = config.childCases?.[0];
			expect(projected?.caseType).toBe("referral");
			expect(projected?.relationship).toBe("child");
			expect(
				projected?.caseNames.map((w) => ({
					uuid: w.fieldUuid,
					property: w.property,
					path: w.path.toXPath(),
				})),
			).toEqual([
				{
					uuid: TWO,
					property: "case_name",
					path: nested ? "/data/details/referral_name" : "/data/referral_name",
				},
			]);
			expect(
				projected?.caseProperties.map((w) => ({
					uuid: w.fieldUuid,
					property: w.property,
					path: w.path.toXPath(),
				})),
			).toEqual([
				{
					uuid: ADDED,
					property: "reason",
					path: nested ? "/data/details/reason" : "/data/reason",
				},
			]);
			expect(doc).toEqual(before);
		},
	);
});
