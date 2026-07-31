import { describe, expect, it } from "vitest";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { makeCanonicalGenesisDoc } from "../../__tests__/fixtures";
import { makeCaseListDoc } from "../case-list-config/__tests__/fixtures";
import { makeCaseSearchDoc } from "../case-search-config/__tests__/fixtures";
import { makeMediaDoc } from "../media/__tests__/fixtures";

/**
 * Shared tool fixtures are persisted-state seeds, not partial builders. Pin
 * them through the same absolute gate every mutating tool uses so an unrelated
 * tool test cannot start failing (or pass vacuously) when validation tightens.
 */
describe("shared agent-tool fixture validity", () => {
	for (const [name, makeDoc] of [
		["canonical genesis", makeCanonicalGenesisDoc],
		["case-list tools", makeCaseListDoc],
		["case-search tools", makeCaseSearchDoc],
		["media tools", makeMediaDoc],
	] as const) {
		it(`${name} is a complete valid persisted seed`, () => {
			const verdict = mutationCommitVerdict(
				makeDoc(),
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(
				verdict.ok ? [] : verdict.findings.map((finding) => finding.code),
			).toEqual([]);
		});
	}
});
