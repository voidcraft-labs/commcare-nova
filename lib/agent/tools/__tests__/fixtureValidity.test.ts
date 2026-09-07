import { describe, it } from "vitest";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeCanonicalGenesisDoc } from "../../__tests__/fixtures";
import { makeCaseListDoc } from "../case-list-config/__tests__/fixtures";
import { makeCaseSearchDoc } from "../case-search-config/__tests__/fixtures";
import { makeMediaDoc } from "../media/__tests__/fixtures";

/**
 * Shared tool fixtures are persisted-state seeds, not partial builders. Pin
 * them through stored schema admission and the same absolute gate every mutating tool uses so an unrelated
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
			expectAdmittedDoc(makeDoc());
		});
	}
});
