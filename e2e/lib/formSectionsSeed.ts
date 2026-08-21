/**
 * A form already split into two pages, for the journey that only a real
 * browser can run: the preview pager.
 *
 * The part of sections that matters most is the turn of the page. Next has
 * to check the page it is leaving and refuse with the blank required
 * question focused; Back has to turn without checking and keep the answer;
 * the stepper has to name the open page and Submit has to take Next's place
 * on the last one. So the fixture is the smallest form that exercises all
 * of it: page one carries one required question, page two one optional
 * question. The journey authors nothing and submits nothing, so one app
 * serves every attempt.
 */

import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const FORM_SECTIONS_SEED = {
	appName: "Smoke — Sections",
	moduleName: "Intake",
	moduleUuid: asUuid("b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
	formUuid: asUuid("b2b3c4d5-f6a7-4b8c-9d0e-1f2a3b4c5d6e"),
	formName: "Intake survey",
	aboutYou: {
		uuid: asUuid("b3c4d5e6-a7b8-4c9d-8e0f-2a3b4c5d6e7f"),
		title: "About you",
		nameFieldUuid: asUuid("b4d5e6f7-b8c9-4d0e-9f1a-3b4c5d6e7f8a"),
		nameLabel: "Your name",
	},
	yourVisit: {
		uuid: asUuid("b5e6f7a8-c9d0-4e1f-8a2b-4c5d6e7f8a9b"),
		title: "Your visit",
		noteFieldUuid: asUuid("b6f7a8b9-d0e1-4f2a-9b3c-5d6e7f8a9b0c"),
		noteLabel: "Anything to add",
	},
} as const;

/** The blueprint installed into the sections fixture app. */
export function buildFormSectionsBlueprint(appId = "test-app"): BlueprintDoc {
	const { aboutYou, yourVisit } = FORM_SECTIONS_SEED;
	return buildDoc({
		appId,
		appName: FORM_SECTIONS_SEED.appName,
		modules: [
			{
				uuid: FORM_SECTIONS_SEED.moduleUuid,
				name: FORM_SECTIONS_SEED.moduleName,
				forms: [
					{
						uuid: FORM_SECTIONS_SEED.formUuid,
						name: FORM_SECTIONS_SEED.formName,
						type: "survey",
						fields: [
							f({
								uuid: aboutYou.uuid,
								kind: "section",
								id: "about_you",
								label: proseText(aboutYou.title),
								children: [
									f({
										uuid: aboutYou.nameFieldUuid,
										kind: "text",
										id: "your_name",
										label: proseText(aboutYou.nameLabel),
										required: xp("true()"),
									}),
								],
							}),
							f({
								uuid: yourVisit.uuid,
								kind: "section",
								id: "your_visit",
								label: proseText(yourVisit.title),
								children: [
									f({
										uuid: yourVisit.noteFieldUuid,
										kind: "text",
										id: "visit_note",
										label: proseText(yourVisit.noteLabel),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
}

/** The canonical relative path to the sectioned form's edit canvas. */
export function formSectionsRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "form",
		moduleUuid: FORM_SECTIONS_SEED.moduleUuid,
		formUuid: FORM_SECTIONS_SEED.formUuid,
	});
}
