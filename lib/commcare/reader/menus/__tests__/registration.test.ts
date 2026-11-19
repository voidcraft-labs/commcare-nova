/**
 * Registration from the case list, read back from Nova's emission and from
 * the shapes CommCare HQ's pages store: the hidden menu folded into its host
 * with its form last, every failing test of that shape left an ordinary
 * menu, a stored registration block read by the first rule that matches it
 * (the earlier of two rows that hold taking it), each refusal at the host's
 * case list, and the label as HQ's build writes it.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, makeTranslationUnitId } from "@/lib/domain";
import type { ReadContext } from "../../context";
import { registrationFormLast } from "../registration";
import {
	type AppJson,
	codesOf,
	inSpanish,
	type JsonObject,
	moduleNamed,
	readMenusOf,
	stagesOver,
} from "./menuReading";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

/** The stages through the menus reading: application, structure, forms, menus. */
const THROUGH_MENUS = 4;

/** The draft menu of `name` in a reading's context. */
function draftMenu(ctx: ReadContext, name: string) {
	const menu = ctx.draft.modules.find((one) => one.module.name === name);
	if (menu === undefined) throw new Error(`The reading holds no menu ${name}.`);
	return menu;
}

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
const register = {
	uuid: "reg",
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

/** A host whose forms read the search, offering its registration after an empty search. */
function afterEmptySearch(
	label?: string,
	order: "visit-first" | "register-first" = "visit-first",
): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				// A list, so the search its forms read is one CommCare HQ runs: the emission
				// writes its zero-input row, and HQ offers a search with a row.
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: {
					formUuid: "reg",
					...(label === undefined ? {} : { label }),
				},
				forms: order === "visit-first" ? [visit, register] : [register, visit],
			},
		],
	});
}

/** A list that always offers the registration of another menu. */
function always(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{ name: "Registration", caseType: "patient", forms: [register] },
			{ name: "Patients", caseType: "patient", forms: [visit] },
		],
	});
	return produce(doc, (draft) => {
		const host = Object.values(draft.modules).find(
			(one) => one.name === "Patients",
		);
		if (host !== undefined)
			host.caseListRegistrationForm = {
				kind: "always",
				formUuid: testUuid("reg"),
				afterSubmit: "case-list",
			};
	});
}

function hiddenMenu(app: AppJson): JsonObject {
	return app.modules[1] as JsonObject;
}

function block(app: AppJson, menu = 0): JsonObject {
	return app.modules[menu]?.case_list_form as JsonObject;
}

function rewrites(reading: Awaited<ReturnType<typeof readMenusOf>>): string[] {
	return reading.outcome.kind === "read"
		? reading.outcome.draft.facts.sameStateRewrites.map((one) => one.register)
		: [];
}

describe("the hidden registration menu", () => {
	it("folds into its host, the form last among the host's forms", async () => {
		const reading = await readMenusOf(afterEmptySearch());
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		expect(doc.moduleOrder).toHaveLength(1);
		const host = moduleNamed(doc, "Patients");
		expect(host.caseListRegistrationForm).toEqual({
			kind: "after-empty-search",
			formUuid: expect.any(String),
		});
		const forms = doc.formOrder[host.uuid] ?? [];
		expect(doc.forms[forms[forms.length - 1] as string]?.name).toBe("Register");
		const identities =
			reading.outcome.kind === "read"
				? reading.outcome.draft.identities.modules
				: [];
		expect(identities).toHaveLength(2);
	});

	it("folds a hidden menu holding the keys Nova's shell leaves out as a read of CommCare HQ serves them", async () => {
		// HQ serves every declared property, and a detail pair it wrapped names its
		// details' `display` (`models/modules.py::DetailPair.wrap`), never the `null`
		// the class declares.
		const reading = await readMenusOf(afterEmptySearch(), (app) => {
			hiddenMenu(app).ref_details = {
				doc_type: "DetailPair",
				short: { doc_type: "Detail", display: "short", columns: [] },
				long: { doc_type: "Detail", display: "long", columns: [] },
			};
		});
		expect(codesOf(reading)).toEqual([]);
		const host = moduleNamed(reading.doc as BlueprintDoc, "Patients");
		expect(host.caseListRegistrationForm?.kind).toBe("after-empty-search");
	});

	it("rejoins its host last, from wherever the form stood (registration-form-last)", async () => {
		const reading = await readMenusOf(
			afterEmptySearch(undefined, "register-first"),
		);
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		const host = moduleNamed(doc, "Patients");
		const forms = doc.formOrder[host.uuid] ?? [];
		expect(forms.map((uuid) => doc.forms[uuid]?.name)).toEqual([
			"Visit",
			"Register",
		]);
	});

	it.each([
		[
			"a filter other than false()",
			(app: AppJson) => {
				hiddenMenu(app).module_filter = "1 = 2";
			},
		],
		[
			"media on the block",
			(app: AppJson) => {
				block(app).media_image = {
					en: "jr://file/commcare/image/register.png",
				};
			},
		],
		[
			"a relevancy other than the search finding nothing",
			(app: AppJson) => {
				block(app).relevancy_expression = "true()";
			},
		],
		[
			"a comment on the hidden menu",
			(app: AppJson) => {
				hiddenMenu(app).comment = "Opened from the list";
			},
		],
		[
			"details other than the default",
			(app: AppJson) => {
				const details = hiddenMenu(app).case_details as JsonObject;
				(details.short as JsonObject).columns = [];
			},
		],
		[
			"reference details other than the default",
			(app: AppJson) => {
				hiddenMenu(app).ref_details = {
					doc_type: "DetailPair",
					short: {
						doc_type: "Detail",
						display: "short",
						columns: [{ doc_type: "DetailColumn", field: "name" }],
					},
					long: { doc_type: "Detail", display: "long", columns: [] },
				};
			},
		],
		[
			"a second form",
			(app: AppJson) => {
				const host = app.modules[0] as AppJson["modules"][number];
				const [second] = host.forms;
				host.forms = [];
				(hiddenMenu(app).forms as JsonObject[]).push(second as JsonObject);
			},
		],
		[
			"a host whose forms do not read the search",
			(app: AppJson) => {
				(app.modules[0]?.search_config as JsonObject).auto_launch = false;
			},
		],
	])(
		"leaves an ordinary menu off the menu, the block read by row 5, where it has %s",
		async (_, edit) => {
			const ctx = await stagesOver(afterEmptySearch(), edit, THROUGH_MENUS);
			expect(ctx.draft.foldedMenus).toEqual([]);
			expect(
				draftMenu(ctx, "Patients").module.caseListRegistrationForm?.kind,
			).toBe("always");
			const codes = ctx.close().findings.map((finding) => finding.code);
			expect(codes).not.toContain(
				`${M}/case-list-form-on-a-search-first-host-pointing-at-a-registration`,
			);
			// The always arm writes no relevancy, so the block's own is the HELD-NEW row.
			expect(codes).toContain(
				`${M}/case-list-form-relevancy-expression-with-followup-forms-as-case`,
			);
		},
	);

	it("is the HELD-NEW row with `post_form_workflow: default`", async () => {
		const reading = await readMenusOf(afterEmptySearch(), (app) => {
			block(app).post_form_workflow = "default";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`,
		);
	});
});

describe("a stored registration block, read by the first rule that matches", () => {
	it("reads a blank form id beside a label as nothing", async () => {
		const reading = await readMenusOf(always(), (app) => {
			const one = block(app, 1);
			one.form_id = "";
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Patients")
				.caseListRegistrationForm,
		).toBeUndefined();
	});

	it("refuses a form id naming no form", async () => {
		const reading = await readMenusOf(always(), (app) => {
			block(app, 1).form_id = "not-a-form";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-missing-not-a-registration-form-toggle-off-or`,
		);
	});

	it("refuses a host some form of which needs no case", async () => {
		const reading = await readMenusOf(always(), (app) => {
			(app.modules[1]?.forms[0] as JsonObject).requires = "none";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case`,
		);
	});

	it("drops the block on a top-level menu that shows its forms above", async () => {
		const reading = await readMenusOf(always(), (app) => {
			(app.modules[1] as JsonObject).put_in_root = true;
		});
		expect(codesOf(reading)).not.toContain(
			`${M}/case-list-form-pointing-at-a-registration-form-in-another-module`,
		);
		expect(
			reading.doc === undefined
				? undefined
				: moduleNamed(reading.doc, "Patients").caseListRegistrationForm,
		).toBeUndefined();
	});

	it("refuses the block on a child menu that shows its forms above", async () => {
		const reading = await readMenusOf(always(), (app) => {
			const host = app.modules[1] as JsonObject;
			host.put_in_root = true;
			host.root_module_id = (app.modules[0] as JsonObject).unique_id;
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-on-a-child-put-in-root-module-whose-parent-s-case`,
		);
	});

	it("refuses the block on a menu above whose list is a tile", async () => {
		const reading = await readMenusOf(always(), (app) => {
			const host = app.modules[1] as JsonObject;
			host.put_in_root = true;
			const details = host.case_details as JsonObject;
			(details.short as JsonObject).case_tile_template = "icon_text_grid";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile`,
		);
	});

	it("refuses a form whose one registration of the type is a child case", async () => {
		const reading = await readMenusOf(always(), (app) => {
			const menu = app.modules[0] as JsonObject;
			menu.case_type = "household";
			const form = app.modules[0]?.forms[0] as JsonObject;
			const actions = form.actions as JsonObject;
			actions.subcases = [
				{
					...(Array.isArray(actions.subcases)
						? (actions.subcases[0] as JsonObject)
						: {}),
					doc_type: "OpenSubCaseAction",
					case_type: "patient",
					case_name: "/data/name",
					condition: { doc_type: "FormActionCondition", type: "always" },
					repeat_context: "",
				},
			];
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case`,
		);
	});

	it("refuses a follow-up form of the case type the host chooses a parent of", async () => {
		const reading = await readMenusOf(always(), (app) => {
			const named = app.modules[0];
			(named?.forms[0] as JsonObject).requires = "case";
			(app.modules[1] as JsonObject).parent_select = {
				active: true,
				relationship: "parent",
				module_id: named?.unique_id,
			};
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-pointing-at-a-follow-up-form-of-the-parent-case`,
		);
	});

	it("refuses going on with the new case from a list that chooses several", async () => {
		const reading = await readMenusOf(always(), (app) => {
			const host = app.modules[1] as JsonObject;
			const details = host.case_details as JsonObject;
			(details.short as JsonObject).multi_select = true;
			block(app, 1).post_form_workflow = "default";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-post-form-workflow-default-on-a-multi-select-host`,
		);
	});

	it.each([
		[
			"keeps HQ's six rules",
			"own",
			`${M}/case-list-form-on-an-advanced-module-or-naming-an-advanced-form`,
		],
		[
			"breaks HQ's six rules",
			"other",
			`${F}/advanced-forms-in-a-module-whose-case-list-offers-a-registration`,
		],
	] as const)(
		"refuses a block on an advanced host that %s by that row",
		async (_, details, code) => {
			const ctx = await stagesOver(
				always(),
				(app) => {
					const host = app.modules[1] as AppJson["modules"][number];
					host.doc_type = "AdvancedModule";
					const form = host.forms[0] as JsonObject;
					form.doc_type = "AdvancedForm";
					form.actions = {
						doc_type: "AdvancedFormActions",
						load_update_cases: [
							{
								doc_type: "LoadUpdateAction",
								case_type: "patient",
								case_tag: "load_patient_0",
								details_module:
									details === "own"
										? host.unique_id
										: app.modules[0]?.unique_id,
								auto_select: null,
								case_indices: [],
							},
						],
						open_cases: [],
					};
				},
				THROUGH_MENUS,
			);
			const codes = ctx.close().findings.map((finding) => finding.code);
			expect(codes).toContain(code);
			expect(codes).not.toContain(
				code.startsWith(F)
					? `${M}/case-list-form-on-an-advanced-module-or-naming-an-advanced-form`
					: `${F}/advanced-forms-in-a-module-whose-case-list-offers-a-registration`,
			);
		},
	);

	it("reads the always arm with its return", async () => {
		const reading = await readMenusOf(always());
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Patients")
				.caseListRegistrationForm,
		).toEqual({
			kind: "always",
			formUuid: expect.any(String),
			afterSubmit: "case-list",
		});
	});
});

/** The stored menu whose name is `name` in the first language. */
function menuNamed(app: AppJson, name: string): AppJson["modules"][number] {
	const menu = app.modules.find(
		(one) => (one.name as JsonObject | undefined)?.en === name,
	);
	if (menu === undefined) throw new Error(`The app holds no menu ${name}.`);
	return menu;
}

/** The stored menu that holds the form `name`. */
function menuHolding(app: AppJson, name: string): AppJson["modules"][number] {
	const menu = app.modules.find((one) =>
		one.forms.some(
			(form) => (form.name as JsonObject | undefined)?.en === name,
		),
	);
	if (menu === undefined) throw new Error(`The app holds no form ${name}.`);
	return menu;
}

describe("the rows a block meets after its own registration", () => {
	it("refuses a hidden menu of another case type as naming no registration of the host's type", async () => {
		const reading = await readMenusOf(afterEmptySearch(), (app) => {
			hiddenMenu(app).case_type = "household";
		});
		const codes = codesOf(reading);
		expect(codes).toContain(
			`${M}/case-list-form-missing-not-a-registration-form-toggle-off-or`,
		);
		expect(codes).not.toContain(
			`${M}/case-list-form-on-a-search-first-host-pointing-at-a-registration`,
		);
	});

	it("refuses a form another list offers after an empty search", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: { formsReadSearch: true },
					caseListRegistrationForm: { formUuid: "reg" },
					forms: [visit, register],
				},
				{
					name: "Others",
					caseType: "patient",
					forms: [{ ...visit, name: "Check in" }],
				},
			],
		});
		const reading = await readMenusOf(doc, (app) => {
			const offered = block(app);
			menuNamed(app, "Others").case_list_form = {
				...offered,
				relevancy_expression: "",
			};
		});
		const codes = codesOf(reading);
		expect(codes).toContain(
			`${M}/case-list-form-naming-a-form-another-list-offers-after-an-empty-search`,
		);
		expect(
			reading.findings.find((finding) =>
				finding.code.endsWith("offers-after-an-empty-search"),
			)?.place,
		).toEqual({
			kind: "case-list",
			menu: menuIndex(reading.app, "Others"),
			name: "Others",
		});
	});

	it("refuses a host under a menu that shares the first menu's case", async () => {
		const doc = produce(
			buildDoc({
				modules: [
					{ name: "Patients", caseType: "patient", forms: [visit] },
					{
						name: "Follow up",
						caseType: "patient",
						forms: [{ ...visit, name: "Check in" }],
					},
					{ name: "Registration", caseType: "patient", forms: [register] },
				],
			}),
			(draft) => {
				const [patients, followUp] = draft.moduleOrder;
				const above = draft.modules[patients as string];
				const host = draft.modules[followUp as string];
				if (above === undefined || host === undefined) return;
				above.formsInMenuAbove = true;
				host.parentModuleUuid = patients;
				// Going on with the new case returns through the first menu.
				host.caseListRegistrationForm = {
					kind: "always",
					formUuid: testUuid("reg"),
					afterSubmit: "new-case",
				};
			},
		);
		const reading = await readMenusOf(doc);
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case`,
		);
		expect(
			reading.findings.find((finding) =>
				finding.code.endsWith("shares-the-first-menu-s-case"),
			)?.place,
		).toMatchObject({ kind: "case-list", name: "Follow up" });
	});

	it("refuses a block naming a form whose menu is advanced, the host basic", async () => {
		const ctx = await stagesOver(
			always(),
			(app) => {
				const named = menuHolding(app, "Register");
				named.doc_type = "AdvancedModule";
				const form = named.forms[0] as JsonObject;
				form.doc_type = "AdvancedForm";
				form.actions = {
					doc_type: "AdvancedFormActions",
					load_update_cases: [],
					open_cases: [
						{
							doc_type: "AdvancedOpenCaseAction",
							case_type: "patient",
							case_tag: "open_patient_0",
							name_update: { question_path: "/data/name" },
							repeat_context: "",
							case_indices: [],
							open_condition: {
								doc_type: "FormActionCondition",
								type: "always",
							},
						},
					],
				};
			},
			THROUGH_MENUS,
		);
		const codes = ctx.close().findings.map((finding) => finding.code);
		expect(codes).toContain(
			`${M}/case-list-form-on-an-advanced-module-or-naming-an-advanced-form`,
		);
		expect(codes).not.toContain(
			`${M}/case-list-form-missing-not-a-registration-form-toggle-off-or`,
		);
	});

	it.each([
		[
			"a blank form id before a host some form of which needs no case",
			(app: AppJson) => {
				block(app, 1).form_id = "";
				(app.modules[1]?.forms[0] as JsonObject).requires = "none";
			},
			undefined,
			`${M}/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case`,
		],
		[
			"a form id naming no form before a host above whose list is a tile",
			(app: AppJson) => {
				block(app, 1).form_id = "not-a-form";
				const host = app.modules[1] as JsonObject;
				host.put_in_root = true;
				const details = host.case_details as JsonObject;
				(details.short as JsonObject).case_tile_template = "icon_text_grid";
			},
			`${M}/case-list-form-missing-not-a-registration-form-toggle-off-or`,
			`${M}/case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile`,
		],
		[
			"a child host above before a form of it that needs no case",
			(app: AppJson) => {
				const host = app.modules[1] as AppJson["modules"][number];
				host.put_in_root = true;
				host.root_module_id = (app.modules[0] as JsonObject).unique_id;
				(host.forms[0] as JsonObject).requires = "none";
			},
			`${M}/case-list-form-on-a-child-put-in-root-module-whose-parent-s-case`,
			`${M}/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case`,
		],
		[
			"a host some form of which needs no case before a child registration",
			(app: AppJson) => {
				(app.modules[1]?.forms[0] as JsonObject).requires = "none";
				(app.modules[0] as JsonObject).case_type = "household";
				const form = app.modules[0]?.forms[0] as JsonObject;
				const actions = form.actions as JsonObject;
				actions.subcases = [
					{
						doc_type: "OpenSubCaseAction",
						case_type: "patient",
						case_name: "/data/name",
						condition: { doc_type: "FormActionCondition", type: "always" },
						repeat_context: "",
					},
				];
			},
			`${M}/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case`,
			`${M}/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case`,
		],
	] as const)("takes the earlier row: %s", async (_, edit, earlier, later) => {
		const ctx = await stagesOver(always(), edit, THROUGH_MENUS);
		const codes = ctx.close().findings.map((finding) => finding.code);
		if (earlier !== undefined) expect(codes).toContain(earlier);
		expect(codes).not.toContain(later);
	});

	it("raises a refused block at the host's case list", async () => {
		const reading = await readMenusOf(always(), (app) => {
			block(app, 1).form_id = "not-a-form";
		});
		expect(
			reading.findings.find((finding) =>
				finding.code.endsWith("missing-not-a-registration-form-toggle-off-or"),
			)?.place,
		).toEqual({ kind: "case-list", menu: 1, name: "Patients" });
	});
});

/** The index of the stored menu named `name`. */
function menuIndex(app: AppJson, name: string): number {
	return app.modules.indexOf(menuNamed(app, name));
}

describe("the Register label", () => {
	it("reads a label with no text in any language as HQ's words, with its record", async () => {
		const reading = await readMenusOf(always(), (app) => {
			block(app, 1).label = { en: "" };
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Patients")
				.caseListRegistrationForm?.label,
		).toBe("Create a new Case");
		expect(rewrites(reading)).toContain("registration-label-fixed");
	});

	it("reads a language whose label is empty as HQ's words there, never another language's text, with its record", async () => {
		const reading = await readMenusOf(inSpanish(always(), new Map()), (app) => {
			block(app, 1).label = { en: "New patient", es: "" };
		});
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		const host = moduleNamed(doc, "Patients");
		expect(host.caseListRegistrationForm?.label).toBe("New patient");
		expect(
			doc.localization?.translations.spa?.[
				makeTranslationUnitId(
					"module",
					host.uuid,
					"case-list-registration-label",
				)
			]?.value,
		).toBe("Create a new Case");
		expect(rewrites(reading)).toContain("registration-label-fixed");
	});

	it("reads a language the label holds no key for as no translation", async () => {
		const reading = await readMenusOf(inSpanish(always(), new Map()), (app) => {
			block(app, 1).label = { en: "New patient" };
		});
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		const host = moduleNamed(doc, "Patients");
		expect(host.caseListRegistrationForm?.label).toBe("New patient");
		expect(
			doc.localization?.translations.spa?.[
				makeTranslationUnitId(
					"module",
					host.uuid,
					"case-list-registration-label",
				)
			],
		).toBeUndefined();
		expect(rewrites(reading)).not.toContain("registration-label-fixed");
	});

	it("keeps a label of its own, and none where it is the form's name", async () => {
		const own = await readMenusOf(afterEmptySearch("New patient"));
		expect(codesOf(own)).toEqual([]);
		expect(
			moduleNamed(own.doc as BlueprintDoc, "Patients").caseListRegistrationForm
				?.label,
		).toBe("New patient");
		expect(rewrites(own)).not.toContain("registration-label-fixed");
	});
});

describe("registration-form-last", () => {
	it("moves a registration offered after an empty search to the end of its menu's forms", () => {
		const doc = afterEmptySearch();
		const [host] = doc.moduleOrder;
		const forms = doc.formOrder[host as string] ?? [];
		const reordered = {
			...doc,
			formOrder: { ...doc.formOrder, [host as string]: [...forms].reverse() },
		};
		const canonical = registrationFormLast(reordered);
		const after = canonical.formOrder[host as string] ?? [];
		expect(canonical.forms[after[after.length - 1] as string]?.name).toBe(
			"Register",
		);
		expect(registrationFormLast(canonical)).toBe(canonical);
	});
});
