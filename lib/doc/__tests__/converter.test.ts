import { describe, expect, it } from "vitest";
import { toBlueprint, toDoc } from "@/lib/doc/converter";
import { asUuid, type BlueprintDoc, type ModuleEntity } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

const APP_ID = "test-app-id";

describe("toDoc", () => {
	it("flattens an empty blueprint", () => {
		const bp: AppBlueprint = {
			app_name: "Empty App",
			connect_type: undefined,
			modules: [],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		expect(doc).toMatchObject({
			appId: APP_ID,
			appName: "Empty App",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			questions: {},
			moduleOrder: [],
			formOrder: {},
			questionOrder: {},
		});
	});

	it("converts undefined connect_type to null and preserves defined values", () => {
		const bp: AppBlueprint = {
			app_name: "Learn",
			connect_type: "learn",
			modules: [],
			case_types: [],
		};
		expect(toDoc(bp, APP_ID).connectType).toBe("learn");
	});

	it("generates UUIDs for modules and preserves moduleOrder", () => {
		const bp: AppBlueprint = {
			app_name: "Two Modules",
			connect_type: undefined,
			modules: [
				{ name: "First", forms: [] },
				{ name: "Second", forms: [] },
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		expect(doc.moduleOrder).toHaveLength(2);
		const [firstUuid, secondUuid] = doc.moduleOrder;
		expect(doc.modules[firstUuid]?.name).toBe("First");
		expect(doc.modules[secondUuid]?.name).toBe("Second");
		// UUIDs must be unique
		expect(firstUuid).not.toBe(secondUuid);
	});

	it("generates UUIDs for forms and indexes formOrder by module UUID", () => {
		const bp: AppBlueprint = {
			app_name: "One Module Two Forms",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{ name: "Reg", type: "registration", questions: [] },
						{ name: "Follow", type: "followup", questions: [] },
					],
				},
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		const modUuid = doc.moduleOrder[0];
		expect(doc.formOrder[modUuid]).toHaveLength(2);
		expect(doc.forms[doc.formOrder[modUuid][0]]?.name).toBe("Reg");
		expect(doc.forms[doc.formOrder[modUuid][1]]?.name).toBe("Follow");
	});

	it("preserves question UUIDs from the blueprint (not regenerated)", () => {
		const qUuid = "q-uuid-preserved-0000-0000-000000000000";
		const bp: AppBlueprint = {
			app_name: "App",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{
							name: "F",
							type: "survey",
							questions: [
								{ uuid: qUuid, id: "name", type: "text", label: "Name" },
							],
						},
					],
				},
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		expect(doc.questionOrder[formUuid]).toEqual([qUuid]);
		expect(doc.questions[asUuid(qUuid)]?.id).toBe("name");
	});

	it("flattens nested group children into separate questionOrder entries", () => {
		const groupUuid = "g-0000-0000-0000-000000000000";
		const childUuid = "c-0000-0000-0000-000000000000";
		const bp: AppBlueprint = {
			app_name: "App",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{
							name: "F",
							type: "survey",
							questions: [
								{
									uuid: groupUuid,
									id: "grp",
									type: "group",
									label: "Grp",
									children: [
										{
											uuid: childUuid,
											id: "inner",
											type: "text",
											label: "Inner",
										},
									],
								},
							],
						},
					],
				},
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		// Top-level order contains the group uuid
		expect(doc.questionOrder[formUuid]).toEqual([groupUuid]);
		// Group has its own entry in questionOrder, keyed by its own uuid
		expect(doc.questionOrder[asUuid(groupUuid)]).toEqual([childUuid]);
		// The child is a peer entry in the flat questions map
		expect(doc.questions[asUuid(childUuid)]?.id).toBe("inner");
		// QuestionEntity has no `children` field
		expect(
			(doc.questions[asUuid(groupUuid)] as { children?: unknown }).children,
		).toBeUndefined();
	});

	it("throws when a question is missing its uuid", () => {
		const bp: AppBlueprint = {
			app_name: "App",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{
							name: "F",
							type: "survey",
							// Cast to bypass the type-level uuid requirement — we want to
							// exercise the runtime guard.
							questions: [{ id: "bare", type: "text" } as never],
						},
					],
				},
			],
			case_types: null,
		};
		expect(() => toDoc(bp, APP_ID)).toThrow(/uuid/i);
	});
});

describe("toBlueprint", () => {
	it("reconstructs an empty doc", () => {
		const doc = toDoc(
			{
				app_name: "Empty",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			APP_ID,
		);
		expect(toBlueprint(doc)).toEqual({
			app_name: "Empty",
			connect_type: undefined,
			modules: [],
			case_types: null,
		});
	});

	it("round-trips modules + forms + nested questions", () => {
		const bp: AppBlueprint = {
			app_name: "Round Trip",
			connect_type: "deliver",
			modules: [
				{
					name: "Reg Mod",
					case_type: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							questions: [
								{
									uuid: "q1-uuid-0000-0000-000000000000",
									id: "name",
									type: "text",
									label: "Name",
								},
								{
									uuid: "g1-uuid-0000-0000-000000000000",
									id: "contact",
									type: "group",
									label: "Contact",
									children: [
										{
											uuid: "c1-uuid-0000-0000-000000000000",
											id: "phone",
											type: "text",
											label: "Phone",
										},
									],
								},
							],
						},
					],
				},
			],
			case_types: [
				{ name: "patient", properties: [{ name: "name", label: "Name" }] },
			],
		};
		const roundTripped = toBlueprint(toDoc(bp, APP_ID));
		expect(roundTripped).toEqual(bp);
	});

	it("emits undefined (not null) for missing connect_type", () => {
		const doc = toDoc(
			{
				app_name: "NoConnect",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			APP_ID,
		);
		expect(toBlueprint(doc).connect_type).toBeUndefined();
	});

	it("preserves case_types through round-trip", () => {
		const bp: AppBlueprint = {
			app_name: "With Cases",
			connect_type: undefined,
			modules: [],
			case_types: [
				{
					name: "patient",
					properties: [
						{ name: "name", label: "Name" },
						{ name: "age", label: "Age" },
					],
				},
				{ name: "visit", properties: [{ name: "date", label: "Date" }] },
			],
		};
		expect(toBlueprint(toDoc(bp, APP_ID)).case_types).toEqual(bp.case_types);
	});

	it("uses moduleOrder/formOrder/questionOrder to determine output order", () => {
		const modA = "modA-0000-0000-0000-000000000000";
		const modB = "modB-0000-0000-0000-000000000000";
		const modAUuid = asUuid(modA);
		const modBUuid = asUuid(modB);
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Out Of Order",
			connectType: null,
			caseTypes: null,
			modules: {
				[modAUuid]: { uuid: modAUuid, name: "A" } as ModuleEntity,
				[modBUuid]: { uuid: modBUuid, name: "B" } as ModuleEntity,
			},
			forms: {},
			questions: {},
			// Intentionally reverse order
			moduleOrder: [modBUuid, modAUuid],
			formOrder: {},
			questionOrder: {},
		};
		const bp = toBlueprint(doc);
		expect(bp.modules.map((m) => m.name)).toEqual(["B", "A"]);
	});
});
