/**
 * The gate's candidate of a reading's declaration choice, made from the
 * construction batch's own candidate (`acceptance.ts::joinedConstructionCandidate`),
 * held to the candidate of the whole joined batch from the empty document,
 * which the birth reduces, over the documents the oracle corpora draw and
 * every choice `planDeclarationChoices` offers for each, the date-and-time
 * split's included.
 *
 * A plausible failure: a batch-level step of the reducer (the translation
 * prune, the English-only collapse, the parent index, the menus placed above,
 * the reference index's batch) or of admission that runs once per batch and
 * so gives the joined batch another document, or another verdict, than the
 * two parts give. The documents are compared as ordered JSON, derived parts
 * and key order included, and the admission verdict as well.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { advancedDocArbitrary } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { menuScreenDocArbitrary } from "@/lib/commcare/__tests__/menuScreenDocArbitrary";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import {
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { planDeclarationChoices } from "@/lib/doc/platformDeclaration";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { joinedConstructionCandidate } from "../acceptance";

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

/** Each corpus, and whether its draws offer the date-and-time split. */
const corpora = [
	["suite", suiteDocArbitrary, true],
	["menu screens", menuScreenDocArbitrary, true],
	["advanced menus", advancedDocArbitrary, true],
	["field trees", blueprintDocArbitrary, false],
] as const;

describe("a declaration choice's candidate from the construction batch's own", () => {
	it.each(corpora)(
		"is the whole joined batch's candidate for every choice of a %s document",
		async (_name, arbitrary, offersSplit) => {
			let joinedChoices = 0;
			let joinedSplits = 0;
			await fc.assert(
				fc.property(arbitrary, fc.boolean(), (draw, webAppsOnInHq) => {
					/* The draw as stored, so its batch is the wire's. */
					const doc: BlueprintDoc = hydratePersistedBlueprint(
						JSON.parse(JSON.stringify(toPersistableDoc(draw))),
					);
					const choices = planDeclarationChoices(doc, { webAppsOnInHq });
					if (choices.kind !== "choices") return;
					const raw = diffDocsToMutations(emptyBlueprintDoc(doc.appId), doc);
					const batch = admitMutationBatch(raw);
					const built = prepareMutationCandidate(
						emptyBlueprintDoc(doc.appId),
						batch,
					);
					for (const choice of choices.choices) {
						const next = admitMutationBatch(choice.mutations);
						const whole = prepareMutationCandidate(
							emptyBlueprintDoc(doc.appId),
							admitMutationBatch([...raw, ...choice.mutations]),
						);
						const joined = joinedConstructionCandidate(built, next);
						if (preparedCandidateHasAdmissionIssue(whole)) {
							expect(joined).toBeUndefined();
							continue;
						}
						if (joined === undefined) continue;
						joinedChoices += 1;
						if (choice.split) joinedSplits += 1;
						expect(preparedCandidateHasAdmissionIssue(joined)).toBe(false);
						expect(orderedJson(joined.nextDoc)).toBe(
							orderedJson(whole.nextDoc),
						);
						expect(joined.mutations).toEqual(whole.mutations);
						expect(joined.results).toEqual(whole.results);
						expect(joined.casePropertyRenamePlan).toEqual(
							whole.casePropertyRenamePlan,
						);
						expect(Object.isFrozen(joined.nextDoc)).toBe(
							Object.isFrozen(whole.nextDoc),
						);
					}
				}),
				{ numRuns: 25, seed: 20261116 },
			);
			/* The joined path is the one held, not one never taken, the
			 * date-and-time split's included. */
			expect(joinedChoices).toBeGreaterThan(0);
			if (offersSplit) expect(joinedSplits).toBeGreaterThan(0);
		},
		60_000,
	);
});
