/**
 * A form whose after-submit link can only be judged once its own write has
 * landed.
 *
 * The part of after-submit links that most needs a real browser is the
 * moment between the save and the next screen: the condition is evaluated
 * against the case AS THE SUBMISSION LEFT IT, and the person either lands
 * where the link points, bound to the case they were on, or where the form
 * goes otherwise. So the fixture's one link reads back the very property
 * the form writes: "Visit" stores its note on the patient, and the link to
 * "Follow-up" fires only when that stored note is "Visited". One submission
 * with any other note proves the otherwise path; one with "Visited" proves
 * the link, the post-submission read, and the carried case, in one journey.
 *
 * The journey mutates the blueprint (it authors the link) and the saved row
 * (it submits twice), so every Playwright attempt gets its own app and row:
 * `FORM_LINKS_FIXTURE_COUNT` in `e2e/lib/config.ts`, selected by
 * `seed.formLinks[testInfo.retry]`.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, type BlueprintDoc, plainColumn } from "@/lib/domain";
import { formField, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const FORM_LINKS_SEED = {
	appName: "Smoke — After submit",
	moduleName: "Patients",
	caseType: "patient",
	caseName: "Smoke patient",
	moduleUuid: asUuid("9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"),
	visit: {
		formUuid: asUuid("9b2c3d4e-5f6a-4b7c-8d9e-1f2a3b4c5d6e"),
		formName: "Visit",
		noteFieldUuid: asUuid("9c3d4e5f-6a7b-4c8d-9e0f-2a3b4c5d6e7f"),
		noteFieldLabel: "Visit note",
		operationUuid: asUuid("9d4e5f6a-7b8c-4d9e-8f0a-3b4c5d6e7f8a"),
	},
	followUp: {
		formUuid: asUuid("9e5f6a7b-8c9d-4e0f-9a1b-4c5d6e7f8a9b"),
		formName: "Follow-up",
		noteFieldUuid: asUuid("9f6a7b8c-9d0e-4f1a-8b2c-5d6e7f8a9b0c"),
		noteFieldLabel: "Follow-up note",
	},
	columns: {
		patientName: asUuid("9a7b8c9d-0e1f-402a-8c3d-6e7f8a9b0c1d"),
		lastNote: asUuid("9b8c9d0e-1f2a-413b-9d4e-7f8a9b0c1d2e"),
	},
	/** The property the form writes and the link reads back. */
	property: "last_note",
	/** The note that makes the link fire; anything else takes the otherwise path. */
	linkingNote: "Visited",
} as const;

/** The blueprint installed into the after-submit fixture app. */
export function buildFormLinksBlueprint(appId = "test-app"): BlueprintDoc {
	const doc = buildDoc({
		appId,
		appName: FORM_LINKS_SEED.appName,
		caseTypes: [
			{
				name: FORM_LINKS_SEED.caseType,
				properties: [
					{
						name: FORM_LINKS_SEED.property,
						label: proseText("Last note"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: FORM_LINKS_SEED.moduleUuid,
				name: FORM_LINKS_SEED.moduleName,
				caseType: FORM_LINKS_SEED.caseType,
				caseListConfig: {
					columns: [
						plainColumn(
							FORM_LINKS_SEED.columns.patientName,
							"case_name",
							"Patient",
						),
						plainColumn(
							FORM_LINKS_SEED.columns.lastNote,
							FORM_LINKS_SEED.property,
							"Last note",
						),
					],
					listColumnOrder: [
						FORM_LINKS_SEED.columns.patientName,
						FORM_LINKS_SEED.columns.lastNote,
					],
					detailColumnOrder: [
						FORM_LINKS_SEED.columns.patientName,
						FORM_LINKS_SEED.columns.lastNote,
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: FORM_LINKS_SEED.visit.formUuid,
						name: FORM_LINKS_SEED.visit.formName,
						// Case-loading, so "the case this form opened" is what a link
						// to another case-loading form carries automatically.
						type: "followup",
						// Stored explicitly: the otherwise row then reads as the
						// author's choice rather than the form type's default.
						postSubmit: "app_home",
						fields: [
							f({
								uuid: FORM_LINKS_SEED.visit.noteFieldUuid,
								kind: "text",
								id: "visit_note",
								label: proseText(FORM_LINKS_SEED.visit.noteFieldLabel),
							}),
						],
					},
					{
						uuid: FORM_LINKS_SEED.followUp.formUuid,
						name: FORM_LINKS_SEED.followUp.formName,
						type: "followup",
						fields: [
							f({
								uuid: FORM_LINKS_SEED.followUp.noteFieldUuid,
								kind: "text",
								id: "followup_note",
								label: proseText(FORM_LINKS_SEED.followUp.noteFieldLabel),
							}),
						],
					},
				],
			},
		],
	});
	const visit = doc.forms[FORM_LINKS_SEED.visit.formUuid];
	if (visit === undefined) {
		throw new Error("formLinksSeed: the Visit form did not build");
	}
	/* Attached in its stored shape, as `caseChangesSeed` does: the write is
	 * what the link's condition reads back once the submission has landed. */
	return {
		...doc,
		forms: {
			...doc.forms,
			[FORM_LINKS_SEED.visit.formUuid]: {
				...visit,
				caseOperations: [
					{
						uuid: FORM_LINKS_SEED.visit.operationUuid,
						id: "store_note",
						action: "update",
						caseType: FORM_LINKS_SEED.caseType,
						target: { kind: "session" },
						writes: [
							{
								property: FORM_LINKS_SEED.property,
								value: term(formField(FORM_LINKS_SEED.visit.noteFieldUuid)),
							},
						],
					},
				],
			},
		},
	};
}

/** The canonical relative path to the Visit form's After submit screen. */
export function formLinksRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "form-links",
		moduleUuid: FORM_LINKS_SEED.moduleUuid,
		formUuid: FORM_LINKS_SEED.visit.formUuid,
	});
}
