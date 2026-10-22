/**
 * The reference edges of the instance reads, and the gate refusals they let
 * an edit elsewhere reach.
 *
 * A read of what a search found is indexed under the module whose search
 * supplies it. For a search-first form that is the form's own module, and a
 * link condition evaluates in its source form's entry, so it is that same
 * module (`referenceIndex.ts::expressionEdges`). An edit that withdraws the
 * search therefore re-checks the read and is refused naming it.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	INSTANCE_READS,
	instanceReadFixture,
	searchFound,
} from "@/lib/commcare/__tests__/instanceReadFixture";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { referencingSlotsOf } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	entityTargetKey,
	proseText,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { gt, literal, term } from "@/lib/domain/expression";

function fieldUuid(doc: BlueprintDoc, id: string, formUuid: Uuid): Uuid {
	const field = Object.values(doc.fields).find(
		(field) => field.id === id && doc.fieldParent[field.uuid] === formUuid,
	);
	if (field === undefined) throw new Error(`No field ${id}`);
	return field.uuid;
}

function slots(doc: BlueprintDoc, target: Uuid) {
	return Object.fromEntries(referencingSlotsOf(doc, entityTargetKey(target)));
}

describe("the instance reads' reference edges", () => {
	const { doc } = instanceReadFixture();

	it("indexes what the search found under the module whose search supplies it", () => {
		expect(slots(doc, INSTANCE_READS.searchModule)).toMatchObject({
			[fieldUuid(doc, "found", INSTANCE_READS.searchForm)]: ["calculate"],
			[INSTANCE_READS.searchForm]: expect.arrayContaining([
				"form_link_condition",
			]),
		});
	});

	it("indexes the chosen cases under their several-case module", () => {
		expect(slots(doc, INSTANCE_READS.batchModule)).toMatchObject({
			[fieldUuid(doc, "chosen", INSTANCE_READS.batchForm)]: ["calculate"],
		});
	});

	it("indexes a choice's label and a question's text under the question", () => {
		expect(slots(doc, INSTANCE_READS.color)).toMatchObject({
			[fieldUuid(doc, "color_label", INSTANCE_READS.visitForm)]: ["calculate"],
			[fieldUuid(doc, "color_text", INSTANCE_READS.visitForm)]: ["calculate"],
		});
	});
});

const PATIENTS = testUuid("search-reads-patients");
const FIND = testUuid("search-reads-find");
const CHECK_IN = testUuid("search-reads-check-in");
const NOTE = testUuid("search-reads-note");

/** A search-first module whose follow-up form and its link read what the
 * search found, beside an ordinary module of the same case type. */
function searchReadDoc(): BlueprintDoc {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	return buildDoc({
		appName: "Search reads",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "district", label: proseText("District") },
				],
			},
		],
		modules: [
			{
				uuid: PATIENTS,
				name: "Patients",
				caseType: "patient",
				caseListConfig: list(),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "patient_name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: FIND,
				name: "Find patient",
				caseType: "patient",
				caseListConfig: {
					...list(),
					searchInputs: [
						simpleSearchInputDef(
							testUuid("search-reads-district"),
							"district",
							"District",
							"text",
							"district",
						),
					],
				},
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: CHECK_IN,
						name: "Check in",
						type: "followup",
						postSubmit: "module",
						fields: [
							f({ kind: "hidden", id: "found", calculate: searchFound() }),
						],
						formLinks: [
							{
								condition: gt(searchFound(), term(literal(1))),
								target: { type: "form", moduleUuid: FIND, formUuid: NOTE },
							},
						],
					},
					{
						uuid: NOTE,
						name: "Note",
						type: "followup",
						fields: [f({ kind: "text", id: "words" })],
					},
				],
			},
		],
	});
}

function refusals(mutations: Mutation[]) {
	const verdict = mutationCommitVerdict(
		searchReadDoc(),
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok
		? []
		: verdict.findings.filter(
				(finding) => finding.code === "SEARCH_RESULTS_NOT_SUPPLIED",
			);
}

describe("an edit that withdraws a search its forms read", () => {
	it("commits an edit that keeps the search", () => {
		const verdict = mutationCommitVerdict(
			searchReadDoc(),
			[{ kind: "renameForm", uuid: CHECK_IN, newId: "arrive" }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});

	it("refuses turning Search first off, naming the question and the link", () => {
		expect(
			refusals([
				{
					kind: "updateModule",
					uuid: FIND,
					patch: {},
					caseSearchConfigPatch: { searchFirst: null },
				},
			]).map((finding) => finding.details?.reason),
		).toEqual(["not-search-first", "link-source"]);
	});

	it("refuses moving the form out of the search-first module", () => {
		expect(
			refusals([
				{
					kind: "moveForm",
					uuid: CHECK_IN,
					toModuleUuid: PATIENTS,
					after: null,
				},
			]).length,
		).toBeGreaterThan(0);
	});

	it("refuses adding a registration form with the Search first it withdraws", () => {
		// A registration menu form leaves the module no case-first entry
		// (`SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`), so the batch that adds
		// one also turns Search first off.
		expect(
			refusals([
				{
					kind: "addForm",
					moduleUuid: FIND,
					form: {
						uuid: testUuid("search-reads-register"),
						id: "register_here",
						name: "Register here",
						type: "registration",
					},
				},
				{
					kind: "updateModule",
					uuid: FIND,
					patch: {},
					caseSearchConfigPatch: { searchFirst: null },
				},
			]).map((finding) => finding.details?.reason),
		).toEqual(["not-search-first", "link-source"]);
	});
});
