/**
 * Held placements and the moves an edit needs
 * (`targeted-held-placement`).
 *
 * A basic menu of patients whose D stands for an app already published, so
 * each of its case changes is held where that publish put it
 * (`lib/commcare/placement.ts::planPlacements`, a hold first):
 *
 * - "Update": its own case saves the note, a question's answer as it is, and
 *   is held in Case Management's slot (`update_case`).
 * - "Weigh": its own case saves the weight, a question's answer, and its
 *   weight written as text with its unit, a computed value Case Management
 *   cannot state, so the change is held in the Save to Case block
 *   `nova_operations/patient`.
 *
 * Written D′ adds to Update a write of a computed value (`checked`, the text
 * `yes`), which Case Management's slot cannot hold, so the edit moves
 * Update's own case to the Save to Case block Nova plans for it, and the
 * move is in the batch (`lib/doc/identityMoves.ts::withIdentityMoves`), as
 * every editor's batch carries it. It also removes Weigh's computed write:
 * Case Management could now hold Weigh's change, and its hold keeps it in
 * its block, because a hold that still expresses its change never moves.
 * The commit kernel's rule admits both as an editor's save
 * (`lib/db/placementAuthority.ts::placementChangeRefusal`).
 *
 * D's holds are written here, as the publish that recorded them would; from
 * the pull request that records a first publish's placements, they are the
 * capture's record, the same placements.
 *
 * Fixed values: Weigh opened on the patient Amina, given the weight 2.5,
 * holds `2.5 kg` in its block's `weight_text` write.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CasePlacement,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { concat, formField, literal, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-held-placement";
const uuid = (name: string) => targetedUuid(ID, name);

export const OWN_SLOT: CasePlacement = { kind: "basic", slot: "own" };
export const OWN_BLOCK: CasePlacement = {
	kind: "save-to-case",
	path: ["nova_operations", "patient"],
};

/** Where each form's own case is held. */
export interface HeldPlacementHolds {
	readonly update: CasePlacement;
	readonly weigh: CasePlacement;
}

/**
 * The app before the edit (`edited: false`) and after it, each form's own
 * case held where `holds` says: by default, where the publish D stands for
 * put it and, after the edit, where its moves put it.
 */
export function heldPlacementApp(
	edited: boolean,
	holds: HeldPlacementHolds = {
		update: edited ? OWN_BLOCK : OWN_SLOT,
		weigh: OWN_BLOCK,
	},
): BlueprintDoc {
	const update = uuid("update");
	const weigh = uuid("weigh");
	const read = (key: string) => term(formField(uuid(key)));
	const updateOperations: CaseOperation[] = [
		{
			uuid: uuid("update-own"),
			id: "patient",
			action: "own",
			writes: [
				{ property: "note", value: read("note") },
				...(edited
					? [{ property: "checked", value: term(literal("yes")) }]
					: []),
			],
			placement: holds.update,
		},
	];
	const weighOperations: CaseOperation[] = [
		{
			uuid: uuid("weigh-own"),
			id: "patient",
			action: "own",
			writes: [
				{ property: "weight", value: read("kg") },
				...(edited
					? []
					: [
							{
								property: "weight_text",
								value: concat(read("kg"), term(literal(" kg"))),
							},
						]),
			],
			placement: holds.weigh,
		},
	];
	return buildDoc(
		{
			appId: ID,
			appName: "Patient weights",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "note", label: proseText("Note"), data_type: "text" },
						{ name: "checked", label: proseText("Checked"), data_type: "text" },
						{
							name: "weight",
							label: proseText("Weight"),
							data_type: "decimal",
						},
						{
							name: "weight_text",
							label: proseText("Weight with its unit"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					uuid: uuid("patients"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf([
						plainColumn(uuid("name-column"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: update,
							name: "Update",
							type: "followup",
							fields: [
								f({
									kind: "text",
									uuid: uuid("note"),
									id: "note",
									label: proseText("Note"),
								}),
							],
						},
						{
							uuid: weigh,
							name: "Weigh",
							type: "followup",
							fields: [
								f({
									kind: "decimal",
									uuid: uuid("kg"),
									id: "kg",
									label: proseText("Weight in kilograms"),
								}),
							],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[update].caseOperations = updateOperations;
			built.forms[weigh].caseOperations = weighOperations;
		},
	);
}

export function heldPlacement() {
	const weigh = uuid("weigh");
	const restore = restoreXml({
		cases: [{ id: "targeted-amina", type: "patient", name: "Amina" }],
	});
	return targetedDocument({
		id: ID,
		rows: ["held placements and the moves an edit needs"],
		doc: heldPlacementApp(false),
		edit: heldPlacementApp(true),
		expected: {
			intent: [
				{
					// The held block writes the computed value Case Management
					// cannot state.
					id: "weigh-block-writes",
					export: "local",
					form: weigh,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f1", data: { case_id: "targeted-amina" } },
						answers: [{ path: "/data/kg", value: "2.5" }],
						expressions: [
							"/data/nova_operations/patient/case/update/weight_text",
						],
					},
					expect: [
						{ pointer: "/answers/0/result", value: "ok" },
						{ pointer: "/values/0/value", value: "2.5 kg" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
