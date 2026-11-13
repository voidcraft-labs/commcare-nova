/**
 * Every targeted document, and every edit written for one, is one Nova's
 * publish and local export take, as the corpus emission judges it.
 *
 * Contract: the emission leaves out a fixed document or edit only where
 * `proof/corpus/left-out.json` names it, and stops the lane's run otherwise
 * (`../../corpus/emitCorpus.ts::leftOutDifferences`). A targeted document is
 * built to show one symptom, so the publish must take it. The commit gate
 * that admits it (`../build.ts`) sees no lookup row, so a row a publish
 * refuses (a choice value holding a space, a table with no rows) reaches
 * the lane unseen without this. The plausible failures: a document whose
 * Project data Nova's publish refuses, a document Nova's local export
 * refuses, and an edit Nova's publish refuses once it is made over D as
 * its first publish stored it. The observation is the emission's own
 * judgment (`writtenRefusals`, the functions the emission calls) over every
 * targeted document, held to the list as the emission holds it, so a
 * refused document fails here by name with the emission's sentence. The
 * accepted case is every other targeted document, judged alongside; the
 * refused case is a document whose table gives a choice value a space,
 * refused by its finding.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { proseText } from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { DEFAULT_CORPUS_SEED } from "../../corpus/defaults";
import {
	leftOutDifferences,
	leftOutMessage,
	leftOutSchema,
	writtenRefusals,
} from "../../corpus/emitCorpus";
import { targetedDocument, targetedUuid } from "../build";
import { targetedDocuments } from "../index";

const LEFT_OUT = join(
	import.meta.dirname,
	"..",
	"..",
	"corpus",
	"left-out.json",
);

const SPACED = "targeted-spaced-choice";

describe("the targeted documents", () => {
	// Judges every targeted document and its written edit through Nova's
	// publish checks and both exports: a few seconds, more on a shared runner.
	it("are all taken by Nova's publish and local export, and so are the edits written for them, as the corpus emission judges them", async () => {
		const documents = targetedDocuments();
		const ids = new Set(documents.map((document) => document.id));
		const named = leftOutSchema.parse(
			JSON.parse(await readFile(LEFT_OUT, "utf8")),
		);
		const differences = leftOutDifferences(
			await writtenRefusals(documents, DEFAULT_CORPUS_SEED),
			{
				documents: named.documents.filter((entry) => ids.has(entry.id)),
				edits: named.edits.filter((entry) => ids.has(entry.id)),
			},
		);
		expect(differences.map(leftOutMessage)).toEqual([]);
	}, 30_000);
});

describe("a targeted document", () => {
	it("is refused by the emission, by its finding, where its table gives a choice value a space", async () => {
		const table = wireTable("clinics", [{ name: "name", type: "text" }]);
		const [name] = table.columns;
		if (name === undefined) throw new Error("The clinics table has no name.");
		const document = targetedDocument({
			id: SPACED,
			rows: ["a choice value holding a space"],
			doc: buildDoc({
				appId: SPACED,
				appName: "Clinics",
				modules: [
					{
						uuid: targetedUuid(SPACED, "clinics"),
						name: "Clinics",
						forms: [
							{
								uuid: targetedUuid(SPACED, "pick"),
								name: "Pick",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										uuid: targetedUuid(SPACED, "clinic"),
										id: "clinic",
										label: proseText("Clinic"),
										optionsSource: {
											kind: "lookup",
											tableId: table.id,
											valueColumnId: name.id,
											labelColumnId: name.id,
										},
									}),
								],
							},
						],
					},
				],
			}),
			lookup: {
				projectId: `project-${SPACED}`,
				projectRevision: parseLookupRevision("1"),
				definitions: [table],
				rowsByTable: new Map([
					[table.id, [wireRow(table, "north", { name: "North clinic" })]],
				]),
			},
			expected: { intent: [] },
		});
		const { refused, editsRefused } = await writtenRefusals(
			[document],
			DEFAULT_CORPUS_SEED,
		);
		expect(refused.map(({ id, by, codes }) => ({ id, by, codes }))).toEqual([
			{
				id: SPACED,
				by: "publish",
				codes: ["LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE"],
			},
		]);
		expect(editsRefused).toEqual([]);
	});
});
