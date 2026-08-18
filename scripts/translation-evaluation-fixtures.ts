import {
	type LanguageTag,
	type LocalizedValue,
	makeTranslationUnitId,
	type ProseTemplate,
	type TranslationUnit,
	translationSourceFingerprint,
	uuidSchema,
} from "../lib/domain";

export const TRANSLATION_EVALUATION_FIXTURE_VERSION =
	"commcare-worker-content-v1";

export const TRANSLATION_EVALUATION_SOURCE_LANGUAGES = [
	"eng",
	"spa",
	"fra",
] as const satisfies readonly LanguageTag[];

export type TranslationEvaluationSourceLanguage =
	(typeof TRANSLATION_EVALUATION_SOURCE_LANGUAGES)[number];

export interface TranslationEvaluationCriterion {
	readonly id: string;
	readonly description: string;
	readonly blocking: boolean;
}

export interface TranslationEvaluationFixture {
	readonly key: string;
	readonly criterionIds: readonly string[];
	readonly source: Readonly<
		Record<TranslationEvaluationSourceLanguage, LocalizedValue>
	>;
	readonly role: TranslationUnit["role"];
	readonly breadcrumb: Readonly<
		Record<TranslationEvaluationSourceLanguage, readonly string[]>
	>;
	readonly context: TranslationUnit["context"];
	readonly contentPolicy: TranslationUnit["contentPolicy"];
	readonly owner: TranslationUnit["owner"];
	/** Markdown delimiters whose count must survive. This is a narrow
	 * evaluation signal, not a claim that Nova has a general markdown parser. */
	readonly formattingMarkers?: readonly string[];
}

export const TRANSLATION_EVALUATION_CRITERIA = [
	{
		id: "meaning",
		description:
			"Preserves the complete operational meaning without adding or omitting instructions.",
		blocking: true,
	},
	{
		id: "natural-ui-copy",
		description:
			"Reads naturally to a frontline worker and stays concise for the UI role.",
		blocking: true,
	},
	{
		id: "domain-terminology",
		description:
			"Uses appropriate public-health and case-management terminology consistently.",
		blocking: true,
	},
	{
		id: "option-set",
		description:
			"Keeps related choices mutually clear and consistent as one option set.",
		blocking: true,
	},
	{
		id: "validation-instruction",
		description:
			"Keeps the condition and corrective action exact in validation copy.",
		blocking: true,
	},
	{
		id: "protected-reference",
		description:
			"Places the protected field reference naturally without changing its identity.",
		blocking: true,
	},
	{
		id: "formatting",
		description:
			"Preserves meaningful markdown delimiters and readable structure.",
		blocking: true,
	},
] as const satisfies readonly TranslationEvaluationCriterion[];

const MODULE = uuidSchema.parse("10000000-0000-4000-8000-000000000001");
const FORM = uuidSchema.parse("10000000-0000-4000-8000-000000000002");
const FIELD_NAME = uuidSchema.parse("10000000-0000-4000-8000-000000000003");
const FIELD_FEVER = uuidSchema.parse("10000000-0000-4000-8000-000000000004");
const FIELD_VISIT_DATE = uuidSchema.parse(
	"10000000-0000-4000-8000-000000000005",
);
const FIELD_STATUS = uuidSchema.parse("10000000-0000-4000-8000-000000000006");
const YES = uuidSchema.parse("10000000-0000-4000-8000-000000000007");
const NO = uuidSchema.parse("10000000-0000-4000-8000-000000000008");
const UNKNOWN = uuidSchema.parse("10000000-0000-4000-8000-000000000009");

function prose(parts: ProseTemplate["parts"]): ProseTemplate {
	return { parts };
}

const fieldOwner = (
	fieldUuid: typeof FIELD_NAME,
): TranslationUnit["owner"] => ({
	kind: "field",
	moduleUuid: MODULE,
	formUuid: FORM,
	fieldUuid,
});

const optionOwner = (optionUuid: typeof YES): TranslationUnit["owner"] => ({
	kind: "select-option",
	moduleUuid: MODULE,
	formUuid: FORM,
	fieldUuid: FIELD_STATUS,
	optionUuid,
});

export const TRANSLATION_EVALUATION_FIXTURES: readonly TranslationEvaluationFixture[] =
	[
		{
			key: "app-name",
			criterionIds: ["meaning", "natural-ui-copy"],
			source: {
				eng: "Community Health Follow-up",
				spa: "Seguimiento de salud comunitaria",
				fra: "Suivi de santé communautaire",
			},
			role: "app-name",
			breadcrumb: {
				eng: ["Community Health Follow-up"],
				spa: ["Seguimiento de salud comunitaria"],
				fra: ["Suivi de santé communautaire"],
			},
			context: {},
			contentPolicy: "require-nonblank",
			owner: { kind: "app" },
		},
		{
			key: "chw-label",
			criterionIds: ["meaning", "natural-ui-copy", "domain-terminology"],
			source: {
				eng: prose([{ kind: "text", text: "Community health worker" }]),
				spa: prose([{ kind: "text", text: "Agente comunitario de salud" }]),
				fra: prose([{ kind: "text", text: "Agent de santé communautaire" }]),
			},
			role: "field-label",
			breadcrumb: {
				eng: ["Household visit", "Visit details", "Community health worker"],
				spa: [
					"Visita domiciliaria",
					"Datos de la visita",
					"Agente comunitario de salud",
				],
				fra: [
					"Visite à domicile",
					"Détails de la visite",
					"Agent de santé communautaire",
				],
			},
			context: { fieldId: "chw_name", fieldKind: "text" },
			contentPolicy: "allow-blank",
			owner: fieldOwner(FIELD_NAME),
		},
		{
			key: "fever-guidance",
			criterionIds: ["meaning", "natural-ui-copy", "formatting"],
			source: {
				eng: prose([
					{
						kind: "text",
						text: "If **fever** is present, arrange a same-day referral.",
					},
				]),
				spa: prose([
					{
						kind: "text",
						text: "Si hay **fiebre**, organice una derivación para el mismo día.",
					},
				]),
				fra: prose([
					{
						kind: "text",
						text: "En cas de **fièvre**, organisez une orientation le jour même.",
					},
				]),
			},
			role: "field-help",
			breadcrumb: {
				eng: ["Household visit", "Symptoms", "Fever", "Help"],
				spa: ["Visita domiciliaria", "Síntomas", "Fiebre", "Ayuda"],
				fra: ["Visite à domicile", "Symptômes", "Fièvre", "Aide"],
			},
			context: { fieldId: "fever", fieldKind: "single_select" },
			contentPolicy: "allow-blank",
			owner: fieldOwner(FIELD_FEVER),
			formattingMarkers: ["**"],
		},
		{
			key: "visit-date-validation",
			criterionIds: ["meaning", "validation-instruction"],
			source: {
				eng: prose([
					{
						kind: "text",
						text: "Visit date cannot be in the future. Enter today or an earlier date.",
					},
				]),
				spa: prose([
					{
						kind: "text",
						text: "La fecha de la visita no puede ser futura. Ingrese la fecha de hoy o una anterior.",
					},
				]),
				fra: prose([
					{
						kind: "text",
						text: "La date de visite ne peut pas être ultérieure. Saisissez la date du jour ou une date antérieure.",
					},
				]),
			},
			role: "field-validation-message",
			breadcrumb: {
				eng: [
					"Household visit",
					"Visit details",
					"Visit date",
					"Validation message",
				],
				spa: [
					"Visita domiciliaria",
					"Datos de la visita",
					"Fecha de la visita",
					"Mensaje de validación",
				],
				fra: [
					"Visite à domicile",
					"Détails de la visite",
					"Date de visite",
					"Message de validation",
				],
			},
			context: { fieldId: "visit_date", fieldKind: "date" },
			contentPolicy: "allow-blank",
			owner: fieldOwner(FIELD_VISIT_DATE),
		},
		{
			key: "confirm-name-reference",
			criterionIds: ["meaning", "protected-reference"],
			source: {
				eng: prose([
					{ kind: "text", text: "Confirm the household name " },
					{ kind: "field-ref", uuid: FIELD_NAME },
					{ kind: "text", text: " before continuing." },
				]),
				spa: prose([
					{ kind: "text", text: "Confirme el nombre del hogar " },
					{ kind: "field-ref", uuid: FIELD_NAME },
					{ kind: "text", text: " antes de continuar." },
				]),
				fra: prose([
					{ kind: "text", text: "Confirmez le nom du ménage " },
					{ kind: "field-ref", uuid: FIELD_NAME },
					{ kind: "text", text: " avant de continuer." },
				]),
			},
			role: "field-hint",
			breadcrumb: {
				eng: ["Household visit", "Review", "Confirm household"],
				spa: ["Visita domiciliaria", "Revisión", "Confirmar hogar"],
				fra: ["Visite à domicile", "Vérification", "Confirmer le ménage"],
			},
			context: { fieldId: "confirm_household", fieldKind: "label" },
			contentPolicy: "allow-blank",
			owner: fieldOwner(FIELD_STATUS),
		},
		...(
			[
				{
					key: "status-yes",
					value: "yes",
					source: { eng: "Yes", spa: "Sí", fra: "Oui" },
					optionUuid: YES,
				},
				{
					key: "status-no",
					value: "no",
					source: { eng: "No", spa: "No", fra: "Non" },
					optionUuid: NO,
				},
				{
					key: "status-unknown",
					value: "unknown",
					source: { eng: "Don't know", spa: "No sabe", fra: "Ne sait pas" },
					optionUuid: UNKNOWN,
				},
			] as const
		).map(
			(option): TranslationEvaluationFixture => ({
				key: option.key,
				criterionIds: ["meaning", "natural-ui-copy", "option-set"],
				source: {
					eng: prose([{ kind: "text", text: option.source.eng }]),
					spa: prose([{ kind: "text", text: option.source.spa }]),
					fra: prose([{ kind: "text", text: option.source.fra }]),
				},
				role: "select-option-label",
				breadcrumb: {
					eng: [
						"Household visit",
						"Symptoms",
						"Referral completed",
						option.source.eng,
					],
					spa: [
						"Visita domiciliaria",
						"Síntomas",
						"Derivación completada",
						option.source.spa,
					],
					fra: [
						"Visite à domicile",
						"Symptômes",
						"Orientation effectuée",
						option.source.fra,
					],
				},
				context: {
					fieldId: "referral_completed",
					fieldKind: "single_select",
					optionValue: option.value,
				},
				contentPolicy: "allow-blank",
				owner: optionOwner(option.optionUuid),
			}),
		),
	];

export function translationEvaluationUnits(
	sourceLanguage: TranslationEvaluationSourceLanguage,
): readonly TranslationUnit[] {
	return TRANSLATION_EVALUATION_FIXTURES.map((fixture) => {
		const source = fixture.source[sourceLanguage];
		return {
			id: makeTranslationUnitId("translation-evaluation", fixture.key),
			valueKind: typeof source === "string" ? "text" : "prose",
			role: fixture.role,
			source,
			sourceFingerprint: translationSourceFingerprint(
				typeof source === "string" ? "text" : "prose",
				source,
			),
			contentPolicy: fixture.contentPolicy,
			owner: fixture.owner,
			breadcrumb: fixture.breadcrumb[sourceLanguage],
			context: fixture.context,
		};
	});
}

export function isTranslationEvaluationSourceLanguage(
	language: LanguageTag,
): language is TranslationEvaluationSourceLanguage {
	return TRANSLATION_EVALUATION_SOURCE_LANGUAGES.some(
		(candidate) => candidate === language,
	);
}
