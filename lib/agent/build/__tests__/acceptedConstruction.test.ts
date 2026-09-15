import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import {
	acceptedConstructionIdentities,
	prepareAcceptedConstruction,
} from "../acceptedConstruction";
import {
	blueprintFormHandle,
	blueprintInputHandle,
	blueprintModuleHandle,
	deriveSliceExecutionBrief,
	formCompositionInputs,
} from "../executionBrief";

function brief() {
	const plan = makeBuildPlan();
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: fixtureValue(plan.slices[0], "slice").id,
	});
}

describe("accepted construction identities", () => {
	it("binds inputs created together and refuses conflicting or repeated declarations", () => {
		const accepted = brief();
		const form = fixtureValue(accepted.formRealizations[0], "form");
		const input = fixtureValue(formCompositionInputs(form)[0], "input");
		const module = fixtureValue(
			accepted.moduleCompositions.find(
				(item) => item.id === form.moduleCompositionId,
			),
			"module",
		);
		const args = {
			toolName: "createModule",
			brief: accepted,
			doc: emptyBlueprintDoc("test-app"),
			bindings: [],
			input: {
				name: module.name,
				forms: [
					{
						name: form.name,
						fields: [{ id: input.fieldId, kind: "text", label: "Name" }],
					},
				],
			},
		};
		const prepared = prepareAcceptedConstruction(args);
		expect(prepared.bindings).toContainEqual({
			handle: blueprintInputHandle(input.compositionItemId),
			uuid: input.compositionItemId,
			entityKind: "field",
		});
		expect(prepared.input).toMatchObject({
			forms: [{ fields: [{ fieldUuid: input.compositionItemId }] }],
		});
		expect(args.input.forms[0].fields[0]).not.toHaveProperty("fieldUuid");
		const fields = args.input.forms[0].fields;
		expect(
			prepareAcceptedConstruction({
				...args,
				input: {
					...args.input,
					forms: [
						{
							name: form.name,
							fields: [
								{
									...fields[0],
									id: "preferred_name",
									fieldUuid: input.compositionItemId,
								},
							],
						},
					],
				},
			}).bindings,
		).toContainEqual({
			handle: blueprintInputHandle(input.compositionItemId),
			uuid: input.compositionItemId,
			entityKind: "field",
		});
		expect(() =>
			prepareAcceptedConstruction({
				...args,
				input: {
					...args.input,
					forms: [
						{
							name: form.name,
							fields: [
								{
									...fields[0],
									id: "supplemental",
									fieldUuid: form.compositionId,
								},
							],
						},
					],
				},
			}),
		).toThrow("belongs to another accepted element");
		expect(() =>
			prepareAcceptedConstruction({
				...args,
				input: {
					...args.input,
					forms: [{ name: form.name, fields: [...fields, ...fields] }],
				},
			}),
		).toThrow("appears more than once");
		expect(() =>
			prepareAcceptedConstruction({
				...args,
				input: {
					...args.input,
					forms: [
						{
							name: form.name,
							fields: [{ ...fields[0], fieldUuid: testUuid("unrelated") }],
						},
					],
				},
			}),
		).toThrow("different accepted identity");
	});

	it("adds accepted inputs to an exactly bound renamed form", () => {
		const accepted = brief();
		const form = fixtureValue(accepted.formRealizations[0], "form");
		const input = fixtureValue(formCompositionInputs(form)[0], "input");
		const module = fixtureValue(
			accepted.moduleRealizations.find(
				(item) => item.compositionId === form.moduleCompositionId,
			),
			"module",
		);
		const doc = buildDoc({
			modules: [
				{
					name: "Renamed module",
					forms: [
						{
							name: "Renamed form",
							type: "survey",
							fields: [{ kind: "text", id: "supplemental" }],
						},
						{
							name: "Earlier workflow",
							type: "survey",
							fields: [{ kind: "text", id: "existing" }],
						},
					],
				},
			],
		});
		const moduleUuid = fixtureValue(doc.moduleOrder[0], "module UUID");
		const formUuid = fixtureValue(doc.formOrder[moduleUuid]?.[0], "form UUID");
		const bindings = [
			{
				handle: module.blueprintModuleHandle,
				uuid: moduleUuid,
				entityKind: "module",
			},
			{
				handle: blueprintFormHandle(form.compositionId),
				uuid: formUuid,
				entityKind: "form",
			},
		];
		const prepared = prepareAcceptedConstruction({
			toolName: "addFields",
			brief: accepted,
			doc,
			bindings,
			input: {
				formUuid: "Renamed form",
				fields: [{ id: input.fieldId, kind: "text", label: "Name" }],
			},
		});
		expect(prepared.input).toMatchObject({
			formUuid,
			fields: [{ fieldUuid: input.compositionItemId }],
		});
		expect(prepared.bindings).toEqual([
			{
				handle: blueprintInputHandle(input.compositionItemId),
				uuid: input.compositionItemId,
				entityKind: "field",
			},
		]);
		const earlierInput = {
			formUuid: "Earlier workflow",
			fields: [
				{ id: input.fieldId, kind: "text", label: "Additional question" },
			],
		};
		const earlier = prepareAcceptedConstruction({
			toolName: "addFields",
			brief: accepted,
			doc,
			bindings,
			input: earlierInput,
		});
		expect(earlier.bindings).toEqual([]);
		expect(earlier.input).toMatchObject({
			formUuid: doc.formOrder[moduleUuid]?.[1],
			fields: earlierInput.fields,
		});
		expect(() =>
			prepareAcceptedConstruction({
				toolName: "addFields",
				brief: accepted,
				doc,
				bindings,
				input: {
					...earlierInput,
					fields: [
						{ ...earlierInput.fields[0], fieldUuid: input.compositionItemId },
					],
				},
			}),
		).toThrow("belongs to another accepted element");
		const existingField = fixtureValue(
			Object.values(doc.fields)[0],
			"existing field",
		);
		expect(() =>
			prepareAcceptedConstruction({
				toolName: "addFields",
				brief: accepted,
				doc,
				bindings: [
					...bindings,
					{
						handle: blueprintInputHandle(input.compositionItemId),
						uuid: existingField.uuid,
						entityKind: "field",
					},
				],
				input: { formUuid, fields: [{ id: input.fieldId, kind: "text" }] },
			}),
		).toThrow("already exists");
	});

	it("keeps existing implementation identity even when names change", () => {
		const accepted = brief();
		const module = fixtureValue(accepted.moduleRealizations[0], "module");
		const doc = buildDoc({ modules: [{ name: "A renamed module" }] });
		const uuid = fixtureValue(doc.moduleOrder[0], "implemented module");
		const bindings = [
			{ handle: module.blueprintModuleHandle, uuid, entityKind: "module" },
		];
		expect(
			acceptedConstructionIdentities({ brief: accepted, doc, bindings }),
		).toContainEqual(
			expect.objectContaining({
				compositionId: module.compositionId,
				uuid,
				exists: true,
			}),
		);
		expect(() =>
			acceptedConstructionIdentities({
				brief: accepted,
				doc,
				bindings: [{ ...bindings[0], entityKind: "form" }],
			}),
		).toThrow("no longer identifies");
	});
	it("refuses an occupied UUID without an exact implementation binding", () => {
		const accepted = brief();
		const module = fixtureValue(accepted.moduleRealizations[0], "module");
		const doc = buildDoc({
			modules: [{ uuid: module.compositionId, name: "Unrelated module" }],
		});
		expect(() =>
			acceptedConstructionIdentities({ brief: accepted, doc, bindings: [] }),
		).toThrow("already occupied");
	});
	it("requires an explicit composition identity when two new modules share a name", () => {
		const accepted = brief();
		const module = fixtureValue(accepted.moduleRealizations[0], "module");
		const composition = fixtureValue(
			accepted.moduleCompositions.find(
				(item) => item.id === module.compositionId,
			),
			"composition",
		);
		// Duplicate names are not identities. The same accepted module choices can
		// be presented without making either one the default target.
		const duplicateId = ids.moduleVisits;
		const duplicate = {
			...accepted,
			moduleCompositions: [
				...accepted.moduleCompositions,
				{ ...composition, id: duplicateId },
			],
			moduleRealizations: [
				...accepted.moduleRealizations,
				{
					...module,
					compositionId: duplicateId,
					blueprintModuleHandle: blueprintModuleHandle(duplicateId),
				},
			],
		};
		const args = {
			toolName: "createModule",
			brief: duplicate,
			doc: emptyBlueprintDoc("test-app"),
			bindings: [],
			input: { name: composition.name, forms: [] },
		};
		expect(() => prepareAcceptedConstruction(args)).toThrow(
			"Several accepted modules",
		);
		expect(
			prepareAcceptedConstruction({
				...args,
				input: { ...args.input, moduleUuid: duplicateId },
			}),
		).toMatchObject({
			input: { moduleUuid: duplicateId },
			bindings: [{ uuid: duplicateId }],
		});
	});
});
