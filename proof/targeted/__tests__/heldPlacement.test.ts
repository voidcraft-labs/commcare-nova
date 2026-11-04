/**
 * `targeted-held-placement`: its first publish records where it puts each
 * form's own case, and its written edit, made again over D as that publish
 * stored it, moves the one hold the edit strands, in the batch, as an
 * editor's batch carries it.
 *
 * Contract: the record holds Update's own case in Case Management's slot and
 * Weigh's in its Save to Case block, and Nova's placement plan keeps both;
 * the edit's batch over the held D ends with the `holdPlacements` that
 * `withIdentityMoves` plans, which moves Update's own case to its Save to
 * Case block and leaves Weigh's where it is (a hold that still expresses its
 * change never moves); the commit kernel's rule admits the edit as an
 * editor's save; and a D′ written with a hold of its own is refused when the
 * document is made, since a hold is the publish's to record. The plausible
 * failures: a record that misses a hold or lays one on wrong, a D′ whose
 * stranded hold stays put (the gate would refuse it) or moves outside the
 * batch, and a D′ that moves a hold no change needs, which only the kernel's
 * rule would refuse.
 */

import { describe, expect, it } from "vitest";
import { planPlacements } from "@/lib/commcare/placement";
import { placementChangeRefusal } from "@/lib/db/placementAuthority";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { identityMovesBetween } from "@/lib/doc/identityMoves";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	afterFirstPublish,
	writtenEditOverRecord,
} from "../../corpus/editBatches";
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
	const published = afterFirstPublish(
		made.id,
		hydratePersistedBlueprint(made.doc),
		undefined,
	);
	const d = hydratePersistedBlueprint(published.doc);
	const written = made.edit;
	if (written === undefined) throw new Error("The document writes its edit.");
	const edit = writtenEditOverRecord(made.id, d, written.mutations, undefined);
	const next = edit.nextDoc;

	it("records each own case where its first publish puts it, and the plan keeps both", () => {
		expect(published.placements).toEqual([
			{
				kind: "holdPlacements",
				holds: [
					{
						target: "case-operation",
						formUuid: uuid("update"),
						operationUuid: uuid("update-own"),
						placement: OWN_SLOT,
					},
					{
						target: "case-operation",
						formUuid: uuid("weigh"),
						operationUuid: uuid("weigh-own"),
						placement: OWN_BLOCK,
					},
				],
			},
		]);
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

	it("refuses a D′ written with a hold of its own, and makes one written without", () => {
		const make = (edited: BlueprintDoc) => () =>
			targetedDocument({
				id: ID,
				rows: [],
				doc: heldPlacementApp(false),
				edit: edited,
				expected: { intent: [] },
			});
		expect(make(heldPlacementApp(true))).not.toThrow();
		expect(make(heldPlacementApp(true, { update: OWN_BLOCK }))).toThrow(
			`first at /forms/${uuid("update")}/caseOperations/0/placement; write the document as Nova stores it, each held placement where the moves the edit needs put it.`,
		);
	});
});
