/**
 * The catalog diff replays a type's parent links to the target whichever
 * spelling each side stores them in. A stored type may hold its parent in
 * the default slot (`parent_type` / `relationship`) or, beside a second
 * parent or after the default was removed, under `relations`; the reducer
 * reads every `relationChange` against the type's current default, so the
 * order the diff emits the default slots and the relation edits in decides
 * the replayed document.
 *
 * A plausible failure: the default slots move first, and the removal of the
 * `relations` copy of the edge the target promotes to the default then
 * clears the default just set, leaving the type with no parent.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { CaseType } from "@/lib/domain";
import type { BlueprintDoc } from "@/lib/domain/blueprint";

const child = (targetType: string) =>
	({ identifier: "parent", targetType, relationship: "child" }) as const;

function withVisit(visit: Omit<CaseType, "name" | "properties">): BlueprintDoc {
	return {
		...emptyBlueprintDoc(),
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "patient", properties: [] },
			{ name: "visit", properties: [], ...visit },
		],
	};
}

function replay(from: BlueprintDoc, to: BlueprintDoc): CaseType | undefined {
	const batch = diffDocsToMutations(from, to);
	const next = produce(from, (draft) => {
		applyMutations(
			draft,
			admitMutationBatch(JSON.parse(JSON.stringify(batch))),
		);
	});
	return next.caseTypes.find((type) => type.name === "visit");
}

const visitOf = (doc: BlueprintDoc) =>
	doc.caseTypes.find((type) => type.name === "visit");

describe("a type's parent links across their two spellings", () => {
	for (const [name, from, to] of [
		[
			"two parents under relations become a lone default",
			withVisit({ relations: [child("household"), child("patient")] }),
			withVisit({ parent_type: "patient", relationship: "child" }),
		],
		[
			"a lone parent under relations becomes the default",
			withVisit({ relations: [child("patient")] }),
			withVisit({ parent_type: "patient", relationship: "child" }),
		],
		[
			"the alternative parent replaces the default",
			withVisit({ parent_type: "household", relations: [child("patient")] }),
			withVisit({ parent_type: "patient" }),
		],
		[
			"the default and the alternative swap",
			withVisit({ parent_type: "household", relations: [child("patient")] }),
			withVisit({ parent_type: "patient", relations: [child("household")] }),
		],
		[
			"a default parent becomes two parents under relations",
			withVisit({ parent_type: "patient", relationship: "child" }),
			withVisit({ relations: [child("household"), child("patient")] }),
		],
	] as const) {
		it(`replays to the target when ${name}`, () => {
			expect(replay(from, to)).toEqual(visitOf(to));
		});
	}
});
