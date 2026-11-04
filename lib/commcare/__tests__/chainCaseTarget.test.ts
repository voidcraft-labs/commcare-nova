/**
 * A case change may target a case its form's entry chose: an advanced
 * form's chain load is that session value (part 02 §3.4, §9.2's
 * `link-target`). The commit gate admits the read where the entry supplies
 * the chosen case as one case, and refuses one it does not supply.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { CaseOperation } from "@/lib/domain";
import { runValidation } from "../validator/runner";
import {
	advancedFixture,
	chosen,
	HOUSEHOLDS,
	VISITS,
} from "./advancedPlacementFixture";

const OWN = testUuid("chain-target-own");
const CLOSE = testUuid("chain-target-close");

function membersFollowup(target: Parameters<typeof chosen>[0]) {
	const operations = (): CaseOperation[] => [
		{ uuid: OWN, id: "own_case", action: "own" } as CaseOperation,
		{
			uuid: CLOSE,
			id: "close_household",
			action: "close",
			caseType: "household",
			target: { kind: "expression", expr: chosen(target) },
		} as CaseOperation,
	];
	return advancedFixture({ formType: "followup", menu: "members", operations })
		.doc;
}

const operationFindings = (doc: ReturnType<typeof membersFollowup>) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(finding) => finding.details?.operationUuid === CLOSE,
	);

describe("a case change whose target is a chosen case", () => {
	it("admits the household the Members entry chose", () => {
		expect(operationFindings(membersFollowup(HOUSEHOLDS))).toEqual([]);
	});

	it("refuses a case no menu before the form chose", () => {
		expect(
			operationFindings(membersFollowup(VISITS)).map((finding) => finding.code),
		).toContain("CASE_OPERATION_EXPRESSION_TYPE");
	});
});
