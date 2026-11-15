/**
 * `readHqApp`, held to the commit gate.
 *
 * Contract: the reader never returns, without a finding, a document the
 * commit gate refuses (`lib/doc/commitVerdicts.ts::mutationCommitVerdict`,
 * under the platform declaration the reading proposes, as acceptance applies
 * the one a person takes). Every whole reading the case management tests make
 * goes through this function, so a reading the gate refuses with no finding
 * fails the test that made it, whatever that test asks of the reading. The
 * targeted and producer documents are held the same way in
 * `caseReadBack.test.ts`, under each document's own declaration.
 *
 * The plausible failure this sweeps for: a reading that holds a shape the gate
 * refuses (a change of a case's type a later change reads as the earlier one,
 * an update of the worker's record on a condition), which a test that asks
 * only for no finding, or only for the operations it reads, passes.
 */
import { expect } from "vitest";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { readHqApp as readHqAppUnheld } from "../../index";
import type { ReaderInput, ReadOutcome } from "../../types";

/** What the commit gate refuses a reading that has no finding on: nothing for
 *  an account, which is the finding. */
export function gateRefusal(
	outcome: ReadOutcome,
	lookup: LookupValidationContext = LOOKUP_CONTEXT_UNAVAILABLE,
): string[] {
	if (outcome.kind !== "read") return [];
	const { declaration } = outcome.draft;
	if (declaration.kind !== "choices")
		return ["the reading offers no declaration its content runs on"];
	const choice = declaration.choices[declaration.proposed];
	const verdict = mutationCommitVerdict(
		outcome.draft.doc,
		choice?.mutations ?? [],
		lookup,
	);
	return verdict.ok
		? []
		: verdict.findings.map((one) => `${one.code}: ${one.message}`);
}

/** `readHqApp`, with the reading's document held to the commit gate. */
export function readHqApp(
	input: ReaderInput,
	options?: Parameters<typeof readHqAppUnheld>[1],
): ReadOutcome {
	// The gate reads a table's read against the project space's definitions;
	// no reading here is told one, so each is held with none.
	if (input.lookup.definitions.size > 0)
		throw new Error(
			"This reading is told lookup tables. Hold it with `gateRefusal` and the lookup context of its tables.",
		);
	const outcome = readHqAppUnheld(input, options);
	expect(
		gateRefusal(outcome),
		"A reading with no finding is a document the commit gate admits.",
	).toEqual([]);
	return outcome;
}
