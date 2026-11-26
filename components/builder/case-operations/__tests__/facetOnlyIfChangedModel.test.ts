/**
 * Choosing a case change's owner where its Save only if changed is on.
 *
 * Contract: an owner that is the worker or no one is never blank, so the gate
 * refuses saving it only when changed (`CASE_WRITE_ONLY_IF_CHANGED_INVALID`,
 * reason `never-blank`) and the canvas offers no switch for it. Choosing such
 * an owner commits the change without the switch, so the gate admits it; an
 * owner that is an answer keeps the switch. The plausible failure: the canvas
 * committing the new owner with the switch still on, which the gate refuses,
 * so the owner does not change until the author turns off a switch they can
 * no longer see.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
	OWN,
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { actingUser } from "@/lib/domain/expression/builders";
import { withOwner } from "../facetOnlyIfChangedModel";

function flaggedOwner() {
	return placementFixture("followup", {
		operations: () => [own({ owner: read("name"), ownerOnlyIfChanged: true })],
	});
}

function committed(doc: BlueprintDoc, formUuid: string, next: CaseOperation) {
	return produce(doc, (draft) => {
		const operations = draft.forms[formUuid as never]?.caseOperations;
		if (operations === undefined) throw new Error("The form keeps changes.");
		operations[0] = next as never;
	});
}

function onlyIfChangedCodes(doc: BlueprintDoc): string[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.filter((error) => error.code === "CASE_WRITE_ONLY_IF_CHANGED_INVALID")
		.map((error) => String(error.details?.reason));
}

describe("choosing a change's owner with Save only if changed on", () => {
	it("drops the switch for the worker, which the gate then admits", () => {
		const { doc, formUuid } = flaggedOwner();
		const current = doc.forms[formUuid]?.caseOperations?.[0];
		if (current?.uuid !== OWN) throw new Error("The form keeps its own case.");
		const next = withOwner(current, actingUser(), "followup");
		expect(next).not.toHaveProperty("ownerOnlyIfChanged");
		expect(onlyIfChangedCodes(committed(doc, formUuid, next))).toEqual([]);
		// The owner set with the switch still on is what the gate refuses.
		expect(
			onlyIfChangedCodes(
				committed(doc, formUuid, { ...current, owner: actingUser() }),
			),
		).toEqual(["never-blank"]);
	});

	it("keeps the switch for an answer", () => {
		const { doc, formUuid } = flaggedOwner();
		const current = doc.forms[formUuid]?.caseOperations?.[0];
		if (current === undefined) throw new Error("The form keeps its own case.");
		const next = withOwner(current, read("inner"), "followup");
		expect(next).toMatchObject({ ownerOnlyIfChanged: true });
		expect(onlyIfChangedCodes(committed(doc, formUuid, next))).toEqual([]);
	});
});
