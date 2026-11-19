/**
 * A searched list filter's clause that reads Search fields under their presence tests stands in
 * the list filter or in an advanced field's condition by one test, `rows.ts::waitsForFields`:
 * whether a device prints it in the list's own filter, its fields unanswered. One it prints
 * nothing for is carried by the search's row alone, wherever it stands; one it prints (a field's
 * presence test under a negation, which a device reads as never there) is a clause of the list.
 *
 * Contract: for each admitted document below, the canonical form prints the export the document
 * prints, byte for byte, and a read back of that export gives the canonical form.
 *
 * Plausible failures: the canonical form moving a list clause a device prints into a field's
 * condition, or a field's condition into the list filter, so it prints another list; the reader
 * placing a row on the list filter that a device then prints there, where the source's list
 * holds no such clause; and the canonical form taking the list filter's clause into a field
 * whose condition holds the same clause, where the reader reads the list's own clause back.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	readBackInput,
	servedExport,
} from "@/lib/deployment/reading/__tests__/novaReading";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import {
	eq,
	input,
	literal,
	prop,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../../validator/runner";
import { canonDocument } from "../../canon";
import { readHqApp } from "../../index";

const ADVANCED = testUuid("device-list-clauses-advanced");
const SIMPLE = testUuid("device-list-clauses-simple");

/** Never true while `field` is answered with `notes` of `a`; a device, which reads no answer in
 *  the list's own filter, prints it as never true. */
const notWhile = (field: typeof ADVANCED): Expression => ({
	kind: "not",
	clause: whenInput(input(field), eq(prop("patient", "notes"), literal("a"))),
});

function searchDoc(
	inputs: SearchInputDef[],
	filter: Expression | undefined,
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...config,
					searchInputs: inputs,
					...(filter === undefined ? {} : { filter }),
				},
				caseSearchConfig: { workflow: "skipToResults" },
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
	rebuildFieldParent(doc);
	return doc;
}

const CASES: readonly { readonly name: string; readonly doc: BlueprintDoc }[] =
	[
		{
			name: "a list clause a device prints, beside the same clause as the advanced field's condition it reads",
			doc: searchDoc(
				[
					{
						uuid: ADVANCED,
						name: "adv",
						label: "Adv",
						kind: "advanced",
						type: "text",
						predicate: notWhile(ADVANCED),
					},
				],
				notWhile(ADVANCED),
			),
		},
		{
			name: "an advanced field's condition a device would print in the list, over a simple field",
			doc: searchDoc(
				[
					{
						uuid: SIMPLE,
						name: "notes",
						label: "Notes",
						kind: "simple",
						type: "text",
						property: "notes",
					},
					{
						uuid: ADVANCED,
						name: "adv",
						label: "Adv",
						kind: "advanced",
						type: "text",
						predicate: notWhile(SIMPLE),
					},
				],
				undefined,
			),
		},
	];

describe("a searched list clause a device prints", () => {
	for (const one of CASES)
		it(one.name, { timeout: 30_000 }, async () => {
			expect(
				runValidation(one.doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
					(error) => error.code,
				),
			).toEqual([]);
			const canon = canonDocument(one.doc);
			expect(servedExport(canon).body).toEqual(servedExport(one.doc).body);
			const served = servedExport(one.doc);
			const back = readHqApp(await readBackInput(one.doc, served));
			expect(back.defects).toEqual([]);
			if (back.kind !== "read")
				throw new Error(
					`The read back is an account: ${JSON.stringify(back.findings)}`,
				);
			const { declaration } = back.draft;
			expect(
				readBackDifferences(canon, {
					doc: back.draft.doc,
					choices: declaration.kind === "choices" ? declaration.choices : [],
				}),
			).toEqual([]);
		});
});
