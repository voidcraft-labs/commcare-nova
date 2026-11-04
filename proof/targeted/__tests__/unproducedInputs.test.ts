/**
 * The inputs step 1 left out of the lane as ones no Nova document can hold,
 * each tried through Nova's planner, commit gate and exports: a basic child
 * case of its own menu's case type, a form that reads the session's
 * `supply_point_id`, and defect 20's `product_id` datum.
 *
 * Contract: a claim that Nova cannot produce an input is true only where
 * Nova's own parser, gate or exports say so. The plausible failure is a row
 * dropped from the lane on a belief its production boundary does not share.
 *
 * - **A basic child case of its own menu's case type** (defect 12, under
 *   `DONT_INDEX_SAME_CASETYPE`). HQ's basic child case is a form's
 *   `subcases` action. Nova places a create there only when its case type
 *   is not its menu's (`lib/commcare/placement.ts::sameTypeExclusions` keeps
 *   a same-type create out of the basic slot until a publish can check the
 *   project space, `lib/commcare/sameTypeChildCases.ts`): a field that
 *   writes the menu's own type writes the selected or new case of the menu
 *   itself, whatever the type's parent is.
 *   So a type that is its own parent, written from its own menu, is
 *   admitted and exports no `subcases` action at all. The accepted
 *   counterpart is a field that writes another type, which exports one.
 * - **A form that reads the session's `supply_point_id`** (defect 20,
 *   under CommTrack). No menu of a Nova app supplies that datum, so the
 *   form could never open, and Nova's parser refuses the unknown datum
 *   (the unknown session value, finding 68); a read of a datum the form's
 *   entry declares is admitted. The path written as text, in a string or a
 *   label, reads nothing and is admitted, and what keeps HQ's substring test
 *   (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`) from
 *   finding it there is the spelling: every export writes the path's
 *   apostrophes as `&apos;`. The control `targeted-supply-point-read` keeps
 *   the read from before the refusal, and the lane observes what HQ does
 *   with it.
 * - **Defect 20's `product_id` datum** (under CommTrack). HQ gives it only
 *   to an advanced module: the entry of an `AdvancedModule`'s case list
 *   menu item, and an advanced form whose last load shows product stock
 *   (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module` and
 *   `::configure_entry_advanced_form`, both under `isinstance(module,
 *   AdvancedModule)`). Nova exports a menu advanced where an after-submit
 *   link carries a create a basic form gives no datum
 *   (`lib/commcare/moduleKind.ts`), but writes no case list menu item
 *   beside an advanced menu's forms (part 02 §17) and no load that shows
 *   product stock (`LoadUpdateAction.show_product_stock` is `false` by its
 *   type), so neither branch is reached. The accepted counterparts are the
 *   advanced menu itself and a case list menu item on a basic menu, which
 *   the export does write.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, CaseOperation, FormLink } from "@/lib/domain";
import { plainColumn, proseText } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { caseListOf, targetedDocument, targetedUuid } from "../build";

const ID = "targeted-unproduced-inputs";
/** The path HQ's substring test looks for (`suite_xml/xml_models.py::session_var`). */
const SUPPLY_POINT_PATH =
	"instance('commcaresession')/session/data/supply_point_id";
const uuid = (name: string) => targetedUuid(ID, name);

interface HqForm {
	readonly actions?: {
		readonly subcases?: readonly { readonly case_type: string }[];
		readonly load_update_cases?: readonly {
			readonly show_product_stock: boolean;
		}[];
	};
}
interface HqApp {
	readonly modules: readonly {
		readonly doc_type: string;
		readonly case_type: string;
		readonly case_list?: { readonly show: boolean };
		readonly forms: readonly HqForm[];
	}[];
	readonly _attachments: Readonly<Record<string, string>>;
}

/** The document as Nova's planner makes it and Nova's gate admits it, exported as Nova's upload holds it. */
function exported(doc: BlueprintDoc): HqApp {
	const made = targetedDocument({
		id: ID,
		rows: ["a dropped input, tried"],
		doc,
		expected: { intent: [] },
	});
	return expandDoc(hydratePersistedBlueprint(made.doc)) as unknown as HqApp;
}

function childTypes(app: HqApp): string[][] {
	return app.modules.map((module) =>
		module.forms.flatMap((form) =>
			(form.actions?.subcases ?? []).map((subcase) => subcase.case_type),
		),
	);
}

function patients(
	formType: "followup" | "registration",
	writes: string,
	parentOfPatient?: string,
): BlueprintDoc {
	const named = (name: string, parent?: string) => ({
		name,
		...(parent !== undefined && { parent_type: parent }),
		properties: [{ name: "case_name", label: proseText("Name") }],
	});
	return buildDoc({
		appId: ID,
		appName: "Patients",
		caseTypes: [named("patient", parentOfPatient), named("visit", "patient")],
		modules: [
			{
				uuid: uuid("module"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: uuid("form"),
						name: "Form",
						type: formType,
						fields: [
							f({
								kind: "text",
								uuid: uuid("written"),
								id: "written_name",
								label: proseText("Name"),
								caseWrite: { caseType: writes, property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: uuid("visits"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([
					plainColumn(uuid("visit-name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: uuid("visit-form"),
						name: "Note",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
}

describe("a basic child case of its own menu's case type", () => {
	it.each(["followup", "registration"] as const)(
		"is not what a %s form's write to its menu's own type exports, even where the type is its own parent",
		(formType) => {
			const app = exported(patients(formType, "patient", "patient"));
			expect(app.modules.map((module) => module.case_type)).toEqual([
				"patient",
				"visit",
			]);
			expect(childTypes(app)).toEqual([[], []]);
		},
	);

	it("is exported only for a write to another case type", () => {
		expect(childTypes(exported(patients("followup", "visit")))).toEqual([
			["visit"],
			[],
		]);
	});
});

describe("a form that reads the session's supply point", () => {
	const escapedSuffix =
		"(&apos;commcaresession&apos;)/session/data/supply_point_id";

	function visit(field: ReturnType<typeof f>): BlueprintDoc {
		return buildDoc({
			appId: ID,
			appName: "Stock",
			caseTypes: [
				{
					name: "client",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: uuid("module"),
					name: "Clients",
					caseType: "client",
					caseListConfig: caseListOf([
						plainColumn(uuid("name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: uuid("form"),
							name: "Visit",
							type: "followup",
							fields: [field],
						},
					],
				},
			],
		});
	}

	function held(calculate: string) {
		return f({ kind: "hidden", uuid: uuid("held"), id: "held", calculate });
	}

	it("is refused by Nova's parser where a hidden value reads the unknown datum", () => {
		expect(() => visit(held(SUPPLY_POINT_PATH))).toThrow(
			/session value named "supply_point_id"/,
		);
	});

	it("is admitted where the read is of a datum the form's entry declares", () => {
		const sources = Object.values(
			exported(visit(held("instance('commcaresession')/session/data/case_id")))
				._attachments,
		);
		expect(sources).toHaveLength(1);
	});

	const text = {
		"a hidden value holding the path as text": held(`"${SUPPLY_POINT_PATH}"`),
		"a label that says the path": f({
			kind: "text",
			uuid: uuid("held"),
			id: "held",
			label: proseText(`Read ${SUPPLY_POINT_PATH} here`),
		}),
	};

	it.each(Object.entries(text))(
		"is admitted with %s, which reads nothing, and its export spells the path so HQ's test does not find it",
		(_name, field) => {
			const sources = Object.values(exported(visit(field))._attachments);
			expect(sources).toHaveLength(1);
			for (const source of sources) {
				expect(source).toContain(escapedSuffix);
				expect(source).not.toContain(SUPPLY_POINT_PATH);
			}
		},
	);
});

describe("defect 20's product_id datum", () => {
	const OWN = uuid("own");
	const VISIT = uuid("visit");
	const name = {
		kind: "term",
		term: { kind: "field", uuid: uuid("name") },
	} as Expression;

	/** A household registration that creates a visit of the household, and a
	 *  link that carries the visit to its review form, which makes the
	 *  Households menu advanced; beside it a menu that is only a case list. */
	function stock(): BlueprintDoc {
		const doc = buildDoc({
			appId: ID,
			appName: "Stock",
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "visit",
					parent_type: "household",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: uuid("list-only"),
					name: "Household list",
					caseType: "household",
					caseListOnly: true,
					caseListConfig: caseListOf([
						plainColumn(uuid("list-name"), "case_name", "Name"),
					]),
					forms: [],
				},
				{
					uuid: uuid("module"),
					name: "Households",
					caseType: "household",
					caseListConfig: caseListOf([
						plainColumn(uuid("household-name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: uuid("form"),
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									uuid: uuid("name"),
									id: "name",
									label: proseText("Name"),
								}),
							],
						},
					],
				},
				{
					uuid: uuid("visits"),
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListOf([
						plainColumn(uuid("visit-name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: uuid("review"),
							name: "Review",
							type: "followup",
							fields: [
								f({
									kind: "text",
									uuid: uuid("notes"),
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						},
					],
				},
			],
		});
		const operations = [
			{ uuid: OWN, id: "household", action: "own", name },
			{
				uuid: VISIT,
				id: "visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name,
				links: [
					{
						identifier: "parent",
						targetType: "household",
						target: { kind: "op", opUuid: OWN },
						relationship: "extension",
					},
				],
			},
		] as CaseOperation[];
		const links: FormLink[] = [
			{
				uuid: uuid("link"),
				target: {
					type: "form",
					moduleUuid: uuid("visits"),
					formUuid: uuid("review"),
				},
			},
		];
		doc.forms[uuid("form")] = {
			...doc.forms[uuid("form")],
			caseOperations: operations,
			formLinks: links,
		};
		return doc;
	}

	it("is reached by no export: an advanced menu writes no case list menu item beside its forms and no load that shows product stock", () => {
		const app = exported(stock());
		// The accepted counterparts: the carried create makes its menu
		// advanced, and the basic menu that is only a case list shows its
		// menu item ...
		expect(app.modules.map((module) => module.doc_type)).toEqual([
			"Module",
			"AdvancedModule",
			"Module",
		]);
		expect(app.modules.map((module) => module.case_list?.show)).toEqual([
			true,
			false,
			false,
		]);
		// ... while no advanced menu shows one beside its forms, and no load
		// of an advanced form shows product stock: HQ's two branches that add
		// the datum are never reached.
		for (const module of app.modules) {
			if (module.doc_type !== "AdvancedModule") continue;
			expect(module.forms.length).toBeGreaterThan(0);
			expect(module.case_list?.show).toBe(false);
			for (const form of module.forms)
				for (const load of form.actions?.load_update_cases ?? [])
					expect(load.show_product_stock).toBe(false);
		}
	});
});
