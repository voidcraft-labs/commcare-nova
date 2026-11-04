/**
 * `targeted-held-placement`: its D holds each form's own case where a
 * publish put it, and its written edit moves the one hold the edit strands,
 * in the batch, as an editor's batch carries it.
 *
 * Contract: Nova's placement plan keeps each of D's holds; the edit's batch
 * ends with the `holdPlacements` that `withIdentityMoves` plans, which moves
 * Update's own case to its Save to Case block and leaves Weigh's where it is
 * (a hold that still expresses its change never moves); the commit kernel's
 * rule admits the edit as an editor's save; and a D′ written with any other
 * hold is refused when the document is made. The plausible failures: a hold
 * the build drops or lays on wrong, a D′ whose stranded hold stays put (the
 * gate would refuse it) or moves outside the batch, and a D′ that moves a
 * hold no change needs, which only the kernel's rule would refuse.
 */

import { describe, expect, it } from "vitest";
import { planPlacements } from "@/lib/commcare/placement";
import { placementChangeRefusal } from "@/lib/db/placementAuthority";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { identityMovesBetween } from "@/lib/doc/identityMoves";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import {
	heldPlacement,
	heldPlacementApp,
	OWN_BLOCK,
	OWN_SLOT,
} from "../documents/heldPlacement";

const ID = "targeted-held-placement";
const uuid = (name: string) => targetedUuid(ID, name);

function ownHeld(doc: BlueprintDoc, form: string) {
	return doc.forms[uuid(form)]?.caseOperations?.[0]?.placement;
}

function kept(doc: BlueprintDoc, form: string, operation: string): boolean {
	return (
		planPlacements(doc, uuid(form) as Uuid).placements.get(uuid(operation))
			?.held === true
	);
}

describe("targeted-held-placement", () => {
	const made = heldPlacement();
	const d = hydratePersistedBlueprint(made.doc);
	const edit = made.edit;
	if (edit === undefined) throw new Error("The document writes its edit.");
	const next = hydratePersistedBlueprint(edit.nextDoc);

	it("holds each own case where its publish put it, and the plan keeps both", () => {
		expect(ownHeld(d, "update")).toEqual(OWN_SLOT);
		expect(ownHeld(d, "weigh")).toEqual(OWN_BLOCK);
		expect(kept(d, "update", "update-own")).toBe(true);
		expect(kept(d, "weigh", "weigh-own")).toBe(true);
	});

	it("moves Update's stranded hold in the edit's batch, keeps Weigh's, and is an editor's save", () => {
		expect(edit.mutations.at(-1)).toEqual({
			kind: "holdPlacements",
			holds: [
				{
					target: "case-operation",
					formUuid: uuid("update"),
					operationUuid: uuid("update-own"),
					placement: OWN_BLOCK,
				},
			],
		});
		expect(ownHeld(next, "update")).toEqual(OWN_BLOCK);
		expect(ownHeld(next, "weigh")).toEqual(OWN_BLOCK);
		// Weigh's change could now take Case Management's slot; its hold
		// still expresses it, so the plan keeps it in its block.
		expect(kept(next, "weigh", "weigh-own")).toBe(true);
		const recorded = readPlacementHolds(d);
		expect(placementChangeRefusal(d, next, "autosave", recorded)).toBeNull();
		expect(
			identityMovesBetween(d, next, { recorded }).map((move) => ({
				subject: move.subject,
				reason: move.reason,
			})),
		).toEqual([
			{
				subject: {
					kind: "case-operation",
					formUuid: uuid("update"),
					operationUuid: uuid("update-own"),
				},
				reason: {
					source: "case-placement",
					reason: { reason: "value-computed" },
				},
			},
		]);
	});

	it("refuses a D′ that keeps the stranded hold, or moves one no change needs", () => {
		const make = (edited: BlueprintDoc) => () =>
			targetedDocument({
				id: ID,
				rows: [],
				doc: heldPlacementApp(false),
				edit: edited,
				expected: { intent: [] },
			});
		expect(
			make(heldPlacementApp(true, { update: OWN_SLOT, weigh: OWN_BLOCK })),
		).toThrow(
			`first at /forms/${uuid("update")}/caseOperations/0/placement/kind; write the document as Nova stores it, each held placement where the moves the edit needs put it.`,
		);
		expect(
			make(heldPlacementApp(true, { update: OWN_BLOCK, weigh: OWN_SLOT })),
		).toThrow(
			`first at /forms/${uuid("weigh")}/caseOperations/0/placement/kind; write the document as Nova stores it, each held placement where the moves the edit needs put it.`,
		);
	});
});
