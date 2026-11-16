/**
 * A batch of app-level scalars alone (the app's name, logo, settings and
 * Connect type) skips the three whole-document admission indexes in
 * `commitVerdicts.ts::prepareMutationCandidate`. Held here: over the
 * documents the oracle corpora draw, drafts and frozen documents alike, the
 * identity, sequence and target admissions find no issue in any such batch,
 * and the candidate the shortcut prepares is the one the plain admission
 * path would apply.
 *
 * A plausible failure: one of the admissions comes to read an app scalar (a
 * logo naming an asset the document must hold, a settings key that moves a
 * sequence) and refuses a batch the shortcut admits.
 */
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { advancedDocArbitrary } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { menuScreenDocArbitrary } from "@/lib/commcare/__tests__/menuScreenDocArbitrary";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import {
	APP_SCALAR_MUTATION_KINDS,
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { mutationIdentityAdmissionIssue } from "@/lib/doc/mutationIdentityAdmission";
import { mutationSequenceAdmissionIssue } from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain/blueprint";

const appScalarArbitrary: fc.Arbitrary<Mutation> = fc.oneof(
	fc
		.string({ maxLength: 12 })
		.map((name): Mutation => ({ kind: "setAppName", name })),
	fc.constantFrom("web-apps", "android", null).map(
		(runsOnlyOn): Mutation => ({
			kind: "setAppSettings",
			settings: { runsOnlyOn },
		}),
	),
	fc
		.record({ showSavedForms: fc.boolean(), showIncompleteForms: fc.boolean() })
		.map((settings): Mutation => ({ kind: "setAppSettings", settings })),
	fc
		.constantFrom("learn", "deliver", null)
		.map((connectType): Mutation => ({ kind: "setConnectType", connectType })),
	fc.constant<Mutation>({ kind: "setAppLogo", logo: null }),
);

const corpora = [
	["suite", suiteDocArbitrary],
	["menu screens", menuScreenDocArbitrary],
	["advanced menus", advancedDocArbitrary],
] as const;

describe("a batch of app-level scalars alone", () => {
	it("is every kind the shortcut names, and only those", () => {
		expect([...APP_SCALAR_MUTATION_KINDS].sort()).toEqual([
			"setAppLogo",
			"setAppName",
			"setAppSettings",
			"setConnectType",
		]);
	});

	it.each(corpora)(
		"passes identity, sequence and target admission over a %s document, draft or frozen",
		async (_name, arbitrary) => {
			await fc.assert(
				fc.property(
					arbitrary,
					fc.array(appScalarArbitrary, { minLength: 1, maxLength: 4 }),
					(drawn, batch) => {
						const frozen = produce(drawn, () => {});
						for (const doc of [drawn, frozen] as BlueprintDoc[]) {
							expect(
								mutationIdentityAdmissionIssue(doc, batch),
							).toBeUndefined();
							expect(
								mutationSequenceAdmissionIssue(doc, batch),
							).toBeUndefined();
							expect(mutationTargetsInvalid(doc, batch)).toBe(false);
						}
						const prepared = prepareMutationCandidate(
							frozen,
							admitMutationBatch(batch),
						);
						expect(preparedCandidateHasAdmissionIssue(prepared)).toBe(false);
						expect(prepared.nextDoc).toEqual(
							produce(frozen, (draft) => {
								applyMutations(draft, admitMutationBatch(batch));
							}),
						);
					},
				),
				{ numRuns: 30, seed: 20261116 },
			);
		},
		60_000,
	);
});
