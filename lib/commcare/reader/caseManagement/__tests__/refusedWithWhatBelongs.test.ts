/**
 * A refused thing is refused whole, and what belongs to it is claimed under
 * its refusal: one cause in a source CommCare HQ serves is one finding.
 *
 * Contract: each source below, Nova's export of a document changed as HQ's
 * pages store the change, reads into exactly the finding its manifest entry
 * names, at its place, with no `unrecognized` finding and no reader defect
 * beside it:
 *
 * - a session fact a refused value shapes (a menu's root, a child case a
 *   refused condition leaves out) is claimed under that refusal
 *   (`index.ts::settleEntryFactDifferences`), judged once every refusal of the
 *   binding stands;
 * - a load the reading refuses leaves out of the document the operations that
 *   reach a case its menu no longer chooses (`advancedActions.ts::
 *   dropUnselectedCaseOperations`), so Nova's writer can write the rest;
 * - the last load's list menu of another case type is HQ's
 *   `ParentModuleReferenceError` (`entries.py::EntriesHelper.get_target_module`);
 * - an advanced form's display condition reading the case where every load
 *   auto-selects is HQ's "filtering without case"
 *   (`helpers/validators.py::AdvancedFormValidator`);
 * - an index to an auto-selected load the reading refuses belongs to that
 *   load's refusal, and so does the chain it breaks where it leaves an earlier
 *   load of another case type last;
 * - an open action that names its question itself, as HQ's Case Management
 *   does, reads as the open action Nova writes over a trimmed sibling;
 * - a create whose condition the settle refuses carries the check its name
 *   question holds under that refusal (`advancedActions.ts::settleAdvancedForm`).
 *
 * The plausible failures: an `unrecognized entry-fact:<key>` beside the
 * refusal that left the fact out, the reader defect "expandDoc threw" beside a
 * refused load, a second finding under another entry, and an open action Nova
 * holds read as `unrecognized` at the form's actions.
 */
import { describe, expect, it } from "vitest";
import type { CaseOperation } from "@/lib/domain";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import {
	advancedFixture,
	OP,
	read,
} from "../../../__tests__/advancedPlacementFixture";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import {
	type ExportEdits,
	exportedBody,
	inputFor,
} from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import type { ReadOutcome } from "../../types";
import { readHqApp } from "./heldReading";

const F = "forms-and-case-writes";
const M = "menus-and-case-lists";

type Doc = ReturnType<typeof advancedFixture>["doc"];
type Json = Record<string, unknown>;

async function readEdited(doc: Doc, edits: ExportEdits): Promise<ReadOutcome> {
	return readHqApp(
		await inputFor(exportedBody(doc, edits), {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
}

function entryRows(outcome: ReadOutcome) {
	expect(outcome.defects).toEqual([]);
	expect(account(outcome)).toEqual({ findings: [], defects: 0 });
	if (outcome.kind !== "read") throw new Error("Expected the form to be read");
	const doc = outcome.draft.doc;
	const form = Object.values(doc.forms).find(
		(item) => item.name === "Under test",
	);
	if (!form) throw new Error("Expected the form under test");
	return formCaseSelections(doc, form.uuid);
}

/** Each finding as its entry and its place, and each reader defect. */
function account(outcome: ReadOutcome): {
	readonly findings: string[];
	readonly defects: number;
} {
	return {
		findings:
			outcome.kind === "account"
				? outcome.findings.map(
						(finding) =>
							`${finding.code}${finding.code === "unrecognized" ? ` ${finding.detail.name}` : ""} @${finding.place.kind}`,
					)
				: [],
		defects: outcome.defects.length,
	};
}

/** The form under test's stored actions, in the menus HQ stores. */
function underTest(modules: Json[]): Json & {
	actions: { load_update_cases: Json[]; open_cases: Json[] };
} {
	for (const module of modules)
		for (const form of module.forms as Json[])
			if (JSON.stringify(form.name).includes("Under test"))
				return form as never;
	throw new Error("The app holds the form under test.");
}

const memberFollowup = (extra: CaseOperation[] = []) =>
	advancedFixture({
		formType: "followup",
		menu: "members",
		operations: () => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
			...extra,
		],
	});

describe("a session fact a refused value shapes", () => {
	it("is claimed under the refusal of a menu's root that names no menu", async () => {
		const { doc } = memberFollowup();
		const outcome = await readEdited(doc, {
			modules: (modules) =>
				modules.map((module, index) =>
					index === 2 ? { ...module, root_module_id: "0".repeat(32) } : module,
				),
		});
		expect(account(outcome)).toEqual({
			findings: [
				`${M}/root-module-id-naming-a-missing-module-or-a-cycle @menu`,
			],
			defects: 0,
		});
	});
});

describe("a session fact a refused condition shapes", () => {
	it("is judged once the condition's refusal stands, and claimed under it", async () => {
		const { doc } = memberFollowup([
			{
				uuid: OP("visit"),
				id: "visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read("name"),
				links: [],
			},
		]);
		const outcome = await readEdited(doc, {
			modules: (modules) => {
				for (const open of underTest(modules).actions.open_cases)
					open.open_condition = {
						doc_type: "FormActionCondition",
						type: "if",
						question: "/data/name",
						answer: "x",
						operator: "=",
					};
				return modules;
			},
		});
		const { findings, defects } = account(outcome);
		// The create the condition governs is refused whole: its name question's
		// check stands under the condition's finding, never as `unrecognized`.
		expect(findings).toEqual([
			`${F}/a-subcase-or-advanced-action-condition-on-a-question-the-picker @question`,
		]);
		expect(defects).toBe(0);
	});
});

describe("a load the reading refuses", () => {
	it("is its one finding, with no reader defect for the operations it leaves without a chosen case", async () => {
		const { doc } = memberFollowup();
		const outcome = await readEdited(doc, {
			modules: (modules) => {
				const loads = underTest(modules).actions.load_update_cases;
				(loads[loads.length - 1] as Json).case_tag = "";
				return modules;
			},
		});
		expect(account(outcome)).toEqual({
			findings: [`${F}/case-tag-blank-on-a-non-auto-select-action @form`],
			defects: 0,
		});
	});

	it("names a last load's list menu of another case type under HQ's own refusal", async () => {
		const { doc } = memberFollowup();
		const outcome = await readEdited(doc, {
			modules: (modules) => {
				const loads = underTest(modules).actions.load_update_cases;
				(loads[loads.length - 1] as Json).details_module = (
					modules[0] as Json
				).unique_id;
				return modules;
			},
		});
		expect(account(outcome)).toEqual({
			findings: [
				`${F}/details-module-naming-another-module-of-a-different-case-type-or @form`,
			],
			defects: 0,
		});
	});

	it("filters the next record list by the worker-data selection", async () => {
		const { doc } = memberFollowup();
		const outcome = await readEdited(doc, {
			modules: (modules) => {
				const loads = underTest(modules).actions.load_update_cases;
				const first = loads[0] as Json;
				first.auto_select = {
					doc_type: "AutoSelectCase",
					mode: "user",
					value_source: "",
					value_key: "household_id",
				};
				first.details_module = null;
				return modules;
			},
		});
		const [workerValue, chosen] = entryRows(outcome);
		expect(workerValue?.source).toEqual({
			kind: "worker-data",
			property: { kind: "session-user", field: "household_id" },
		});
		expect(chosen?.source).toMatchObject({
			kind: "choose",
			under: { selection: workerValue?.uuid },
		});
	});

	it("keeps a named connection to an earlier record as the next supply", async () => {
		const { doc } = memberFollowup();
		const outcome = await readEdited(doc, {
			modules: (modules) => {
				const loads = underTest(modules).actions.load_update_cases;
				const [first, last] = loads as [Json, Json];
				last.auto_select = {
					doc_type: "AutoSelectCase",
					mode: "case",
					value_source: first.case_tag,
					value_key: "head",
				};
				last.details_module = null;
				last.case_index = {
					doc_type: "CaseIndex",
					tag: null,
					reference_id: "parent",
					relationship: "child",
					relationship_question: "",
				};
				return modules;
			},
		});
		const [chosen, linked] = entryRows(outcome);
		expect(chosen?.source.kind).toBe("choose");
		expect(linked?.source).toEqual({
			kind: "index",
			selection: chosen?.uuid,
			identifier: "head",
		});
	});

	it("judges an index on the first chosen load by where HQ stores it, after the worker's record it may name", async () => {
		const { doc } = memberFollowup([
			{
				uuid: OP("worker"),
				id: "commcare_user",
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "last_household", value: read("name") }],
			},
		]);
		const outcome = await readEdited(doc, {
			modules: (modules) => {
				const actions = underTest(modules).actions;
				const worker = actions.load_update_cases.find(
					(load) => load.auto_select !== null,
				) as Json;
				const chosen = actions.load_update_cases.filter(
					(load) => load.auto_select === null,
				);
				// HQ's editor offers the first chosen load, stored after the worker's,
				// an index to the load stored before it.
				(chosen[0] as Json).case_index = {
					doc_type: "CaseIndex",
					tag: worker.case_tag,
					reference_id: "parent",
					relationship: "child",
					relationship_question: "",
				};
				actions.load_update_cases = [worker, ...chosen];
				return modules;
			},
		});
		const [worker, chosen] = entryRows(outcome);
		expect(worker?.source.kind).toBe("worker-record");
		expect(chosen?.source).toMatchObject({
			kind: "choose",
			under: { selection: worker?.uuid, identifier: "parent" },
		});
	});

	it("keeps the worker record before two manual choices", async () => {
		const { doc } = memberFollowup([
			{
				uuid: OP("worker"),
				id: "commcare_user",
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "last_household", value: read("name") }],
			},
		]);
		const outcome = await readEdited(doc, {
			modules: (modules) => {
				const actions = underTest(modules).actions;
				const worker = actions.load_update_cases.find(
					(load) => load.auto_select !== null,
				) as Json;
				const chosen = actions.load_update_cases.filter(
					(load) => load.auto_select === null,
				);
				actions.load_update_cases = [worker, ...chosen];
				return modules;
			},
		});
		const [worker, first, second] = entryRows(outcome);
		expect(worker?.source.kind).toBe("worker-record");
		expect(first?.source).toMatchObject({ kind: "choose" });
		expect(first?.source).not.toHaveProperty("under");
		expect(second?.source).toMatchObject({
			kind: "choose",
			under: { selection: first?.uuid },
		});
	});
});

describe("a record ID calculated when the form opens", () => {
	it("distinguishes a missing input from a raw expression whose value exists at the same step", async () => {
		const { doc } = memberFollowup();
		const readValue = (value_key: string) =>
			readEdited(doc, {
				modules: (modules) => {
					const form = underTest(modules);
					const [first, own] = form.actions.load_update_cases as [Json, Json];
					own.auto_select = {
						doc_type: "AutoSelectCase",
						mode: "raw",
						value_source: "",
						value_key,
					};
					own.case_index = {
						doc_type: "CaseIndex",
						tag: "",
						reference_id: "parent",
						relationship: "child",
						relationship_question: "",
					};
					own.details_module = null;
					form.actions.load_update_cases = [first, own];
					return modules;
				},
			});
		const earlier = await readValue(
			"instance('commcaresession')/session/data/case_id_load_household0",
		);
		const [chosen, reached] = entryRows(earlier);
		expect(reached?.source).toMatchObject({
			kind: "expression",
			value: {
				kind: "term",
				term: {
					kind: "session-datum",
					datum: { kind: "form-selection", selection: chosen?.uuid },
				},
			},
		});
		const missing = await readValue(
			"instance('commcaresession')/session/data/missing_id",
		);
		expect(account(missing)).toEqual({
			findings: [
				"expressions-and-data/session-data-datum-the-entry-does-not-supply @form",
			],
			defects: 0,
		});
	});
});

describe("an advanced form's display condition reading the case", () => {
	it("is HQ's filtering without case where every load auto-selects, and reads where a load is chosen", async () => {
		const { doc } = memberFollowup();
		const filter = "#case/age = 1";
		const autoSelected = await readEdited(doc, {
			modules: (modules) => {
				const form = underTest(modules);
				const loads = form.actions.load_update_cases;
				const own = loads[loads.length - 1] as Json;
				own.auto_select = {
					doc_type: "AutoSelectCase",
					mode: "raw",
					value_source: "",
					value_key: "instance('commcaresession')/session/data/member_id",
				};
				own.details_module = null;
				form.actions.load_update_cases = [own];
				form.form_filter = filter;
				return modules;
			},
		});
		expect(account(autoSelected).findings.sort()).toEqual(
			[
				`${F}/a-display-condition-reading-case-user-casedb-with-no-non-auto @form`,
				`${F}/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the @form`,
			].sort(),
		);
		const chosen = await readEdited(doc, {
			modules: (modules) => {
				underTest(modules).form_filter = filter;
				return modules;
			},
		});
		expect(account(chosen)).toEqual({
			findings: [],
			defects: 0,
		});
	});
});

describe("an open action naming its question itself", () => {
	it("reads as the open action Nova writes over the question's trimmed sibling", async () => {
		const { doc } = memberFollowup([
			{
				uuid: OP("kid"),
				id: "visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read("name"),
				links: [],
			},
		]);
		const nova = await readEdited(doc, {});
		expect(account(nova)).toEqual({ findings: [], defects: 0 });
		const named = await readEdited(doc, {
			modules: (modules) => {
				for (const open of underTest(modules).actions.open_cases) {
					const name = open.name_update as Json;
					name.question_path = "/data/name";
				}
				return modules;
			},
		});
		expect(account(named).findings).not.toContain(
			"unrecognized schema:AdvancedForm.actions @form",
		);
	});
});
