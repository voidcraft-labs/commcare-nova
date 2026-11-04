// The starting values the cutover and the fuzz mapping write for each
// own-case writer of a case-loading form (class C7 of part 01 §22). Catches
// a writer that stops opening with its case's value, a calculated Hidden
// Value given a starting value beside its calculation, and a batch the gate
// would refuse.

import { Immer } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planExplicitPreloads } from "@/lib/doc/explicitPreloads";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { type BlueprintDoc, mutationSchema } from "@/lib/doc/types";
import type { Expression } from "@/lib/domain";

const FUP = testUuid("preloads-followup");
const NOTE = testUuid("preloads-note");
const STAGE = testUuid("preloads-stage");
const TOTAL = testUuid("preloads-total");
const NAME = testUuid("preloads-name");
const UNSAVED = testUuid("preloads-unsaved");

const formCase = (property: string): Expression => ({
	kind: "term",
	term: { kind: "form-case", caseType: "patient", property },
});

/** A follow-up as the old shape stored it: its writers open with no
 *  starting value of their own, but `stage`'s, which the step replaces. */
function fixture(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "note", label: "Note" },
					{ name: "stage", label: "Stage" },
					{ name: "total", label: "Total", data_type: "int" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FUP,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: NOTE,
								kind: "text",
								id: "note",
								caseWrite: { caseType: "patient", property: "note" },
							}),
							f({
								uuid: STAGE,
								kind: "text",
								id: "stage",
								default_value: "'new'",
								caseWrite: { caseType: "patient", property: "stage" },
							}),
							f({
								uuid: TOTAL,
								kind: "hidden",
								id: "total",
								calculate: "1 + 1",
								caseWrite: { caseType: "patient", property: "total" },
							}),
							f({
								uuid: NAME,
								kind: "text",
								id: "renamed",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({ uuid: UNSAVED, kind: "text", id: "unsaved" }),
						],
					},
				],
			},
		],
	});
	for (const uuid of [NOTE, NAME])
		delete (doc.fields[uuid] as { default_value?: Expression }).default_value;
	return doc;
}

const UNFROZEN = new Immer({ autoFreeze: false });

describe("planExplicitPreloads", () => {
	it("gives each listed own-case writer the case's value, replacing its default", () => {
		const doc = fixture();
		const next = UNFROZEN.produce(doc, (draft) => {
			applyMutations(
				draft,
				planExplicitPreloads(doc, FUP, [NOTE, STAGE, NAME]),
			);
		});
		expect(next.fields[NOTE]).toMatchObject({
			default_value: formCase("note"),
		});
		expect(next.fields[STAGE]).toMatchObject({
			default_value: formCase("stage"),
		});
		expect(next.fields[NAME]).toMatchObject({
			default_value: formCase("case_name"),
		});
	});

	it("skips a calculated Hidden Value and a field that saves nothing", () => {
		const doc = fixture();
		expect(planExplicitPreloads(doc, FUP, [TOTAL, UNSAVED])).toEqual([]);
	});

	it("plans nothing for a writer that already opens with the case's value", () => {
		const doc = fixture();
		const next = UNFROZEN.produce(doc, (draft) => {
			applyMutations(draft, planExplicitPreloads(doc, FUP, [STAGE]));
		});
		expect(planExplicitPreloads(next, FUP, [STAGE, STAGE])).toEqual([]);
	});

	it("lands a batch the gate admits", () => {
		const doc = fixture();
		const parsed = planExplicitPreloads(doc, FUP, [NOTE, STAGE, NAME]).map(
			(mutation) => mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		);
		expect(parsed).toHaveLength(3);
		const verdict = mutationCommitVerdict(
			doc,
			parsed,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});
});
