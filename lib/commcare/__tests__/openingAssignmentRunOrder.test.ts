/**
 * The order a record's starting values run in.
 *
 * Contract: CommCare HQ's Case Management save writes a record's map of
 * starting values in the order its form builder lists the questions they
 * fill, every question with a control first and then every Hidden Value, each
 * in the form's order (`case_config_ui.js` `questionScores` over
 * `xform.py::XForm.get_questions`). The export writes that order, Preview
 * runs it, and the canonical form of a document holds it
 * (`formOpeningAssignments.ts::openingAssignmentsInRunOrder`), so a save in
 * CommCare HQ keeps what Nova published, and Preview runs the values as the
 * device does where one fills a question another's calculation reads.
 *
 * The plausible failure: the export writing a record's values in the order
 * they were added, which CommCare HQ's save reorders (proof 4 on
 * `targeted-independent-form-choices` found the setvalues move), or Preview
 * and the export running them in different orders.
 */
import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { openingAssignmentsInRunOrder } from "@/lib/domain/formOpeningAssignments";
import { independentChoicesBlueprint } from "../../../proof/targeted/documents/independentFormChoices";

type Load = { case_tag: string; preload: Record<string, string> };
type App = {
	modules: { forms: { actions: { load_update_cases?: Load[] } }[] }[];
};

function visit() {
	const doc = independentChoicesBlueprint("run-order", true);
	const formUuid = Object.keys(doc.forms).find(
		(uuid) => doc.forms[uuid as never]?.name === "Visit two people",
	);
	if (formUuid === undefined) throw new Error("The app holds the visit.");
	return { doc, formUuid: formUuid as never };
}

describe("a record's starting values", () => {
	it("run in the order CommCare HQ's form builder lists their questions", () => {
		const { doc, formUuid } = visit();
		const held = doc.forms[formUuid].openingAssignments ?? [];
		const names = (rows: typeof held) =>
			rows.map((row) => [row.source.kind, doc.fields[row.field]?.id]);
		// Added as the first record's name into first_record, then into
		// starting_record, then the form's own record into starting_record.
		expect(names(held)).toEqual([
			["selection", "first_record"],
			["selection", "starting_record"],
			["own", "starting_record"],
		]);
		expect(names(openingAssignmentsInRunOrder(doc, formUuid, held))).toEqual([
			["selection", "starting_record"],
			["selection", "first_record"],
			["own", "starting_record"],
		]);
	});

	it("are exported in that order, and the canonical form holds it", () => {
		const { doc, formUuid } = visit();
		const app = expandDoc(doc) as unknown as App;
		const loads = app.modules
			.flatMap((menu) => menu.forms)
			.flatMap((form) => form.actions.load_update_cases ?? []);
		const preloads = loads
			.map((load) => Object.keys(load.preload))
			.filter((keys) => keys.length > 0);
		expect(preloads).toEqual([
			["/data/starting_record", "/data/first_record"],
			["/data/starting_record"],
		]);
		const canon = canonDocument(doc);
		expect(canon.forms[formUuid].openingAssignments).toEqual(
			openingAssignmentsInRunOrder(
				doc,
				formUuid,
				doc.forms[formUuid].openingAssignments ?? [],
			),
		);
		expect(expandDoc(canon)).toEqual(expandDoc(doc));
	});
});
