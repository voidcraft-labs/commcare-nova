/**
 * `diffDocsToMutations` replays the case-type catalog's tail of its batch on
 * top of the structural replay it already made, rather than replaying the
 * whole batch again from the start. Held here: over the documents the oracle
 * corpora draw, each built from the empty one and from an earlier state of
 * itself (its construction batch cut short), the
 * catalog mutations of a diff stand in one run after the structural ones,
 * and that run applied on top of the structural part's document is the
 * whole joined batch's document, compared as ordered JSON, derived parts and
 * key order included.
 *
 * A plausible failure: a batch-level step of the reducer (the translation
 * prune, the English-only collapse, the parent index, the menus placed
 * above) that the catalog tail meets differently on its own, which would give
 * the after-submit residual or the localization diff another base.
 */
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { advancedDocArbitrary } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { menuScreenDocArbitrary } from "@/lib/commcare/__tests__/menuScreenDocArbitrary";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain/blueprint";

const CATALOG_KINDS: ReadonlySet<Mutation["kind"]> = new Set([
	"declareCaseType",
	"setCaseTypeMeta",
	"addCaseProperty",
	"setCaseProperty",
	"removeCaseProperty",
	"retireCaseType",
]);

/** Every own enumerable key in its order, a Map's and a Set's entries in theirs. */
function orderedJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner instanceof Map
			? { map: [...inner] }
			: inner instanceof Set
				? { set: [...inner] }
				: inner,
	);
}

/** The draw as stored, so its batch is the wire's. */
function stored(draw: BlueprintDoc): BlueprintDoc {
	return hydratePersistedBlueprint(
		JSON.parse(JSON.stringify(toPersistableDoc(draw))),
	);
}

function replayed(doc: BlueprintDoc, batch: readonly Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, admitMutationBatch(batch));
	});
}

/** The structural part's replay with the catalog run on top, held to the whole. */
function holdsCatalogTail(prev: BlueprintDoc, next: BlueprintDoc): boolean {
	const batch = diffDocsToMutations(prev, next);
	const at = batch.map((mutation) => CATALOG_KINDS.has(mutation.kind));
	const first = at.indexOf(true);
	if (first < 0) return false;
	const end = at.indexOf(false, first);
	const last = end < 0 ? batch.length : end;
	/* One run: no catalog mutation after the first non-catalog one past it. */
	expect(at.slice(last).includes(true)).toBe(false);
	const structural = batch.slice(0, first);
	const catalog = batch.slice(first, last);
	if (structural.length === 0) return false;
	expect(orderedJson(replayed(replayed(prev, structural), catalog))).toBe(
		orderedJson(replayed(prev, [...structural, ...catalog])),
	);
	return true;
}

const corpora = [
	["suite", suiteDocArbitrary],
	["menu screens", menuScreenDocArbitrary],
	["advanced menus", advancedDocArbitrary],
	["field trees", blueprintDocArbitrary],
] as const;

describe("a diff's catalog tail replayed on its structural part", () => {
	it.each(corpora)(
		"is the whole batch's replay for a %s document built from the empty one and from an earlier state",
		async (_name, arbitrary) => {
			let held = 0;
			await fc.assert(
				fc.property(arbitrary, fc.nat(), (draw, cut) => {
					const next = stored(draw);
					const empty = emptyBlueprintDoc(next.appId);
					if (holdsCatalogTail(empty, next)) held += 1;
					/* An earlier state of the same app: its construction batch cut
					 * short, so the diff to the whole one adds what the cut left. */
					const batch = diffDocsToMutations(empty, next);
					const earlier = replayed(
						empty,
						batch.slice(0, cut % (batch.length + 1)),
					);
					if (holdsCatalogTail(earlier, next)) held += 1;
				}),
				{ numRuns: 25, seed: 20261116 },
			);
			expect(held).toBeGreaterThan(0);
		},
		60_000,
	);
});
