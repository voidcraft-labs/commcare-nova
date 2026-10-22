/**
 * The lift over the lane's corpus (part 09 §15): each corpus fixture,
 * captured from its document at pull request 2's head, lifts to exactly the
 * document the head corpus source builds today, or differs only by a class
 * of §5 listed for it below. Every admitted head document of the corpus is a
 * fixed point of the transform, and every expression it stores survives its
 * own print, which is the writer's postcondition (§10).
 *
 * The plausible failures are a lift that stores a different tree than an
 * author writing the same text at the head would (a binding, a spelling, a
 * choice), a step that rewrites a document already in the head shape, and a
 * round-trip guard that refuses an admitted expression, which would block a
 * real app for no defect. The head documents come from the corpus's own
 * builders, never from the transform.
 */

import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import {
	type CorpusDocument,
	lookupContextOf,
} from "../../../../proof/corpus/documents";
import { producerDocuments } from "../../../../proof/corpus/producers";
import { targetedDocuments } from "../../../../proof/targeted/index";
import { roundTripFailures, transformApp } from "../transform";
import {
	carriersOfDoc,
	derivedCaseSchemas,
	fixtureCarriers,
	fixtureContext,
	MANIFEST,
} from "./transformHarness";

const CORPUS: ReadonlyMap<string, CorpusDocument> = new Map(
	[...producerDocuments(), ...targetedDocuments()].map((entry) => [
		entry.id,
		entry,
	]),
);

/**
 * The paths at which each corpus fixture's lift may differ from the head
 * build, by the §5 class that explains each. Every fixture lifts exactly.
 */
const LIFT_DIFFERENCES: Readonly<Record<string, readonly string[]>> = {
	arithmetic: [],
	"container-query-conditional-relative": [],
	"form-link-manual": [],
	"targeted-datetime-ordering": [],
};

/** Every path at which two JSON trees differ, leaves first. */
function differences(a: unknown, b: unknown, path = ""): string[] {
	if (canonicalJsonText(a) === canonicalJsonText(b)) return [];
	if (
		a !== null &&
		b !== null &&
		typeof a === "object" &&
		typeof b === "object" &&
		Array.isArray(a) === Array.isArray(b)
	) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		return [...keys].flatMap((key) =>
			differences(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
				`${path}/${key}`,
			),
		);
	}
	return [path];
}

const corpusFixtures = MANIFEST.filter((fixture) => fixture.kind === "corpus");

describe("the lift over the corpus fixtures", () => {
	it("lists every corpus fixture", () => {
		expect(corpusFixtures.map((fixture) => fixture.id).sort()).toEqual(
			Object.keys(LIFT_DIFFERENCES).sort(),
		);
	});

	it.each(corpusFixtures.map((fixture) => fixture.id))(
		"%s lifts to the head corpus source's own build of its document",
		(id) => {
			const fixture = corpusFixtures.find((entry) => entry.id === id);
			const head = CORPUS.get(fixture?.source.document ?? "");
			if (fixture === undefined || head === undefined)
				throw new Error(`The corpus builds no document ${id}`);
			const result = transformApp(fixtureCarriers(id), {
				...fixtureContext(fixture),
				appId: head.doc.appId,
				lookupContext: lookupContextOf(head.lookup),
			});
			expect(result.blockers).toEqual([]);
			expect(differences(result.target, head.doc)).toEqual(
				LIFT_DIFFERENCES[id],
			);
		},
	);
});

describe("the admitted head corpus", () => {
	const documents = [...CORPUS.values()];

	it("is a fixed point of the transform", () => {
		expect(documents.length).toBeGreaterThan(100);
		const moved: string[] = [];
		for (const entry of documents) {
			const doc: PersistableDoc = entry.doc;
			const result = transformApp(carriersOfDoc(doc), {
				appId: doc.appId,
				projectId: "project-corpus",
				lookupContext: lookupContextOf(entry.lookup),
				mediaAssets: new Map(),
				storedCaseSchemas: derivedCaseSchemas(doc),
				storedCaseKeys: new Map(),
			});
			const lifted = result.blockers.filter(
				// Media bytes are the lane's; this run reads no manifest.
				(blocker) => blocker.code !== "target-export-readiness",
			);
			if (
				lifted.length > 0 ||
				result.changes.length > 0 ||
				result.schemaChanges.length > 0 ||
				differences(result.target, doc).length > 0
			)
				moved.push(entry.id);
		}
		expect(moved).toEqual([]);
	});

	it("holds every stored expression to its own print", () => {
		const failing = documents.filter(
			(entry) =>
				roundTripFailures(hydratePersistedBlueprint(entry.doc), {
					lookup: lookupContextOf(entry.lookup),
				}) > 0,
		);
		expect(failing.map((entry) => entry.id)).toEqual([]);
	});
});
