import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { collectTranslationUnits, makeTranslationUnitId } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";

export const MODULE = testUuid("language-screen-module");
export const FORM = testUuid("language-screen-form");
export const NAME = testUuid("language-screen-name");
export const GREETING = testUuid("language-screen-greeting");
export const DATE = testUuid("language-screen-date");
export const CLOCK = testUuid("language-screen-clock");
export const POINT = testUuid("language-screen-point");
export const REPEAT = testUuid("language-screen-repeat");
export const SECTION = testUuid("language-screen-section");
export const NOTE = testUuid("language-screen-note");
export const SIGNATURE = testUuid("language-screen-signature");
export const IMAGE = testUuid("language-screen-image");

/** One section and a fixed repeat are admitted together. The manual-repeat
 * mutation boundary is covered separately by its real controller/browser tests. */
export function languageScreenDoc() {
	const doc = buildDoc({
		appId: "native-language-screen",
		appName: "Visit language",
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							{
								uuid: SECTION,
								kind: "section",
								id: "visit",
								label: "Visit details",
								children: [
									{ uuid: NAME, kind: "text", id: "name", label: "Name" },
									{
										uuid: GREETING,
										kind: "text",
										id: "greeting",
										label: "Greeting",
									},
									{
										uuid: DATE,
										kind: "date",
										id: "date",
										label: "Visit date",
										required: "true()",
									},
									{
										uuid: CLOCK,
										kind: "datetime",
										id: "when",
										label: "Visit time",
										default_value: "'2024-01-15T14:30:00.000-05:00'",
									},
									{
										uuid: POINT,
										kind: "geopoint",
										id: "location",
										label: "Location",
									},
									{
										uuid: REPEAT,
										kind: "repeat",
										id: "visits",
										label: "Visits",
										repeat_mode: "count_bound",
										repeat_count: "2",
										children: [
											{
												uuid: NOTE,
												kind: "text",
												id: "note",
												label: "Visit note",
											},
											{
												uuid: SIGNATURE,
												kind: "signature",
												id: "signature",
												label: "Approval signature",
											},
											{
												uuid: IMAGE,
												kind: "image",
												id: "image",
												label: "Visit image",
											},
										],
									},
								],
							},
						],
					},
				],
			},
		],
	});
	doc.fields[GREETING] = {
		uuid: GREETING,
		kind: "text",
		id: "greeting",
		label: {
			parts: [
				{ kind: "text", text: "Hello " },
				{ kind: "field-ref", uuid: NAME },
			],
		},
	};
	const source = hydratePersistedBlueprint(admittedControllerDoc(doc));
	const unitId = makeTranslationUnitId("field", GREETING, "label");
	const unit = collectTranslationUnits(source).find(
		(item) => item.id === unitId,
	);
	if (!unit) throw new Error("Expected the admitted greeting translation unit");
	source.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		translations: {
			spa: {
				[unitId]: {
					value: {
						parts: [
							{ kind: "text", text: "Hola " },
							{ kind: "field-ref", uuid: NAME },
						],
					},
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
	// Re-admit the complete translated document; no test reaches a renderer
	// with field topology or localization that the product would reject.
	return admittedControllerDoc(source);
}
