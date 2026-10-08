/**
 * The two inputs step 1 left out of the lane as ones no Nova document can
 * hold, each tried through Nova's planner, commit gate and exports.
 *
 * Contract: a claim that Nova cannot produce an input is true only where
 * Nova's own gate or exports say so. The plausible failure is a row dropped
 * from the lane on a belief about the gate that the gate does not share.
 *
 * - **A basic child case of its own menu's case type** (defect 12, under
 *   `DONT_INDEX_SAME_CASETYPE`). HQ's basic child case is a form's
 *   `subcases` action. Nova derives one only for a field that writes a case
 *   type other than its menu's (`lib/commcare/deriveCaseConfig.ts`, the
 *   `child` buckets): a field that writes the menu's own type writes the
 *   selected or new case of the menu itself, whatever the type's parent is.
 *   So a type that is its own parent, written from its own menu, is
 *   admitted and exports no `subcases` action at all. The accepted
 *   counterpart is a field that writes another type, which exports one.
 * - **A form whose source holds the session's `supply_point_id` path**
 *   (defect 20, under CommTrack). This one Nova's gate admits: a hidden
 *   value may read the path. What keeps HQ's substring test
 *   (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`) from
 *   finding it is the spelling: every export writes the path's apostrophes
 *   as `&apos;`. So the document is a corpus document
 *   (`targeted-supply-point-read`), and the lane observes what HQ does with
 *   it, before and after a save in HQ's form builder respells the source.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import type { BlueprintDoc } from "@/lib/domain";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { SUPPLY_POINT_PATH } from "../documents/supplyPointRead";

const ID = "targeted-unproduced-inputs";
const uuid = (name: string) => targetedUuid(ID, name);

interface HqForm {
	readonly actions?: {
		readonly subcases?: readonly { readonly case_type: string }[];
	};
}
interface HqApp {
	readonly modules: readonly {
		readonly case_type: string;
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
	return expandDoc(made.doc as BlueprintDoc) as unknown as HqApp;
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
	const escaped = SUPPLY_POINT_PATH.replaceAll("'", "&apos;");
	const placements = {
		"a hidden value that reads the path": f({
			kind: "hidden",
			uuid: uuid("held"),
			id: "held",
			calculate: SUPPLY_POINT_PATH,
		}),
		"a hidden value holding the path as text": f({
			kind: "hidden",
			uuid: uuid("held"),
			id: "held",
			calculate: `"${SUPPLY_POINT_PATH}"`,
		}),
		"a label that says the path": f({
			kind: "text",
			uuid: uuid("held"),
			id: "held",
			label: proseText(`Read ${SUPPLY_POINT_PATH} here`),
		}),
	};

	it.each(Object.entries(placements))(
		"is admitted with %s, and its export spells the path so HQ's test does not find it",
		(_name, field) => {
			const doc = buildDoc({
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
			const sources = Object.values(exported(doc)._attachments);
			expect(sources).toHaveLength(1);
			for (const source of sources) {
				expect(source).toContain(escaped);
				expect(source).not.toContain(SUPPLY_POINT_PATH);
			}
		},
	);
});
