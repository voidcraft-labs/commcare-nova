/**
 * Menus read back from Nova's own emission: order, one-tier nesting, kinds,
 * names in two languages, the case list menu item with and without its own
 * label, forms in the menu above, and a parent selection (in the drafts
 * before case management reads, and taken out where the gate refuses it);
 * the shapes CommCare HQ stores that Nova refuses (a nesting cycle, a child
 * menu's registration of its root's case type); and the case list menu
 * item's label as CommCare HQ's build writes it.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	calculatedColumn,
	caseListWordingUnitId,
	linkColumn,
	makeTranslationUnitId,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { advancedFixture } from "../../../__tests__/advancedPlacementFixture";
import { caseListLabelAsBuilt } from "../modules";
import {
	codesOf,
	formNamed,
	inSpanish,
	type JsonObject,
	moduleNamed,
	readMenusOf,
	stagesOver,
} from "./menuReading";

const M = "menus-and-case-lists";

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

/** The two menus of `app` that hold a case type. */
function caseMenus(): BlueprintDoc {
	return buildDoc({
		modules: [
			{ name: "Patients", caseType: "patient", forms: [register, visit] },
			{
				name: "Follow up",
				caseType: "patient",
				caseListMenuItem: {},
				forms: [{ ...visit, name: "Check in" }],
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

	it("reads a menu and a form off the menu, with and without a condition for when they are back", async () => {
		const back = {
			kind: "eq",
			left: { kind: "term", term: { kind: "session-user", field: "role" } },
			right: { kind: "term", term: { kind: "literal", value: "lead" } },
		} as const;
		const doc = produce(app(), (draft) => {
			const survey = Object.values(draft.modules).find(
				(one) => one.name === "Survey",
			);
			if (survey !== undefined) survey.hiddenFromMenu = true;
			const visitForm = Object.values(draft.forms).find(
				(one) => one.name === "Visit",
			);
			if (visitForm !== undefined) visitForm.hiddenFromMenu = true;
			const checkIn = Object.values(draft.forms).find(
				(one) => one.name === "Check in",
			);
			if (checkIn !== undefined) {
				checkIn.hiddenFromMenu = true;
				checkIn.displayCondition = back;
			}
		});
		const reading = await readMenusOf(doc);
		expect(codesOf(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		const survey = moduleNamed(read, "Survey");
		expect(survey.hiddenFromMenu).toBe(true);
		expect(survey.displayCondition).toBeUndefined();
		const visitForm = formNamed(read, "Visit");
		expect(visitForm.hiddenFromMenu).toBe(true);
		expect(visitForm.displayCondition).toBeUndefined();
		const checkIn = formNamed(read, "Check in");
		expect(checkIn.hiddenFromMenu).toBe(true);
		// The worker's field reads as the worker property the reading declares for it.
		expect(checkIn.displayCondition).toMatchObject({
			kind: "eq",
			right: back.right,
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

describe("a menu's kind", () => {
	it("reads an advanced menu back advanced, its kind held", async () => {
		const { doc, moduleUuid } = advancedFixture({ formType: "followup" });
		const reading = await readMenusOf(doc);
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(
				reading.doc as BlueprintDoc,
				doc.modules[moduleUuid]?.name ?? "",
			).heldKind,
		).toBe("advanced");
	});
});

describe("names in two languages", () => {
	it("reads a menu's name in the first language, and its translation in the second", async () => {
		const doc = caseMenus();
		const patients = moduleNamed(doc, "Patients").uuid;
		const reading = await readMenusOf(
			inSpanish(
				doc,
				new Map([
					[makeTranslationUnitId("module", patients, "name"), "Pacientes"],
				]),
			),
		);
		expect(codesOf(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		const module = moduleNamed(read, "Patients");
		expect(
			read.localization?.translations.spa?.[
				makeTranslationUnitId("module", module.uuid, "name")
			]?.value,
		).toBe("Pacientes");
	});

	it("reads a case list label blank in one language as HQ's words there and the other's own text", async () => {
		const reading = await readMenusOf(
			inSpanish(caseMenus(), new Map()),
			(json) => {
				const list = json.modules[1]?.case_list as JsonObject;
				list.label = { en: "", es: "Lista" };
			},
		);
		expect(codesOf(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		const module = moduleNamed(read, "Follow up");
		expect(module.caseListMenuItem).toEqual({ label: "Case List" });
		expect(
			read.localization?.translations.spa?.[
				makeTranslationUnitId(
					"module",
					module.uuid,
					"case-list-menu-item-label",
				)
			]?.value,
		).toBe("Lista");
	});

	it("reads a menu with no case type back, its list texts in both languages HQ's own", async () => {
		const reading = await readMenusOf(inSpanish(app(), new Map()));
		expect(codesOf(reading)).toEqual([]);
		const survey = reading.app.modules[2]?.case_details as JsonObject;
		// Nova writes HQ's default words in every language, a menu with no case type included.
		expect((survey.short as JsonObject).no_items_text).toEqual({
			en: "List is empty.",
			es: "List is empty.",
		});
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Survey").caseType,
		).toBeUndefined();
	});

	it("reads past a menu with no case type whose empty list says other words, which no worker reads", async () => {
		const reading = await readMenusOf(inSpanish(app(), new Map()), (json) => {
			const details = json.modules[2]?.case_details as JsonObject;
			(details.short as JsonObject).no_items_text = {
				en: "List is empty.",
				es: "La lista está vacía.",
			};
		});
		expect(codesOf(reading)).toEqual([]);
		const survey = moduleNamed(reading.doc as BlueprintDoc, "Survey");
		expect(survey.caseListConfig).toBeUndefined();
	});
});

describe("a case list's own words", () => {
	/** `caseMenus` with the Patients list's own words, each with its Spanish. */
	const worded = (): BlueprintDoc => {
		const doc = produce(caseMenus(), (draft) => {
			const patients = Object.values(draft.modules).find(
				(one) => one.name === "Patients",
			);
			if (patients === undefined)
				throw new Error("The fixture holds no Patients menu.");
			patients.caseListConfig = {
				...caseListConfig([{ field: "case_name", header: "Name" }]),
				emptyText: "No patients yet",
				selectButtonText: "Visit these patients",
			};
		});
		const uuid = moduleNamed(doc, "Patients").uuid;
		return inSpanish(
			doc,
			new Map([
				[caseListWordingUnitId(uuid, "empty"), "Aún no hay pacientes"],
				[caseListWordingUnitId(uuid, "select"), "Visitar a estos pacientes"],
			]),
		);
	};

	it("writes each language's words and reads them back as the list's own", async () => {
		const reading = await readMenusOf(worded());
		expect(codesOf(reading)).toEqual([]);
		const details = reading.app.modules[0]?.case_details as JsonObject;
		const short = details.short as JsonObject;
		expect(short.no_items_text).toEqual({
			en: "No patients yet",
			es: "Aún no hay pacientes",
		});
		expect(short.select_text).toEqual({
			en: "Visit these patients",
			es: "Visitar a estos pacientes",
		});
		const read = reading.doc as BlueprintDoc;
		const patients = moduleNamed(read, "Patients");
		expect(patients.caseListConfig?.emptyText).toBe("No patients yet");
		expect(patients.caseListConfig?.selectButtonText).toBe(
			"Visit these patients",
		);
		const spanish = read.localization?.translations.spa;
		expect(
			spanish?.[caseListWordingUnitId(patients.uuid, "empty")]?.value,
		).toBe("Aún no hay pacientes");
		expect(
			spanish?.[caseListWordingUnitId(patients.uuid, "select")]?.value,
		).toBe("Visitar a estos pacientes");
	});

	it("reads words HQ's Case List page saved for one language, the other showing HQ's default", async () => {
		const reading = await readMenusOf(
			inSpanish(caseMenus(), new Map()),
			(json) => {
				const details = json.modules[0]?.case_details as JsonObject;
				(details.short as JsonObject).no_items_text = {
					en: "List is empty.",
					es: "La lista está vacía.",
				};
			},
		);
		expect(codesOf(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		const patients = moduleNamed(read, "Patients");
		// The source keeps HQ's default; Spanish holds its own words.
		expect(patients.caseListConfig?.emptyText).toBe("List is empty.");
		expect(
			read.localization?.translations.spa?.[
				caseListWordingUnitId(patients.uuid, "empty")
			]?.value,
		).toBe("La lista está vacía.");
	});

	it("reads past a case detail's own words, which HQ's build never writes", async () => {
		const reading = await readMenusOf(
			inSpanish(caseMenus(), new Map()),
			(json) => {
				const details = json.modules[0]?.case_details as JsonObject;
				(details.long as JsonObject).select_text = { en: "Go on" };
			},
		);
		expect(codesOf(reading)).toEqual([]);
		const patients = moduleNamed(reading.doc as BlueprintDoc, "Patients");
		expect(patients.caseListConfig?.selectButtonText).toBeUndefined();
	});
});

describe("a parent selection, written early and judged late", () => {
	const households = () =>
		buildDoc({
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "member", parent_type: "household", properties: [] },
				{ name: "visit", properties: [] },
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
								f({
									kind: "text",
									id: "member_name",
									caseWrite: { caseType: "member", property: "case_name" },
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
				{
					name: "Visits",
					caseType: "visit",
					forms: [
						{
							...visit,
							name: "Log visit",
							fields: [
								f({
									kind: "text",
									id: "notes",
									caseWrite: { caseType: "visit", property: "notes" },
								}),
							],
						},
					],
				},
			],
		});
	const selecting = (doc: BlueprintDoc) =>
		produce(doc, (draft) => {
			const [householdMenu, members] = draft.moduleOrder;
			const module = draft.modules[members as string];
			if (module !== undefined) module.parentCaseModuleUuid = householdMenu;
		});

	it("is in the drafts before case management reads", async () => {
		// readApplication, readStructure, readForms, readMenus.
		const ctx = await stagesOver(selecting(households()), () => {}, 4);
		const members = ctx.draft.modules.find(
			(one) => one.module.name === "Members",
		);
		const named = ctx.draft.modules.find(
			(one) => one.module.name === "Households",
		);
		expect(members?.module.parentCaseModuleUuid).toBe(named?.uuid);
	});

	it("keeps the chosen menu when it lists a different type from the catalog parent", async () => {
		const ctx = await stagesOver(selecting(households()), (json) => {
			const visits = json.modules[2] as JsonObject;
			(json.modules[1]?.parent_select as JsonObject).module_id =
				visits.unique_id;
		});
		const members = ctx.draft.modules.find(
			(one) => one.module.name === "Members",
		);
		const visits = ctx.draft.modules.find(
			(one) => one.module.name === "Visits",
		);
		expect(visits).toBeDefined();
		expect(ctx.close().findings.map((finding) => finding.code)).not.toContain(
			`${M}/parent-select-naming-a-module-outside-the-declared-parent-type`,
		);
		expect(
			ctx.doc?.modules[members?.uuid as string]?.parentCaseModuleUuid,
		).toBe(visits?.uuid);
	});
});

describe("a child menu of another case type under a root with no forms", () => {
	it("reads the child form's case read through the datum HQ's build keeps, `case_id`", async () => {
		const doc = nested(
			buildDoc({
				caseTypes: [
					{
						name: "household",
						properties: [{ name: "village", label: proseText("Village") }],
					},
					{
						name: "member",
						parent_type: "household",
						properties: [{ name: "care_status", label: proseText("Status") }],
					},
				],
				modules: [
					{
						name: "Households",
						caseType: "household",
						caseListMenuItem: {},
						forms: [],
					},
					{
						name: "Members",
						caseType: "member",
						forms: [
							{
								name: "Member visit",
								type: "followup",
								fields: [
									f({
										kind: "hidden",
										id: "copied_status",
										calculate: "#member/care_status",
									}),
								],
							},
						],
					},
				],
			}),
		);
		// HQ's build leaves the child's datum `case_id` where the root has no
		// form (`entries.py::add_parent_datums`), so a form made in HQ reads
		// that id. Stored as HQ holds it, the read keeps the case read.
		const reading = await readMenusOf(doc, (json) => {
			const attachments = json._attachments as Record<string, unknown>;
			for (const [key, value] of Object.entries(attachments)) {
				if (typeof value === "string")
					attachments[key] = value.replaceAll(
						"session/data/case_id_member",
						"session/data/case_id",
					);
			}
		});
		expect(codesOf(reading)).toEqual([]);
		const read = reading.doc as BlueprintDoc;
		expect(moduleNamed(read, "Members").parentModuleUuid).toBe(
			moduleNamed(read, "Households").uuid,
		);
		const visitForm = formNamed(read, "Member visit");
		const field = read.fieldOrder[visitForm.uuid]
			?.map((uuid) => read.fields[uuid])
			.find((one) => one?.id === "copied_status");
		expect(JSON.stringify(field)).toContain('"care_status"');
	});
});

describe("shapes CommCare HQ stores that Nova refuses", () => {
	it("refuses a two-menu nesting cycle as a cycle, never as a grandchild", async () => {
		const reading = await readMenusOf(nested(app()), (json) => {
			const [parent, child] = json.modules;
			(parent as JsonObject).root_module_id = (child as JsonObject).unique_id;
		});
		const codes = codesOf(reading);
		expect(codes).toContain(
			`${M}/root-module-id-naming-a-missing-module-or-a-cycle`,
		);
		expect(codes).not.toContain(
			`${M}/child-menu-deeper-than-one-tier-grandchild`,
		);
	});

	it("refuses a child menu's registration of the case type its root's first form chooses", async () => {
		const doc = buildDoc({
			modules: [
				{ name: "Patients", caseType: "patient", forms: [visit, register] },
				{
					name: "More",
					caseType: "patient",
					forms: [{ ...register, name: "Register again" }],
				},
			],
		});
		const reading = await readMenusOf(nested(doc));
		expect(codesOf(reading)).toContain(
			`${M}/child-menu-form-creating-a-case-of-the-type-its-root-s-first-form-chooses`,
		);
		expect(
			reading.findings.find((finding) =>
				finding.code.endsWith("its-root-s-first-form-chooses"),
			)?.place,
		).toMatchObject({ kind: "form" });
	});
});

describe("a form's display condition that reads its case", () => {
	/** One menu holding `forms`, shown in the first menu where `above`, and
	 *  the follow-up's stored condition reading its case. */
	async function readingWith(
		forms: (typeof visit | typeof register)[],
		above: boolean,
	) {
		const doc = produce(
			buildDoc({
				modules: [{ name: "Patients", caseType: "patient", forms }],
			}),
			(draft) => {
				const module = Object.values(draft.modules)[0];
				if (module !== undefined && above) module.formsInMenuAbove = true;
			},
		);
		return readMenusOf(doc, (json) => {
			const followUp = json.modules[0]?.forms.find(
				(form) => (form.name as JsonObject).en === "Visit",
			);
			if (followUp !== undefined) followUp.form_filter = "#case/notes = 'x'";
		});
	}

	it("refuses it on the first menu, which lists a registration beside the follow-up, under HQ's own build error", async () => {
		// Not every form of the menu requires a case, so HQ's build refuses the
		// condition (`suite_xml/sections/menus.py`, `CaseXPathValidationError`):
		// the form's own entry, never the screen's wider one beside it.
		const reading = await readingWith([register, visit], true);
		expect(codesOf(reading)).toEqual([
			"forms-and-case-writes/form-filter-referencing-the-case-database-other-than-through",
		]);
		expect(reading.findings[0]?.place).toMatchObject({ kind: "form" });
	});

	it("reads it on a menu's own screen, where every form opens a chosen case", async () => {
		const reading = await readingWith([visit], false);
		expect(codesOf(reading)).toEqual([]);
		expect(
			formNamed(reading.doc as BlueprintDoc, "Visit").displayCondition,
		).toBeDefined();
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

describe("faster loading", () => {
	const SECOND = asUuid("00000000-0000-4000-8000-0000000c5b01");
	/** `caseMenus` with Patients' faster loading on and a second column, a calculation unless
	 *  `link` says a link, holding `behavior`. */
	const optimized = (
		behavior: "cache" | "defer" | "cache-and-defer",
		link = false,
	) =>
		produce(caseMenus(), (draft) => {
			const patients = Object.values(draft.modules).find(
				(one) => one.name === "Patients",
			);
			if (patients === undefined)
				throw new Error("The fixture holds no Patients menu.");
			const base = caseListConfig([{ field: "case_name", header: "Name" }]);
			const visits = {
				...(link
					? linkColumn(SECOND, "case_name", "Record", "Open")
					: calculatedColumn(
							SECOND,
							"Visits",
							term(prop("patient", "case_name")),
						)),
				loadBehavior: behavior,
			};
			patients.caseListConfig = {
				...base,
				columns: [...base.columns, visits],
				listColumnOrder: [...base.listColumnOrder, visits.uuid],
				detailColumnOrder: [...base.detailColumnOrder, visits.uuid],
				optimizations: true,
			};
		});

	it.each([
		["cache", "cache"],
		["defer", "lazy_load"],
		["cache-and-defer", "cache_and_lazy_load"],
	] as const)(
		"writes %s as HQ's %s and reads it back",
		async (behavior, hq) => {
			const reading = await readMenusOf(optimized(behavior));
			expect(codesOf(reading)).toEqual([]);
			const module = reading.app.modules[0] as JsonObject;
			expect(module.show_case_list_optimization_options).toBe(true);
			const details = module.case_details as JsonObject;
			const short = details.short as JsonObject;
			expect(
				(short.columns as JsonObject[]).map((one) => one.optimization),
			).toEqual([undefined, hq]);
			const list = moduleNamed(
				reading.doc as BlueprintDoc,
				"Patients",
			).caseListConfig;
			expect(list?.optimizations).toBe(true);
			expect(
				list?.columns.map((one) =>
					"loadBehavior" in one ? one.loadBehavior : undefined,
				),
			).toEqual([undefined, behavior]);
		},
	);

	it.each(["cache", "defer", "cache-and-defer"] as const)(
		"reads a link's %s back as the link's own",
		async (behavior) => {
			const reading = await readMenusOf(optimized(behavior, true));
			expect(codesOf(reading)).toEqual([]);
			const column = moduleNamed(
				reading.doc as BlueprintDoc,
				"Patients",
			).caseListConfig?.columns.find((one) => one.header === "Record");
			expect(column?.kind).toBe("link");
			expect(
				column !== undefined && "loadBehavior" in column
					? column.loadBehavior
					: undefined,
			).toBe(behavior);
		},
	);

	it("reads an attribute column HQ keeps a choice on as the calculation that holds it", async () => {
		// HQ's Case List page can store an expression column over `@case_id` with a load behavior,
		// which its build writes; Nova's plain column holds none, so the reading is a calculation.
		const reading = await readMenusOf(optimized("cache"), (json) => {
			const module = json.modules[0] as JsonObject;
			const details = module.case_details as JsonObject;
			for (const screen of ["short", "long"] as const) {
				const second = (
					(details[screen] as JsonObject).columns as JsonObject[]
				)[1];
				if (second === undefined) continue;
				second.field = "@case_id";
				second.format = "plain";
				second.useXpathExpression = true;
			}
		});
		expect(codesOf(reading)).toEqual([]);
		const column = moduleNamed(
			reading.doc as BlueprintDoc,
			"Patients",
		).caseListConfig?.columns.find((one) => one.header === "Visits");
		expect(column?.kind).toBe("calculated");
		expect(
			column !== undefined && "loadBehavior" in column
				? column.loadBehavior
				: undefined,
		).toBe("cache");
	});

	it("reads past a column's choice where the menu's faster loading is off, which HQ's build never writes", async () => {
		const reading = await readMenusOf(optimized("cache"), (json) => {
			const module = json.modules[0] as JsonObject;
			module.show_case_list_optimization_options = false;
		});
		expect(codesOf(reading)).toEqual([]);
		const list = moduleNamed(
			reading.doc as BlueprintDoc,
			"Patients",
		).caseListConfig;
		expect(list?.optimizations).toBeUndefined();
		expect(list?.columns.some((one) => "loadBehavior" in one)).toBe(false);
	});
});
