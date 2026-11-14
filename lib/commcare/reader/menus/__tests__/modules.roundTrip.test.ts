/**
 * Menus read back from Nova's own emission: order, one-tier nesting, kinds,
 * names in two languages, the case list menu item with and without its own
 * label, forms in the menu above, and a parent selection; and the case list
 * menu item's label as CommCare HQ's build writes it.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { caseListLabelAsBuilt } from "../modules";
import { codesOf, formNamed, moduleNamed, readMenusOf } from "./menuReading";

const register = {
	name: "Register",
	type: "registration" as const,
	fields: [
		f({
			kind: "text",
			id: "name",
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
	],
};
const visit = {
	name: "Visit",
	type: "followup" as const,
	fields: [
		f({
			kind: "text",
			id: "notes",
			caseWrite: { caseType: "patient", property: "notes" },
		}),
	],
};

function app(): BlueprintDoc {
	return buildDoc({
		modules: [
			{ name: "Patients", caseType: "patient", forms: [register, visit] },
			{
				name: "Follow up",
				caseType: "patient",
				caseListMenuItem: {},
				forms: [{ ...visit, name: "Check in" }],
			},
			{
				name: "Survey",
				forms: [
					{
						name: "Feedback",
						type: "survey",
						fields: [f({ kind: "text", id: "q" })],
					},
				],
			},
		],
	});
}

/** `doc` with the second menu a child of the first. */
function nested(doc: BlueprintDoc): BlueprintDoc {
	const [parent, child] = doc.moduleOrder;
	return produce(doc, (draft) => {
		const module = draft.modules[child as string];
		if (module !== undefined) module.parentModuleUuid = parent;
	});
}

describe("a menu read back from Nova's emission", () => {
	it("keeps HQ's order, names, case types and the case list menu item", async () => {
		const reading = await readMenusOf(app());
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		expect(doc.moduleOrder.map((uuid) => doc.modules[uuid]?.name)).toEqual([
			"Patients",
			"Follow up",
			"Survey",
		]);
		expect(moduleNamed(doc, "Patients").caseType).toBe("patient");
		expect(moduleNamed(doc, "Survey").caseType).toBeUndefined();
		// An absent label is the menu's name, which HQ's build writes as stored.
		expect(moduleNamed(doc, "Follow up").caseListMenuItem).toEqual({});
		expect(moduleNamed(doc, "Patients").caseListMenuItem).toBeUndefined();
	});

	it("keeps a child menu under its parent, one tier deep", async () => {
		const reading = await readMenusOf(nested(app()));
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		expect(moduleNamed(doc, "Follow up").parentModuleUuid).toBe(
			moduleNamed(doc, "Patients").uuid,
		);
	});

	it("refuses an order that separates a child from its parent", async () => {
		const reading = await readMenusOf(nested(app()), (json) => {
			const [first, second, third] = json.modules;
			json.modules = [first, third, second] as typeof json.modules;
		});
		expect(codesOf(reading)).toContain(
			"menus-and-case-lists/menu-order-that-separates-a-child-from-its-parent",
		);
	});

	it("keeps a case list menu item's own label", async () => {
		const doc = produce(app(), (draft) => {
			const module = Object.values(draft.modules).find(
				(one) => one.name === "Follow up",
			);
			if (module !== undefined)
				module.caseListMenuItem = { label: "All patients" };
		});
		const reading = await readMenusOf(doc);
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Follow up").caseListMenuItem,
		).toEqual({
			label: "All patients",
		});
	});

	it("keeps forms shown in the menu above", async () => {
		const doc = produce(app(), (draft) => {
			const module = Object.values(draft.modules).find(
				(one) => one.name === "Survey",
			);
			if (module !== undefined) module.formsInMenuAbove = true;
		});
		const reading = await readMenusOf(doc);
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Survey").formsInMenuAbove,
		).toBe(true);
	});

	it("reads a case list label blank in every language as HQ's words, and records the respelling", async () => {
		const reading = await readMenusOf(app(), (json) => {
			const list = json.modules[1]?.case_list as Record<string, unknown>;
			list.label = { en: "" };
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Follow up").caseListMenuItem,
		).toEqual({
			label: "Case List",
		});
		const outcome = reading.outcome;
		expect(
			outcome.kind === "read" && outcome.draft.facts.sameStateRewrites,
		).toContainEqual(
			expect.objectContaining({ register: "list-settings-respelled" }),
		);
	});

	it("reads a parent selection HQ stores", async () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "member", parent_type: "household", properties: [] },
			],
			modules: [
				{
					name: "Households",
					caseType: "household",
					forms: [
						{
							...register,
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "household", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					name: "Members",
					caseType: "member",
					forms: [
						{
							...visit,
							fields: [
								f({
									kind: "text",
									id: "notes",
									caseWrite: { caseType: "member", property: "notes" },
								}),
							],
						},
					],
				},
			],
		});
		const withSelection = produce(doc, (draft) => {
			const [households, members] = draft.moduleOrder;
			const module = draft.modules[members as string];
			if (module !== undefined) module.parentCaseModuleUuid = households;
		});
		const reading = await readMenusOf(withSelection);
		expect(codesOf(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		expect(moduleNamed(read, "Members").parentCaseModuleUuid).toBe(
			moduleNamed(read, "Households").uuid,
		);
		expect(formNamed(read, "Visit").type).toBe("followup");
	});
});

describe("caseListLabelAsBuilt", () => {
	it("writes HQ's words where a language is blank and the other's own text elsewhere", () => {
		expect(caseListLabelAsBuilt({ en: "", fr: "Liste" }, ["en", "fr"])).toEqual(
			{
				en: "Case List",
				fr: "Liste",
			},
		);
	});

	it("writes a label held only under a language the app does not name in every language", () => {
		expect(caseListLabelAsBuilt({ es: "Lista" }, ["en", "fr"])).toEqual({
			en: "Lista",
			fr: "Lista",
		});
	});

	it("writes a lone null as None, and an empty map as Case List", () => {
		expect(caseListLabelAsBuilt({ es: null }, ["en"])).toEqual({ en: "None" });
		expect(caseListLabelAsBuilt({}, ["en"])).toEqual({ en: "Case List" });
	});
});
