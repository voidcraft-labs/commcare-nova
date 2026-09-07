import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc } from "@/lib/domain";
import {
	collectTranslationUnits,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
export function buildFixture(): BlueprintDoc {
	const MOD = testUuid("module-aaaa-0000-0000-000000000000");
	const FORM = testUuid("form-bbbb-0000-0000-000000000000");
	const Q_NAME = testUuid("q-name-0000-0000-0000-000000000000");
	const Q_AGE = testUuid("q-age-0000-0000-0000-000000000000");

	return {
		appId: "search-test",
		appName: "Search Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD]: { uuid: MOD, id: "registration", name: "Patient Registration" },
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "intake",
				name: "Intake Form",
				type: "survey",
			},
		},
		fields: {
			[Q_NAME]: {
				uuid: Q_NAME,
				id: "patient_name",
				kind: "text",
				label: proseText("Patient Full Name"),
			},
			[Q_AGE]: {
				uuid: Q_AGE,
				id: "age",
				kind: "int",
				label: proseText("Age in Years"),
			},
		},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [Q_NAME, Q_AGE] },
		fieldParent: { [Q_NAME]: FORM, [Q_AGE]: FORM },
	};
}
export function withSpanishFieldLabel(doc: BlueprintDoc): BlueprintDoc {
	const fieldUuid = testUuid("q-name-0000-0000-0000-000000000000");
	const unitId = makeTranslationUnitId("field", fieldUuid, "label");
	const unit = collectTranslationUnits(doc).find(
		(candidate) => candidate.id === unitId,
	);
	if (unit === undefined) throw new Error("Expected field-label unit.");
	return {
		...doc,
		localization: {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: {
				spa: {
					[unitId]: {
						value: proseText("Nombre completo del paciente"),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			},
		},
	};
}
