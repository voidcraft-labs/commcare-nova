/**
 * A repeat workers add entries to, inside a group shown on one screen, at the
 * commit gate.
 *
 * A group holding `fieldList` is written `appearance="field-list"`, and
 * CommCare's form entry collects a field-list host's questions onto one
 * screen while skipping `EVENT_PROMPT_NEW_REPEAT`
 * (`FormEntryController.getQuestionPrompts`), so a worker can never add an
 * entry to a user-controlled repeat anywhere inside one. HQ's form builder
 * refuses the same repeat a blank count under a `FieldList`
 * (`Vellum/src/mugs/types/group.js`, "Repeat Count is required."). Count and
 * query repeats make their rows without the worker, so they stay admitted.
 *
 * Plausible failures: the refusal missed two levels down, a count or query
 * repeat refused, both a section's and a group's finding raised for one
 * repeat, or turning the flag on over an existing repeat committed.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, Field } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import type { Uuid } from "@/lib/domain/uuid";
import type { ValidationError } from "../errors";

const ids = {
	form: testUuid("field-list-repeat-form"),
	outer: testUuid("field-list-repeat-outer"),
	inner: testUuid("field-list-repeat-inner"),
	section: testUuid("field-list-repeat-section"),
	repeat: testUuid("field-list-repeat-repeat"),
	child: testUuid("field-list-repeat-child"),
};

/** A query whose rows are two fixed record ids. */
const twoVisits: Expression = term(literal("first second"));

const text = (id: string, uuid?: string): FieldSpec =>
	f({ kind: "text", id, label: proseText(id), ...(uuid && { uuid }) });

/** A follow-up form whose fields are `fields`. */
function formDoc(fields: FieldSpec[]): BlueprintDoc {
	return buildDoc({
		appName: "Visits",
		caseTypes: [
			{ name: "visit", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ uuid: ids.form, name: "Review", type: "followup", fields }],
			},
		],
	});
}

/** `household` (holding `fieldList` when `flagged`) around the group
 * `members`, around `inside`. */
function nestedGroups(flagged: boolean, inside: FieldSpec[]): FieldSpec {
	return f({
		kind: "group",
		id: "household",
		uuid: ids.outer,
		label: proseText("Household"),
		...(flagged && { fieldList: true }),
		children: [
			f({
				kind: "group",
				id: "members",
				uuid: ids.inner,
				label: proseText("Members"),
				children: [text("note"), ...inside],
			}),
		],
	});
}

/** Adds `repeat` under `parentUuid` with one question inside it. */
function addRepeat(
	parentUuid: Uuid,
	repeat: Record<string, unknown>,
): Mutation[] {
	return [
		{
			kind: "addField",
			parentUuid,
			field: {
				uuid: ids.repeat,
				id: "visits",
				label: proseText("Visits"),
				...repeat,
			} as Field,
		},
		{
			kind: "addField",
			parentUuid: ids.repeat,
			field: {
				kind: "text",
				uuid: ids.child,
				id: "visit_note",
				label: proseText("Note"),
			} as Field,
		},
	];
}

const userControlled = { kind: "repeat", repeat_mode: "user_controlled" };

function findings(doc: BlueprintDoc, mutations: Mutation[]): ValidationError[] {
	expect(mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE).ok).toBe(
		true,
	);
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok ? [] : verdict.findings;
}

const MESSAGE =
	'"Review" has repeat "visits" inside "Household", which shows its questions on one screen, and that repeat lets the worker add entries. The CommCare app can\'t add entries on a shared screen. You can let "Household" show one question per screen, or give the repeat a fixed count.';

describe("FIELD_LIST_USER_REPEAT at the commit gate", () => {
	it("refuses a user repeat added two levels down in a field-list group", () => {
		const [finding, ...rest] = findings(
			formDoc([nestedGroups(true, [])]),
			addRepeat(ids.inner, userControlled),
		);
		expect(rest).toEqual([]);
		expect(finding?.code).toBe("FIELD_LIST_USER_REPEAT");
		expect(finding?.message).toBe(MESSAGE);
		expect(finding?.location).toMatchObject({
			formUuid: ids.form,
			fieldUuid: ids.repeat,
			fieldId: "visits",
		});
		expect(finding?.details).toMatchObject({
			groupUuid: ids.outer,
			groupId: "household",
		});
		if (finding === undefined) throw new Error("No finding.");
		expect(userFacingError(finding)).toBe(MESSAGE);
	});

	it.each([
		{
			mode: "count",
			repeat: {
				kind: "repeat",
				repeat_mode: "count_bound",
				repeat_count: term(literal(2)),
			},
		},
		{
			mode: "query",
			repeat: {
				kind: "repeat",
				repeat_mode: "query_bound",
				data_source: { ids_query: twoVisits },
			},
		},
	])("admits a $mode repeat in the same place", ({ repeat }) => {
		expect(
			findings(formDoc([nestedGroups(true, [])]), addRepeat(ids.inner, repeat)),
		).toEqual([]);
	});

	it("admits a user repeat in a labelled group without the flag", () => {
		expect(
			findings(
				formDoc([nestedGroups(false, [])]),
				addRepeat(ids.inner, userControlled),
			),
		).toEqual([]);
	});

	it("lets only the section speak for a repeat under a section and a field-list group", () => {
		const doc = formDoc([
			f({
				kind: "section",
				id: "page",
				uuid: ids.section,
				label: proseText("Page"),
				children: [nestedGroups(true, [])],
			}),
		]);
		expect(
			findings(doc, addRepeat(ids.inner, userControlled)).map(
				(finding) => finding.code,
			),
		).toEqual(["FORM_SECTION_USER_REPEAT"]);
	});

	it("refuses turning fieldList on over a group holding a user repeat", () => {
		const doc = formDoc([
			nestedGroups(false, [
				f({
					...userControlled,
					id: "visits",
					uuid: ids.repeat,
					label: proseText("Visits"),
					children: [text("visit_note", ids.child)],
				} as FieldSpec),
			]),
		]);
		const refused = findings(doc, [
			{
				kind: "updateField",
				uuid: ids.outer,
				targetKind: "group",
				patch: { fieldList: true },
			},
		]);
		expect(refused.map((finding) => finding.code)).toEqual([
			"FIELD_LIST_USER_REPEAT",
		]);
		expect(refused[0]?.message).toBe(MESSAGE);
	});
});
