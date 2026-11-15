/**
 * The app strings a reading hands the reader: Nova's own build of a
 * document, asked only where Nova's gate admits the document.
 *
 * The plausible failures are a reading that throws inside Nova's build for a
 * document a finding left provisional (the build's oracles throw for what
 * the gate refuses), and a key classified against the strings of a document
 * Nova would never write. Each arm runs the production gate
 * (`mutationCommitVerdict` with an empty batch) over corpus documents Nova's
 * publish admits (`lib/commcare/reader/__tests__/publishedDocuments.ts`).
 */

import { describe, expect, it } from "vitest";
import { localAppStringTable } from "@/lib/commcare/appStrings";
import {
	hydrated,
	publishedCorpus,
	publishRefuses,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import {
	extractLookupReferenceTargets,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { type CorpusDocument, lookupContextOf } from "@/proof/corpus/documents";
import { readingAppStrings } from "../appStrings";

interface Admitted {
	readonly document: CorpusDocument;
	readonly doc: BlueprintDoc;
}

const corpus: readonly Admitted[] = publishedCorpus().flatMap((document) => {
	const doc = hydrated(document);
	return publishRefuses(document, doc) ? [] : [{ document, doc }];
});

function contextWith(
	document: CorpusDocument,
	definitions: readonly LookupTableDefinition[],
): LookupValidationContext {
	const context = lookupContextOf(document.lookup);
	if (context.kind !== "available")
		throw new Error(`${document.id} holds lookup data.`);
	return { ...context, definitions };
}

/** Two sibling questions of one form: the root's first two fields that hold
 *  no fields of their own. */
function siblingQuestions(
	doc: BlueprintDoc,
): readonly [Uuid, Uuid] | undefined {
	for (const formUuid of Object.keys(doc.forms)) {
		const leaves = (doc.fieldOrder[formUuid as Uuid] ?? []).filter(
			(uuid) => doc.fieldOrder[uuid] === undefined,
		);
		const [first, second] = leaves;
		if (first !== undefined && second !== undefined) return [first, second];
	}
	return undefined;
}

describe("readingAppStrings", () => {
	it("answers a document's local app strings under its own lookup context", {
		timeout: 120_000,
	}, () => {
		expect(corpus.length).toBeGreaterThan(10);
		for (const { document, doc } of corpus) {
			const context = lookupContextOf(document.lookup);
			expect(readingAppStrings(context)(doc), document.id).toEqual(
				localAppStringTable(
					doc,
					context.kind === "available" ? context.definitions : [],
				),
			);
		}
	});

	it("answers null for a document whose question takes its sibling's id, and does not throw", () => {
		const found = corpus.flatMap(({ document }) => {
			const doc = hydrated(document);
			const pair = siblingQuestions(doc);
			return pair === undefined ? [] : [{ document, doc, pair }];
		})[0];
		if (found === undefined)
			throw new Error("The corpus holds a form with two sibling questions.");
		const { document, doc, pair } = found;
		const [first, second] = pair;
		const sibling = doc.fields[second];
		const question = doc.fields[first];
		if (question === undefined || sibling === undefined)
			throw new Error(`${document.id} holds both questions.`);
		doc.fields[first] = { ...question, id: sibling.id };
		const context = lookupContextOf(document.lookup);
		expect(readingAppStrings(context)(doc)).toBeNull();
		/* Nova's build of that document, asked without the gate, throws. */
		expect(() =>
			localAppStringTable(
				doc,
				context.kind === "available" ? context.definitions : [],
			),
		).toThrow();
	});

	it("answers null where the context lacks a table the document reads, and the table where the context holds it beside one nothing reads", () => {
		const reading = corpus.filter(
			({ doc }) => extractLookupReferenceTargets(doc).tableIds.length > 0,
		);
		expect(reading.length).toBeGreaterThan(0);
		for (const { document, doc } of reading) {
			const read = new Set<string>(extractLookupReferenceTargets(doc).tableIds);
			const all = document.lookup?.definitions ?? [];
			const referenced = all.filter((table) => read.has(table.id));
			const [lacking] = referenced;
			if (lacking === undefined)
				throw new Error(`${document.id} defines the tables it reads.`);
			expect(
				readingAppStrings(
					contextWith(
						document,
						referenced.filter((table) => table.id !== lacking.id),
					),
				)(doc),
				document.id,
			).toBeNull();
			const unread: LookupTableDefinition = {
				...lacking,
				id: lookupTableIdSchema.parse("01890a5d-ac96-774b-bcce-b302099a8057"),
				name: "Nothing reads this",
				tag: "nothing_reads_this",
			};
			const answer = readingAppStrings(
				contextWith(document, [...referenced, unread]),
			)(doc);
			expect(answer, document.id).not.toBeNull();
			expect(answer, document.id).toEqual(localAppStringTable(doc, referenced));
		}
	});
});
