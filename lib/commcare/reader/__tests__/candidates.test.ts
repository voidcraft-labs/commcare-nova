import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { planFormCaseWire } from "../../casePlacementPlan";
import { withCandidate } from "../candidate";

function followup(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "weight",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
						],
					},
				],
			},
		],
	});
}

/** The production projection behind a counting wrapper: each document object it was asked about. */
function counting() {
	const seen: BlueprintDoc[] = [];
	return {
		seen,
		plan(doc: BlueprintDoc, formUuid: Uuid) {
			seen.push(doc);
			return planFormCaseWire(doc, formUuid);
		},
	};
}

describe("each candidate is judged over a document of its own", () => {
	it("gives a new frozen document for every candidate, a patch that changes nothing included", () => {
		const doc = Object.freeze(followup()) as BlueprintDoc;
		const same = withCandidate(doc, () => {});
		expect(same).not.toBe(doc);
		expect(Object.isFrozen(same)).toBe(true);
		expect(same.forms).toBe(doc.forms);
	});

	it("leaves the document a candidate came from untouched", () => {
		const doc = followup();
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const before = JSON.stringify(doc.forms[formUuid]);
		const candidate = withCandidate(doc, (draft) => {
			const form = draft.forms[formUuid];
			if (form !== undefined) form.type = "close";
		});
		expect(JSON.stringify(doc.forms[formUuid])).toBe(before);
		expect(candidate.forms[formUuid]?.type).toBe("close");
		expect(Object.isFrozen(candidate.forms[formUuid])).toBe(true);
	});

	it("judges a second candidate on its own plan when the first failed, never on the first one's memo", () => {
		const doc = followup();
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const wrapper = counting();
		// The first candidate drops the form's own write, and its plan writes
		// no update; the second keeps it.
		const first = withCandidate(doc, (draft) => {
			const own = draft.forms[formUuid]?.caseOperations?.[0];
			if (own !== undefined) delete own.writes;
		});
		const second = withCandidate(doc, () => {});
		const rejected = wrapper.plan(first, formUuid);
		const accepted = wrapper.plan(second, formUuid);
		expect(wrapper.seen[0]).not.toBe(wrapper.seen[1]);
		expect(
			rejected.kind === "basic" &&
				Object.keys(rejected.actions.update_case.update),
		).toEqual([]);
		expect(
			accepted.kind === "basic" &&
				Object.keys(accepted.actions.update_case.update),
		).toEqual(["weight"]);
		// The draft the reading keeps holds the accepted candidate alone.
		expect(
			doc.forms[formUuid]?.caseOperations?.[0]?.writes?.[0]?.property,
		).toBe("weight");
	});
});
