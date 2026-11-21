/**
 * Content no export holds is left out in exactly one place: inside an entity
 * the comparison compares, by a `not-carried` row of the canonical form, or
 * as a whole kind, by the read-back comparison.
 *
 * Contract: no `not-carried` row of `CANONICALIZATIONS` changes anything of a
 * kind `KINDS_WITH_NO_EXTERNAL_KEY` names; every key of Nova's document
 * schema is either one that list's kinds live in or one where a planted
 * change shows as a difference of `readBackDifferences`; and the content each
 * `not-carried` row removes shows as a difference when the row is left out.
 *
 * Plausible failures: a kind compared by nothing and named nowhere, which a
 * read back would pass over; content one mechanism removes and the other
 * also skips; a row that reaches into a kind the comparison already leaves
 * out, so it removes nothing a comparison would see.
 */

import { describe, expect, it } from "vitest";
import {
	hydrated,
	publishedCorpus,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { CANONICALIZATIONS } from "@/lib/commcare/reader/canon";
import { documentDifferences } from "@/lib/doc/documentDifferences";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { KEYS_WITH_NO_EXTERNAL_KEY, readBackDifferences } from "../readBack";
import {
	everyKindDocument,
	sortNamedHiddenColumnDocument,
	surveyListDocument,
	unexportedTextDocument,
	unprintedGuardDocument,
	worldDocument,
} from "./readBackDocument";

const NOT_CARRIED = CANONICALIZATIONS.filter(
	(row) => row.kind === "not-carried",
);

/** The keys of the kinds no wire carries, as `doc` stores them. */
function keptOut(doc: BlueprintDoc): unknown {
	const stored = toPersistableDoc(doc) as Record<string, unknown>;
	return Object.fromEntries(
		[...KEYS_WITH_NO_EXTERNAL_KEY].map((key) => [key, stored[key]]),
	);
}

/**
 * Every document the proof lane publishes, a case app that holds every kind
 * no wire carries, a survey holding a model's translation and a
 * validation message no condition can fail, a list naming a column
 * hidden from both screens in Sort by under another text than its header,
 * a menu that lists no cases holding a list of its own, and a searched menu
 * holding a translation of a search guard sentence none of its fields carries.
 */
function documents(): { readonly id: string; readonly doc: BlueprintDoc }[] {
	return [
		...publishedCorpus().map((document) => ({
			id: document.id,
			doc: hydrated(document),
		})),
		{ id: "world", doc: worldDocument() },
		{ id: "unexported-text", doc: unexportedTextDocument() },
		{ id: "sort-named-hidden-column", doc: sortNamedHiddenColumnDocument() },
		{ id: "survey-list", doc: surveyListDocument() },
		{ id: "unprinted-search-guard", doc: unprintedGuardDocument() },
	];
}

describe("the content no export holds", () => {
	it("lists the rows it judges", () => {
		expect(NOT_CARRIED.map((row) => row.id).sort()).toEqual(
			[
				"app-logo-is-absent",
				"columns-of-a-menu-that-lists-no-cases-are-its-one-name-column",
				"menu-and-form-ids-as-read",
				"organization-levels-as-read",
				"purpose-notes-are-absent",
				"sort-named-hidden-column-header-is-its-name",
				"tile-columns-shown-nowhere-are-as-read",
				"translation-provenance-is-read-as-reviewed",
				"unprinted-search-guard-translations-are-absent",
				"validation-message-with-no-condition-is-absent",
				"world-properties-as-read",
			].sort(),
		);
	});

	it("is removed by no row inside a kind the comparison leaves out", {
		timeout: 120_000,
	}, () => {
		// The case app holds an entity of every kind no wire carries.
		expect(
			Object.values(keptOut(worldDocument()) as Record<string, unknown>),
		).not.toContain(undefined);
		for (const { id, doc } of documents())
			for (const row of NOT_CARRIED)
				expect(keptOut(row.apply(doc)), `${row.id} over ${id}`).toEqual(
					keptOut(doc),
				);
	});

	it("is compared at every key of the document but those of a kind no wire carries", () => {
		const doc = everyKindDocument();
		const keys = Object.keys(
			blueprintDocSchema.shape,
		) as (keyof BlueprintDoc)[];
		for (const key of KEYS_WITH_NO_EXTERNAL_KEY) expect(keys).toContain(key);
		for (const key of keys) {
			const planted = {
				...doc,
				[key]: { planted: true },
			} as unknown as BlueprintDoc;
			const differences = readBackDifferences(doc, {
				doc: planted,
				choices: null,
			});
			if (KEYS_WITH_NO_EXTERNAL_KEY.has(key))
				expect(differences, key).toEqual([]);
			else expect(differences.length, key).toBeGreaterThan(0);
		}
	});

	it("shows as a difference where its row is left out", {
		timeout: 120_000,
	}, () => {
		const witnessed = new Set<string>();
		for (const { doc } of documents())
			for (const row of NOT_CARRIED) {
				const removed = row.apply(doc);
				const differences = readBackDifferences(removed, {
					doc,
					choices: null,
				});
				// A row that changes nothing of this document removes nothing here.
				if (documentDifferences(doc, removed).length === 0) continue;
				expect(differences.length, row.id).toBeGreaterThan(0);
				witnessed.add(row.id);
			}
		expect([...witnessed].sort()).toEqual(
			NOT_CARRIED.map((row) => row.id).sort(),
		);
	});
});
