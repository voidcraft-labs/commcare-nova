import { castDraft, produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	blueprintDocSchema,
	type CaseListConfig,
	type CaseSearchConfig,
	type Form,
	plainColumn,
} from "@/lib/domain";
import {
	eq,
	exists,
	gt,
	input,
	literal,
	prop,
	sessionContext,
	subcasePath,
} from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import {
	admittedCaseListDoc,
	findings,
} from "../../case-list/__tests__/caseListRuleFixture";

function candidate(
	config: CaseSearchConfig | undefined,
	filter?: CaseListConfig["filter"],
) {
	const base = admittedCaseListDoc({
		caseTypes: [
			{ name: "patient", properties: [] },
			{ name: "visit", parent_type: "patient", properties: [] },
		],
	});
	const id = base.moduleOrder[0];
	const doc = produce(base, (draft) => {
		const mod = draft.modules[id];
		if (mod === undefined) return;
		mod.caseSearchConfig = castDraft(config);
		if (filter !== undefined && mod.caseListConfig !== undefined)
			mod.caseListConfig.filter = castDraft(filter);
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
const caseData = "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE";
const typeError = "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR";
const notOnTheList = "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_NOT_ON_THE_LIST";
describe("Search action condition admission", () => {
	it.each([
		{
			condition: eq(prop("patient", "case_name"), literal("A")),
			codes: [caseData],
		},
		{
			condition: exists(subcasePath("parent", "visit")),
			codes: ["CASE_LIST_EXPRESSION_NOT_ON_DEVICE", caseData],
		},
		{
			condition: gt(sessionContext("username"), literal("M")),
			codes: [typeError],
		},
		{
			condition: eq(sessionContext("username"), literal("A")),
			codes: [notOnTheList],
		},
		{ condition: eq(literal("A"), literal("A")), codes: [] },
	])(
		"checks $condition.kind with complete findings",
		({ condition, codes }) => {
			const errors = findings(
				candidate({ searchButtonDisplayCondition: condition }),
			);
			expect(errors.map((error) => error.code)).toEqual(codes);
			if (errors.length)
				expect(errors[0].details?.slot).toBe(
					"caseSearchConfig.searchButtonDisplayCondition",
				);
		},
	);
	it("reports both an orphan identity and an unavailable input context without exposing the UUID in type prose", () => {
		const errors = findings(
			candidate({
				searchButtonDisplayCondition: eq(
					input(testUuid("ghost")),
					literal("x"),
				),
			}),
		);
		expect(errors.map((error) => error.code).sort()).toEqual(
			[typeError, "CASE_LIST_BARE_SEARCH_INPUT_REF"].sort(),
		);
		const typed = errors.find((error) => error.code === typeError);
		expect(typed?.message).toMatch(/Search field/i);
		expect(typed?.message).not.toContain(testUuid("ghost"));
	});
	it.each([undefined, {}])("admits the absent condition %j", (config) =>
		expect(findings(candidate(config))).toEqual([]),
	);
	it("reports independently invalid button and assignment slots together", () => {
		const errors = findings(
			candidate({
				searchButtonDisplayCondition: eq(
					prop("patient", "case_name"),
					literal("A"),
				),
				excludedOwnerIds: { kind: "term", term: prop("patient", "owner_id") },
			}),
		);
		expect(errors.map((error) => error.code).sort()).toEqual(
			[caseData, "CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE"].sort(),
		);
	});
	// HQ's build declares an entry's instances from its datums, details and
	// frames, never from the Search action's `relevant`
	// (`post_process/instances.py::_get_all_xpaths_for_entry`,
	// `xml_models.py::Detail.get_all_xpaths`). A session read is admitted
	// where the list's own selection reads the session, and refused where it
	// reads only the worker's records.
	it("admits a session read only where the case list loads the session", () => {
		const condition = eq(sessionContext("username"), literal("A"));
		const refused = findings(
			candidate({ searchButtonDisplayCondition: condition }),
		);
		expect(refused.map((error) => error.code)).toEqual([notOnTheList]);
		expect(refused[0]?.details).toMatchObject({
			reason: "instance-not-on-the-list",
			instances: "commcaresession",
		});
		expect(refused[0]?.message).toContain("instance('commcaresession')");
		expect(
			findings(
				candidate(
					{ searchButtonDisplayCondition: condition },
					eq(prop("patient", "owner_id"), sessionContext("userid")),
				),
			),
		).toEqual([]);
	});
	// A form's entry declares what its after-submit frames read too: a
	// follow-up in a menu that opens on its case list and returns to its
	// previous screen pushes that list's case from the session, so its entry
	// declares the session (`post_process/instances.py` collects
	// `entry.stack`'s frames), and one that returns home pushes nothing.
	it("admits a session read where every entry showing the list returns to it with its case", () => {
		const condition = eq(sessionContext("username"), literal("A"));
		expect(findings(caseFirst(condition, "previous"))).toEqual([]);
		expect(
			findings(caseFirst(condition, "app_home")).map((error) => error.code),
		).toEqual([notOnTheList]);
	});
	// HQ collects a form command's `relevant`, the form's display condition,
	// for its entry whatever the app's version
	// (`post_process/instances.py::_get_all_xpaths_for_entry`), so a form
	// shown on a condition that reads the worker declares the session there.
	it("admits a session read where every form showing the list reads the session to be shown", () => {
		const condition = eq(sessionContext("username"), literal("A"));
		expect(
			findings(
				caseFirst(
					condition,
					"app_home",
					eq(sessionContext("username"), literal("B")),
				),
			),
		).toEqual([]);
	});
});

/** A menu of patients whose one form follows a patient up, so it opens on its
 *  case list, beside the menu that registers them. */
function caseFirst(
	condition: Expression,
	postSubmit: Form["postSubmit"],
	displayCondition?: Expression,
) {
	const columns = (key: string) => ({
		columns: [plainColumn(testUuid(key), "case_name", "Name")],
		searchInputs: [],
	});
	const doc = buildDoc({
		appName: "Search button scopes",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Register",
				caseType: "patient",
				caseListConfig: columns("register-name"),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: columns("patients-name"),
				caseSearchConfig: { searchButtonDisplayCondition: condition },
				forms: [
					{
						name: "Visit",
						type: "followup",
						postSubmit,
						...(displayCondition !== undefined && { displayCondition }),
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
