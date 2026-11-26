// lib/domain/translationUnits.ts
//
// The one inventory and effective-value resolver for every static
// worker-facing Blueprint string Nova can localize. Builder, Preview, tools,
// translation orchestration, and CommCare emission consume this projection;
// none independently walks display slots.

import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { caseTypesWithRelations } from "./appCaseRelations";
import type { BlueprintDoc, CaseProperty } from "./blueprint";
import { caseMappingTextUnit } from "./caseMappingRows";
import { columnPropertyCaseType } from "./columnRelation";
import { effectiveCaseTypes } from "./effectiveCaseTypes";
import type { ItextUnit, ProseSlotRef } from "./expression/types";
import { FIELD_ITEXT_SLOTS } from "./expression/types";
import type { Field } from "./fields";
import { isContainer } from "./fields";
import { DEFAULT_FORM_SUBMIT_LABEL } from "./formSubmitLabel";
import {
	type GeneratedWording,
	generatedWordingUnits,
} from "./generatedWording";
import {
	LABEL_TEXT_SLOTS,
	type LabelTextSlot,
	labelTextOf,
} from "./labelForms";
import {
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedValue,
	makeTranslationUnitId,
	type TranslationEntry,
	type TranslationUnitId,
	translationSourceFingerprint,
	translationSourceFingerprintsEqual,
} from "./localization";
import { collectAssetRefs } from "./mediaRefs";
import {
	caseListColumnTextShows,
	columnSortLabelShows,
	effectiveCaseSearchConfig,
	isSelectSearchInput,
	type Module,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	searchScreenTitleText,
} from "./modules";
import {
	type ProseAtomPart,
	type ProseTemplate,
	projectProseTemplate,
} from "./prose";
import { SEARCH_RUNTIME_VALIDATION_MESSAGES } from "./searchRuntimeValidationMessages";
import { translationFillSource } from "./translationFill";
import type { Uuid } from "./uuid";

export const translationUnitRoles = [
	"app-name",
	"module-name",
	"form-name",
	"menu-badge",
	"form-submit-label",
	"case-list-menu-item-label",
	"case-list-registration-label",
	"field-label",
	"field-hint",
	"field-help",
	"field-validation-message",
	"field-extended-text",
	"field-extended-hint",
	"field-extended-help",
	"field-extended-validation-message",
	"field-qr-code",
	"field-spoken-text",
	"field-first-add-label",
	"field-add-label",
	"select-option-label",
	"select-option-extended-text",
	"case-detail-tab-title",
	"case-list-header",
	"case-list-sort-label",
	"case-list-calculation-text",
	"case-list-image-description",
	"case-list-mapping-label",
	"case-list-interval-text",
	"case-list-empty-text",
	"case-list-select-text",
	"search-input-label",
	"search-input-hint",
	"search-input-required-message",
	"search-input-validation-message",
	"search-screen-title",
	"search-screen-subtitle",
	"search-runtime-validation-message",
	"generated-wording",
	"case-property-option-label",
] as const;
export type TranslationUnitRole = (typeof translationUnitRoles)[number];

/** The translation role of each label text slot (`labelForms.ts`). */
export const LABEL_TEXT_ROLES = {
	extended_text: "field-extended-text",
	qr_code: "field-qr-code",
	spoken_text: "field-spoken-text",
} as const satisfies Readonly<Record<LabelTextSlot, TranslationUnitRole>>;
export type LabelTextRole = (typeof LABEL_TEXT_ROLES)[LabelTextSlot];

/** The label text slot a role translates. */
export const LABEL_TEXT_SLOT_OF_ROLE: Readonly<
	Record<LabelTextRole, LabelTextSlot>
> = {
	"field-extended-text": "extended_text",
	"field-qr-code": "qr_code",
	"field-spoken-text": "spoken_text",
};

export const EXTENDED_FIELD_TEXT_ROLES = {
	extended_hint: "field-extended-hint",
	extended_help: "field-extended-help",
	extended_validate_msg: "field-extended-validation-message",
} as const;

export const EXTENDED_FIELD_TEXT_SLOT_OF_ROLE = {
	"field-extended-hint": "extended_hint",
	"field-extended-help": "extended_help",
	"field-extended-validation-message": "extended_validate_msg",
} as const;
type ExtendedFieldTextRole = keyof typeof EXTENDED_FIELD_TEXT_SLOT_OF_ROLE;

/** The unit of a case list's own empty-list text (`"empty"`) or Continue
 *  label (`"select"`): the module's, since the list has no identity of its own. */
export function caseListWordingUnitId(
	moduleUuid: Uuid,
	slot: "empty" | "select",
): TranslationUnitId {
	return makeTranslationUnitId("module", moduleUuid, `list-${slot}-text`);
}

export const translationUnitOwnerKinds = [
	"app",
	"module",
	"form",
	"field",
	"select-option",
	"case-list-column",
	"search-input",
	"case-property-option",
] as const;
export type TranslationUnitOwnerKind =
	(typeof translationUnitOwnerKinds)[number];

export type TranslationUnitOwner =
	| { readonly kind: "app" }
	| { readonly kind: "module"; readonly moduleUuid: Uuid }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  }
	| {
			readonly kind: "field";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly fieldUuid: Uuid;
	  }
	| {
			readonly kind: "select-option";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly fieldUuid: Uuid;
			readonly optionUuid: Uuid;
	  }
	| {
			readonly kind: "case-list-column";
			readonly moduleUuid: Uuid;
			readonly columnUuid: Uuid;
	  }
	| {
			readonly kind: "search-input";
			readonly moduleUuid: Uuid;
			readonly searchInputUuid: Uuid;
	  }
	| {
			readonly kind: "case-property-option";
			readonly caseType: string;
			readonly property: string;
			readonly value: string;
			readonly occurrence: number;
	  };

export interface TranslationUnitContext {
	readonly moduleName?: string;
	readonly formName?: string;
	readonly fieldId?: string;
	readonly fieldKind?: Field["kind"];
	readonly columnKind?: string;
	readonly detailTabUuid?: Uuid;
	readonly optionValue?: string;
	readonly caseType?: string;
	readonly caseProperty?: string;
	readonly systemMessageDescription?: string;
}

export interface TranslationUnit {
	readonly id: TranslationUnitId;
	readonly valueKind: "text" | "prose";
	readonly role: TranslationUnitRole;
	readonly generated?: GeneratedWording;
	readonly source: LocalizedValue;
	readonly sourceFingerprint: string;
	/** Whether the owning slot permits an empty/whitespace-only target value. */
	readonly contentPolicy: "allow-blank" | "require-nonblank";
	readonly owner: TranslationUnitOwner;
	/** Source-language path shown by the translation workspace and tools. */
	readonly breadcrumb: readonly string[];
	readonly context: TranslationUnitContext;
}

export type TranslationStatus =
	| "missing"
	| "needs-review"
	| "out-of-date"
	| "ready";

const NONBLANK_TRANSLATION_ROLES: ReadonlySet<TranslationUnitRole> = new Set([
	"case-detail-tab-title",
	"app-name",
	"module-name",
	"form-name",
	"menu-badge",
	"case-list-menu-item-label",
	"case-list-registration-label",
	"case-list-sort-label",
	"case-list-empty-text",
	"case-list-select-text",
	"search-screen-title",
	"search-screen-subtitle",
	"search-input-label",
	"search-input-required-message",
	"search-input-validation-message",
	"search-runtime-validation-message",
]);

/** Whether a unit of `role` holds `contentPolicy: "require-nonblank"`: no translation of it may be
 *  blank. */
export function translationRoleRequiresNonblank(
	role: TranslationUnitRole,
): boolean {
	return NONBLANK_TRANSLATION_ROLES.has(role);
}

/** These units have a generated default and no ordinary source-text property. */
export function hasGeneratedWording(unit: TranslationUnit): boolean {
	return (
		unit.role === "search-runtime-validation-message" ||
		unit.generated !== undefined
	);
}

export interface LocalizedTranslationUnit extends TranslationUnit {
	readonly language: LanguageTag;
	readonly explicit?: TranslationEntry;
	readonly effective: LocalizedValue;
	readonly defaultText?: LocalizedValue;
	readonly status: TranslationStatus;
	/**
	 * The language whose text workers read in place of this current blank
	 * translation (`translationFill.ts::translationFillSource`).
	 */
	readonly filledFrom?: LanguageTag;
}

export const translationCoverageDiagnosticCodes = [
	"lookup-labels-need-localized-data",
	"case-labels-need-localized-data",
	"connect-text-has-no-locale-carrier",
	"media-is-shared-across-locales",
	"automation-language-is-recipient-owned",
] as const;
export type TranslationCoverageDiagnosticCode =
	(typeof translationCoverageDiagnosticCodes)[number];

export interface TranslationCoverageDiagnostic {
	readonly code: TranslationCoverageDiagnosticCode;
	readonly title: string;
	readonly explanation: string;
	readonly affectedCount: number;
}

/**
 * Honest limits adjacent to the static translation inventory. These carriers
 * remain valid app content, but counting them as translated would promise a
 * runtime behavior their current data or CommCare wire does not provide.
 */
export function collectTranslationCoverageDiagnostics(
	doc: BlueprintDoc,
): readonly TranslationCoverageDiagnostic[] {
	const diagnostics: TranslationCoverageDiagnostic[] = [];
	const lookupFields = Object.values(doc.fields).filter(
		(field) =>
			"optionsSource" in field && field.optionsSource.kind === "lookup",
	).length;
	const lookupSearchInputs = Object.values(doc.modules).reduce(
		(count, module) =>
			count +
			(module.caseListConfig?.searchInputs.filter(isSelectSearchInput).length ??
				0),
		0,
	);
	const lookupCarriers = lookupFields + lookupSearchInputs;
	if (lookupCarriers > 0) {
		diagnostics.push({
			code: "lookup-labels-need-localized-data",
			title: "Lookup table choices come from your Project data",
			explanation:
				"These choices come from a lookup table, which is shared Project data rather than app text, so translations here can't reach them.",
			affectedCount: lookupCarriers,
		});
	}
	const caseChoices = Object.values(doc.fields).filter(
		(field) => "optionsSource" in field && field.optionsSource.kind === "cases",
	).length;
	if (caseChoices > 0)
		diagnostics.push({
			code: "case-labels-need-localized-data",
			title: "Case choices use saved record labels",
			explanation:
				"These labels are record data. App translations don't change their saved wording.",
			affectedCount: caseChoices,
		});
	const connectActivities = Object.values(doc.fields).filter(
		(field) =>
			field.kind === "connect_activity" && field.activity.kind !== "assessment",
	).length;
	if (connectActivities > 0) {
		diagnostics.push({
			code: "connect-text-has-no-locale-carrier",
			title: "CommCare Connect names stay in one language",
			explanation:
				"CommCare Connect stores learn and delivery content in a single language, so names and descriptions there can't be translated per language.",
			affectedCount: connectActivities,
		});
	}
	const mediaRefs = collectAssetRefs(doc).size;
	if (mediaRefs > 0) {
		diagnostics.push({
			code: "media-is-shared-across-locales",
			title: "Media is shared across languages",
			explanation:
				"Images, audio, video, and other files are the same in every language right now.",
			affectedCount: mediaRefs,
		});
	}
	const automationCount = Object.keys(doc.automations ?? {}).length;
	if (automationCount > 0) {
		diagnostics.push({
			code: "automation-language-is-recipient-owned",
			title: "Automation messages follow the recipient's language",
			explanation:
				"Messages sent by automations follow the recipient's language settings rather than the language chosen here, so they aren't part of this list.",
			affectedCount: automationCount,
		});
	}
	return diagnostics;
}

function unit(
	input: Omit<TranslationUnit, "sourceFingerprint" | "contentPolicy">,
): TranslationUnit {
	const contentPolicy = translationRoleRequiresNonblank(input.role)
		? "require-nonblank"
		: "allow-blank";
	return {
		...input,
		contentPolicy,
		sourceFingerprint: translationSourceFingerprint(
			input.valueKind,
			input.source,
		),
	};
}

function proseLabel(field: Field, doc: BlueprintDoc): string {
	if (!("label" in field) || field.label === undefined) return field.id;
	return projectProseTemplate(field.label, doc).text || field.id;
}

function moduleMenuBreadcrumb(
	doc: BlueprintDoc,
	module: Module,
): readonly string[] {
	const parent =
		module.parentModuleUuid === undefined
			? undefined
			: doc.modules[module.parentModuleUuid];
	return parent === undefined
		? [doc.appName, module.name]
		: [doc.appName, parent.name, module.name];
}

interface FormWalkContext {
	readonly module: Module;
	readonly formUuid: Uuid;
	readonly formName: string;
}

function fieldUnits(
	doc: BlueprintDoc,
	context: FormWalkContext,
	parentUuid: Uuid,
	ancestorLabels: readonly string[],
	out: TranslationUnit[],
): void {
	for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
		const field = doc.fields[fieldUuid];
		if (field === undefined) continue;
		const label = proseLabel(field, doc);
		const breadcrumb = [
			...moduleMenuBreadcrumb(doc, context.module),
			context.formName,
			...ancestorLabels,
			label,
		];
		const owner = {
			kind: "field" as const,
			moduleUuid: context.module.uuid,
			formUuid: context.formUuid,
			fieldUuid,
		};
		const baseContext: TranslationUnitContext = {
			moduleName: context.module.name,
			formName: context.formName,
			fieldId: field.id,
			fieldKind: field.kind,
		};
		const addProse = (
			role: Extract<
				TranslationUnitRole,
				| "field-label"
				| "field-hint"
				| "field-help"
				| "field-validation-message"
				| "field-first-add-label"
				| "field-add-label"
				| LabelTextRole
				| ExtendedFieldTextRole
			>,
			slot: string,
			value: ProseTemplate | undefined,
		): void => {
			if (value === undefined) return;
			out.push(
				unit({
					id: makeTranslationUnitId("field", fieldUuid, slot),
					valueKind: "prose",
					role,
					source: value,
					owner,
					breadcrumb,
					context: baseContext,
				}),
			);
		};

		addProse(
			"field-label",
			"label",
			"label" in field ? field.label : undefined,
		);
		for (const slot of LABEL_TEXT_SLOTS)
			addProse(LABEL_TEXT_ROLES[slot], slot, labelTextOf(field, slot));
		addProse("field-hint", "hint", "hint" in field ? field.hint : undefined);
		addProse("field-help", "help", "help" in field ? field.help : undefined);
		addProse(
			"field-extended-hint",
			"extended_hint",
			"extended_hint" in field ? field.extended_hint : undefined,
		);
		addProse(
			"field-extended-help",
			"extended_help",
			"extended_help" in field ? field.extended_help : undefined,
		);
		addProse(
			"field-extended-validation-message",
			"extended_validate_msg",
			"extended_validate_msg" in field
				? field.extended_validate_msg
				: undefined,
		);
		addProse(
			"field-validation-message",
			"validate_msg",
			"validate_msg" in field ? field.validate_msg : undefined,
		);

		if (field.kind === "repeat") {
			addProse("field-first-add-label", "addFirstLabel", field.addFirstLabel);
			addProse("field-add-label", "addLabel", field.addLabel);
		}

		if ("optionsSource" in field && field.optionsSource.kind === "inline") {
			for (const option of field.optionsSource.options) {
				const terms = [
					["option", "select-option-label", option.label],
					[
						"option_extended_text",
						"select-option-extended-text",
						option.extended_text,
					],
				] as const;
				for (const [slot, role, source] of terms) {
					if (source === undefined) continue;
					out.push(
						unit({
							id: makeTranslationUnitId("field", fieldUuid, slot, option.uuid),
							valueKind: "prose",
							role,
							source,
							owner: {
								kind: "select-option",
								moduleUuid: context.module.uuid,
								formUuid: context.formUuid,
								fieldUuid,
								optionUuid: option.uuid,
							},
							breadcrumb: [...breadcrumb, option.value],
							context: { ...baseContext, optionValue: option.value },
						}),
					);
				}
			}
		}

		if (isContainer(field)) {
			fieldUnits(doc, context, fieldUuid, [...ancestorLabels, label], out);
		}
	}
}

/** A case property with its effective type: declared, else its writers' (`effectiveCaseTypes`),
 *  the type the case list's projection reads when it writes a select property's labels. */
function caseProperty(
	doc: BlueprintDoc,
	caseType: string | undefined,
	property: string,
): CaseProperty | undefined {
	return effectiveCaseTypes(doc)
		.find((candidate) => candidate.name === caseType)
		?.properties.find((candidate) => candidate.name === property);
}

/**
 * Stable identity for one occurrence of a case-property option value.
 *
 * CommCare permits repeated stored values in the catalog. The value remains
 * the identity of the first occurrence for backward compatibility; later
 * occurrences add their zero-based same-value ordinal so every legal label has
 * an injective translation unit instead of silently sharing the first one.
 */
export function casePropertyOptionTranslationUnitId(
	caseType: string,
	property: string,
	value: string,
	occurrence = 0,
): TranslationUnitId {
	return occurrence === 0
		? makeTranslationUnitId("case-property-option", caseType, property, value)
		: makeTranslationUnitId(
				"case-property-option",
				caseType,
				property,
				value,
				`occurrence:${occurrence}`,
			);
}

/** Zero-based ordinal among options carrying the same stored value. */
export function casePropertyOptionOccurrence(
	options: readonly { readonly value: string }[],
	index: number,
): number {
	const option = options[index];
	if (option === undefined) {
		throw new Error(`Case-property option index ${index} is out of range.`);
	}
	let occurrence = 0;
	for (let prior = 0; prior < index; prior += 1) {
		if (options[prior]?.value === option.value) occurrence += 1;
	}
	return occurrence;
}

function addCasePropertyOptionUnits(
	doc: BlueprintDoc,
	module: Module,
	property: CaseProperty,
	seen: Set<TranslationUnitId>,
	out: TranslationUnit[],
	caseType: string = module.caseType ?? "",
): void {
	if (
		property.data_type !== "single_select" &&
		property.data_type !== "multi_select"
	)
		return;
	const options = property.options ?? [];
	for (const [index, option] of options.entries()) {
		const occurrence = casePropertyOptionOccurrence(options, index);
		const id = casePropertyOptionTranslationUnitId(
			caseType,
			property.name,
			option.value,
			occurrence,
		);
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(
			unit({
				id,
				valueKind: "prose",
				role: "case-property-option-label",
				source: option.label,
				owner: {
					kind: "case-property-option",
					caseType,
					property: property.name,
					value: option.value,
					occurrence,
				},
				breadcrumb: [
					...moduleMenuBreadcrumb(doc, module),
					property.name,
					option.value,
				],
				context: {
					moduleName: module.name,
					caseType: module.caseType,
					caseProperty: property.name,
					optionValue: option.value,
				},
			}),
		);
	}
}

/** Deterministic source-order inventory of every localizable static string. */
export function collectTranslationUnits(
	doc: BlueprintDoc,
): readonly TranslationUnit[] {
	const out: TranslationUnit[] = [
		unit({
			id: makeTranslationUnitId("app", "name"),
			valueKind: "text",
			role: "app-name",
			source: doc.appName,
			owner: { kind: "app" },
			breadcrumb: [doc.appName],
			context: {},
		}),
	];
	const seenCaseOptions = new Set<TranslationUnitId>();
	let relationTypes: ReturnType<typeof caseTypesWithRelations> | undefined;
	const dormantBases: TranslationUnit[] = [];
	const dormantCaseOptions = new Set<TranslationUnitId>();
	let hasSearchInputs = false;
	let needsDefaultRequiredMessage = false;

	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		const moduleBreadcrumb = moduleMenuBreadcrumb(doc, module);
		out.push(
			unit({
				id: makeTranslationUnitId("module", moduleUuid, "name"),
				valueKind: "text",
				role: "module-name",
				source: module.name,
				owner: { kind: "module", moduleUuid },
				breadcrumb: moduleBreadcrumb,
				context: { moduleName: module.name },
			}),
		);
		if (module.badge?.kind === "text")
			out.push(
				unit({
					id: makeTranslationUnitId("module", moduleUuid, "badge"),
					valueKind: "text",
					role: "menu-badge",
					source: module.badge.text,
					owner: { kind: "module", moduleUuid },
					breadcrumb: [...moduleBreadcrumb, "Badge"],
					context: { moduleName: module.name },
				}),
			);
		// The case list menu entry's own label, when authored; the wire falls
		// back to the module-name unit when it is not.
		if (module.caseListMenuItem?.label !== undefined) {
			out.push(
				unit({
					id: makeTranslationUnitId(
						"module",
						moduleUuid,
						"case-list-menu-item-label",
					),
					valueKind: "text",
					role: "case-list-menu-item-label",
					source: module.caseListMenuItem.label,
					owner: { kind: "module", moduleUuid },
					breadcrumb: [...moduleBreadcrumb, "case list entry"],
					context: { moduleName: module.name },
				}),
			);
		}
		const registration = module.caseListRegistrationForm;
		// The Register button of a list that always offers another menu's
		// form: the module owns its label, and the form is not its own.
		if (registration?.kind === "always" && registration.label !== undefined) {
			const formName = doc.forms[registration.formUuid]?.name ?? "";
			out.push(
				unit({
					id: makeTranslationUnitId(
						"module",
						moduleUuid,
						"case-list-registration-label",
					),
					valueKind: "text",
					role: "case-list-registration-label",
					source: registration.label,
					owner: { kind: "module", moduleUuid },
					breadcrumb: [...moduleBreadcrumb, "case list", "Register button"],
					context: { moduleName: module.name, formName },
				}),
			);
		}

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			out.push(
				unit({
					id: makeTranslationUnitId("form", formUuid, "name"),
					valueKind: "text",
					role: "form-name",
					source: form.name,
					owner: { kind: "form", moduleUuid, formUuid },
					breadcrumb: [...moduleBreadcrumb, form.name],
					context: { moduleName: module.name, formName: form.name },
				}),
			);
			if (form.badge?.kind === "text")
				out.push(
					unit({
						id: makeTranslationUnitId("form", formUuid, "badge"),
						valueKind: "text",
						role: "menu-badge",
						source: form.badge.text,
						owner: { kind: "form", moduleUuid, formUuid },
						breadcrumb: [...moduleBreadcrumb, form.name, "Badge"],
						context: { moduleName: module.name, formName: form.name },
					}),
				);
			if (form.submitLabel !== undefined)
				out.push(
					unit({
						id: makeTranslationUnitId("form", formUuid, "submit-label"),
						valueKind: "text",
						role: "form-submit-label",
						source: form.submitLabel.text ?? DEFAULT_FORM_SUBMIT_LABEL,
						owner: { kind: "form", moduleUuid, formUuid },
						breadcrumb: [...moduleBreadcrumb, form.name, "Submit button"],
						context: { moduleName: module.name, formName: form.name },
					}),
				);
			// The Register action's label on Results, when authored; the
			// wire falls back to the form-name unit when it is not. The
			// module owns it, beside the form its slot names.
			if (
				registration?.kind === "after-empty-search" &&
				registration.formUuid === formUuid &&
				registration.label !== undefined
			) {
				out.push(
					unit({
						id: makeTranslationUnitId(
							"module",
							moduleUuid,
							"case-list-registration-label",
						),
						valueKind: "text",
						role: "case-list-registration-label",
						source: registration.label,
						owner: { kind: "module", moduleUuid },
						breadcrumb: [...moduleBreadcrumb, form.name, "action label"],
						context: { moduleName: module.name, formName: form.name },
					}),
				);
			}
			fieldUnits(
				doc,
				{ module, formUuid, formName: form.name },
				formUuid,
				[],
				out,
			);
		}

		const list = module.caseListConfig;
		for (const [slot, role, source, label] of [
			["empty", "case-list-empty-text", list?.emptyText, "empty list text"],
			[
				"select",
				"case-list-select-text",
				list?.selectButtonText,
				"Continue button",
			],
		] as const) {
			if (source === undefined) continue;
			out.push(
				unit({
					id: caseListWordingUnitId(moduleUuid, slot),
					valueKind: "text",
					role,
					source,
					owner: { kind: "module", moduleUuid },
					breadcrumb: [...moduleBreadcrumb, "Cases", "Results", label],
					context: { moduleName: module.name },
				}),
			);
		}
		for (const rule of list?.calculatedSorts ?? []) {
			if (rule.label)
				out.push(
					unit({
						id: makeTranslationUnitId("case-sort", rule.uuid, "label"),
						valueKind: "text",
						role: "case-list-sort-label",
						source: rule.label,
						owner: { kind: "module", moduleUuid },
						breadcrumb: [
							...moduleBreadcrumb,
							"Cases",
							"Default order",
							rule.label,
						],
						context: { moduleName: module.name },
					}),
				);
		}
		for (const tab of list?.detailTabs ?? []) {
			out.push(
				unit({
					id: makeTranslationUnitId("detail-tab", tab.uuid, "title"),
					role: "case-detail-tab-title",
					valueKind: "text",
					source: tab.title,
					owner: { kind: "module", moduleUuid },
					breadcrumb: [...moduleBreadcrumb, "Cases", "Details", tab.title],
					context: { moduleName: module.name, detailTabUuid: tab.uuid },
				}),
			);
		}
		for (const column of list?.columns ?? []) {
			// A sort rule's name in the list's Sort by menu, on a column hidden
			// from Results, whether or not Details shows the column.
			const sortLabel = column.sort?.label;
			(columnSortLabelShows(column) ? out : dormantBases).push(
				unit({
					id: makeTranslationUnitId("column", column.uuid, "sort-label"),
					valueKind: "text",
					role: "case-list-sort-label",
					source: sortLabel ?? "",
					owner: {
						kind: "case-list-column",
						moduleUuid,
						columnUuid: column.uuid,
					},
					breadcrumb: [
						...moduleBreadcrumb,
						"Cases",
						sortLabel ?? column.header,
						"Sort by",
					],
					context: { moduleName: module.name, columnKind: column.kind },
				}),
			);
			if (column.kind === "calculated") {
				for (const [index, item] of (column.texts ?? []).entries())
					out.push(
						unit({
							id: makeTranslationUnitId(
								"column",
								column.uuid,
								"calculation-text",
								item.uuid,
							),
							valueKind: "text",
							role: "case-list-calculation-text",
							source: item.label,
							owner: {
								kind: "case-list-column",
								moduleUuid,
								columnUuid: column.uuid,
							},
							breadcrumb: [
								...moduleBreadcrumb,
								"Cases",
								column.header,
								`Text ${index + 1}`,
							],
							context: { moduleName: module.name, columnKind: column.kind },
						}),
					);
			}
			const visible = caseListColumnTextShows(column);
			const columnUnits = visible ? out : dormantBases;
			const owner = {
				kind: "case-list-column" as const,
				moduleUuid,
				columnUuid: column.uuid,
			};
			const context: TranslationUnitContext = {
				moduleName: module.name,
				columnKind: column.kind,
			};
			columnUnits.push(
				unit({
					id: makeTranslationUnitId("column", column.uuid, "header"),
					valueKind: "text",
					role: "case-list-header",
					source: column.header,
					owner,
					breadcrumb: [...moduleBreadcrumb, "Cases", column.header],
					context,
				}),
			);
			if (column.kind === "image-map") {
				for (const [index, item] of column.mapping.entries()) {
					if (item.altText === undefined) continue;
					columnUnits.push(
						unit({
							id: caseMappingTextUnit(column.uuid, item, "image-description"),
							valueKind: "text",
							role: "case-list-image-description",
							source: item.altText,
							owner,
							breadcrumb: [
								...moduleBreadcrumb,
								"Cases",
								column.header,
								item.value ?? `Rule ${index + 1}`,
							],
							context: { ...context, optionValue: item.value },
						}),
					);
				}
			}
			if (column.kind === "id-mapping") {
				for (const [index, mapping] of column.mapping.entries()) {
					columnUnits.push(
						unit({
							id: caseMappingTextUnit(column.uuid, mapping, "mapping"),
							valueKind: "text",
							role: "case-list-mapping-label",
							source: mapping.label,
							owner,
							breadcrumb: [
								...moduleBreadcrumb,
								"Cases",
								column.header,
								mapping.value ?? `Rule ${index + 1}`,
							],
							context: { ...context, optionValue: mapping.value },
						}),
					);
				}
			}
			if (column.kind === "interval") {
				columnUnits.push(
					unit({
						id: makeTranslationUnitId("column", column.uuid, "text"),
						valueKind: "text",
						role: "case-list-interval-text",
						source: column.text,
						owner,
						breadcrumb: [
							...moduleBreadcrumb,
							"Cases",
							column.header,
							"threshold text",
						],
						context,
					}),
				);
			}
			if (column.kind === "plain" && column.showChoice !== "saved-value") {
				// A column read through a relation shows the options of the case
				// its walk reaches.
				if (column.via !== undefined)
					relationTypes ??= caseTypesWithRelations(doc);
				const caseType = columnPropertyCaseType(
					column,
					module.caseType,
					relationTypes ?? doc.caseTypes ?? [],
				);
				const property = caseProperty(doc, caseType, column.field);
				if (property !== undefined && caseType !== undefined) {
					addCasePropertyOptionUnits(
						doc,
						module,
						property,
						visible ? seenCaseOptions : dormantCaseOptions,
						columnUnits,
						caseType,
					);
				}
			}
		}

		for (const input of list?.searchInputs ?? []) {
			hasSearchInputs = true;
			out.push(
				unit({
					id: makeTranslationUnitId("search-input", input.uuid, "label"),
					valueKind: "text",
					role: "search-input-label",
					source: input.label !== "" ? input.label : input.name,
					owner: {
						kind: "search-input",
						moduleUuid,
						searchInputUuid: input.uuid,
					},
					breadcrumb: [...moduleBreadcrumb, "Search", input.label],
					context: { moduleName: module.name },
				}),
			);
			if (input.kind === "hidden") continue;
			const inputOwner = {
				kind: "search-input" as const,
				moduleUuid,
				searchInputUuid: input.uuid,
			};
			const inputBreadcrumb = [
				...moduleBreadcrumb,
				"Search",
				input.label !== "" ? input.label : input.name,
			];
			if (input.hint !== undefined) {
				out.push(
					unit({
						id: makeTranslationUnitId("search-input", input.uuid, "hint"),
						valueKind: "text",
						role: "search-input-hint",
						source: input.hint,
						owner: inputOwner,
						breadcrumb: [...inputBreadcrumb, "hint"],
						context: { moduleName: module.name },
					}),
				);
			}
			// A requirement with no message at all, and a check with none of its
			// own, which shows CommCare's sentence, have no text to translate.
			if (input.required !== undefined && input.required.noMessage !== true) {
				if (input.required.message === undefined) {
					needsDefaultRequiredMessage = true;
				} else {
					out.push(
						unit({
							id: makeTranslationUnitId(
								"search-input",
								input.uuid,
								"required-message",
							),
							valueKind: "text",
							role: "search-input-required-message",
							source: input.required.message,
							owner: inputOwner,
							breadcrumb: [...inputBreadcrumb, "required message"],
							context: { moduleName: module.name },
						}),
					);
				}
			}
			if (input.validation?.message !== undefined) {
				out.push(
					unit({
						id: makeTranslationUnitId(
							"search-input",
							input.uuid,
							"validation-message",
						),
						valueKind: "text",
						role: "search-input-validation-message",
						source: input.validation.message,
						owner: inputOwner,
						breadcrumb: [...inputBreadcrumb, "validation message"],
						context: { moduleName: module.name },
					}),
				);
			}
		}

		const search = effectiveCaseSearchConfig(module);
		if (search !== undefined) {
			const searchOwner = { kind: "module" as const, moduleUuid };
			// Every search has a title unit. A search with no title in its
			// source language holds the unit blank there, and another language
			// may show a heading of its own (`searchScreenTitleIn`).
			out.push(
				unit({
					id: makeTranslationUnitId("module", moduleUuid, "search-title"),
					valueKind: "text",
					role: "search-screen-title",
					source: searchScreenTitleText(search) ?? "",
					owner: searchOwner,
					breadcrumb: [...moduleBreadcrumb, "Search", "title"],
					context: { moduleName: module.name },
				}),
			);
			if (search.searchScreenSubtitle !== undefined) {
				out.push(
					unit({
						id: makeTranslationUnitId("module", moduleUuid, "search-subtitle"),
						valueKind: "text",
						role: "search-screen-subtitle",
						source: search.searchScreenSubtitle,
						owner: searchOwner,
						breadcrumb: [...moduleBreadcrumb, "Search", "subtitle"],
						context: { moduleName: module.name },
					}),
				);
			}
		}
	}

	const saved = [
		doc.localization?.generatedSourceWording,
		...Object.values(doc.localization?.translations ?? {}),
	];
	const hasSavedWording = (id: string) =>
		saved.some((entries) => entries && Object.hasOwn(entries, id));
	for (const message of SEARCH_RUNTIME_VALIDATION_MESSAGES) {
		const id = makeTranslationUnitId(
			"system",
			"search-validation",
			message.key,
		);
		if (!hasSearchInputs && !hasSavedWording(id)) continue;
		out.push(
			unit({
				id,
				valueKind: "text",
				role: "search-runtime-validation-message",
				source: message.message,
				owner: { kind: "app" },
				breadcrumb: [
					doc.appName,
					"Search",
					"System messages",
					message.description,
				],
				context: { systemMessageDescription: message.description },
			}),
		);
	}
	const requiredId = makeTranslationUnitId(
		"system",
		"search-required",
		"default",
	);
	if (needsDefaultRequiredMessage || hasSavedWording(requiredId)) {
		const description = "Search answer required";
		out.push(
			unit({
				id: requiredId,
				valueKind: "text",
				role: "search-runtime-validation-message",
				source: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
				owner: { kind: "app" },
				breadcrumb: [doc.appName, "Search", "System messages", description],
				context: { systemMessageDescription: description },
			}),
		);
	}

	out.push(...generatedWordingUnits(doc, [...dormantBases, ...out]).map(unit));
	// A generated original lives outside the ordinary source property. Edits
	// to it invalidate source-dependent drafts and open review forms alike.
	const originals = doc.localization?.generatedSourceWording;
	if (!originals) return out;
	const savedText = (id: TranslationUnitId) => {
		const entry = originals[id];
		if (entry) return entry.workerFallback?.value ?? entry.value;
	};
	return out.map((row) => {
		if (!hasGeneratedWording(row)) return row;
		const own = savedText(row.id);
		const value =
			own === undefined || own === ""
				? row.generated?.base && savedText(row.generated.base)
				: own;
		return value === undefined || value === ""
			? row
			: {
					...row,
					sourceFingerprint: translationSourceFingerprint(row.valueKind, value),
				};
	});
}

export function translationUnitsById(
	doc: BlueprintDoc,
): ReadonlyMap<TranslationUnitId, TranslationUnit> {
	return new Map(
		collectTranslationUnits(doc).map((entry) => [entry.id, entry]),
	);
}

const snapshotTranslationUnitsByDoc = new WeakMap<
	BlueprintDoc,
	ReadonlyMap<TranslationUnitId, TranslationUnit>
>();

/**
 * `translationUnitsById` for one document snapshot, built once and shared by
 * every reader of that snapshot: the builder's hooks, the commit gate's
 * validator, an emission run and a Preview rebuild. A `BlueprintDoc` is an
 * immutable snapshot (each edit produces a new one), so the inventory keyed
 * by its identity never goes stale, and a superseded snapshot's inventory is
 * discarded with it. A caller holding a document it changes in place reads
 * `translationUnitsById` instead.
 */
export function snapshotTranslationUnits(
	doc: BlueprintDoc,
): ReadonlyMap<TranslationUnitId, TranslationUnit> {
	const cached = snapshotTranslationUnitsByDoc.get(doc);
	if (cached !== undefined) return cached;
	const units = translationUnitsById(doc);
	snapshotTranslationUnitsByDoc.set(doc, units);
	return units;
}

/** The translation unit an expression's `jr:itext` read names: a question's
 * label, hint, help or validation message, or one of its written choices. */
export function itextUnitTranslationId(unit: ItextUnit): TranslationUnitId {
	if (unit.role === "select-option-label")
		return makeTranslationUnitId("field", unit.field, "option", unit.option);
	return makeTranslationUnitId(
		"field",
		unit.field,
		FIELD_ITEXT_SLOTS[unit.role],
	);
}

function holdsReference(value: LocalizedValue): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		value.parts.some((part) => part.kind !== "text")
	);
}

/**
 * Whether a unit's text shows an answer (or any other reference) in some
 * language of the app. CommCare stores such text with a `${n}` placeholder
 * for each reference (`XFormParser.java::recurseForOutput`), so `jr:itext` of
 * it, and `jr:choice-name` of a choice it labels, return the placeholder and
 * never the answer.
 */
export function translationUnitShowsAnswer(
	doc: BlueprintDoc,
	unitValue: TranslationUnit,
): boolean {
	if (unitValue.valueKind !== "prose") return false;
	return effectiveAppLocalization(doc.localization).languageOrder.some(
		(language) =>
			holdsReference(storedTranslationValue(doc, language, unitValue)),
	);
}

const formUnitsByDoc = new WeakMap<
	BlueprintDoc,
	ReadonlyMap<
		Uuid,
		ReadonlyMap<TranslationUnitId, { readonly showsAnswer: boolean }>
	>
>();

/**
 * The translation units each form's questions and choices own, with whether
 * each shows an answer in some language (`translationUnitShowsAnswer`), for
 * one document snapshot. A form whose questions own no unit is absent.
 */
export function formTranslationUnits(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlyMap<TranslationUnitId, { readonly showsAnswer: boolean }> {
	let byForm = formUnitsByDoc.get(doc);
	if (byForm === undefined) {
		const built = new Map<
			Uuid,
			Map<TranslationUnitId, { readonly showsAnswer: boolean }>
		>();
		// The questions' units are walked here form by form, never through the whole inventory:
		// expression inference reads these, and the inventory's case-list units read the case
		// types inference derives (`caseProperty`).
		const formUnits: TranslationUnit[] = [];
		for (const moduleUuid of doc.moduleOrder) {
			const module = doc.modules[moduleUuid];
			if (module === undefined) continue;
			for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
				const form = doc.forms[formUuid];
				if (form === undefined) continue;
				fieldUnits(
					doc,
					{ module, formUuid, formName: form.name },
					formUuid,
					[],
					formUnits,
				);
			}
		}
		for (const unitValue of formUnits) {
			const owner = unitValue.owner;
			if (owner.kind !== "field" && owner.kind !== "select-option") continue;
			let units = built.get(owner.formUuid);
			if (units === undefined) {
				units = new Map();
				built.set(owner.formUuid, units);
			}
			units.set(unitValue.id, {
				showsAnswer: translationUnitShowsAnswer(doc, unitValue),
			});
		}
		byForm = built;
		formUnitsByDoc.set(doc, byForm);
	}
	return byForm.get(formUuid) ?? new Map();
}

function sameValueKind(unit: TranslationUnit, value: LocalizedValue): boolean {
	return unit.valueKind === "text"
		? typeof value === "string"
		: typeof value === "object" && value !== null;
}

/** The prose slot a field's text unit translates: where a calculated value
 *  in it is checked and printed. Every other unit holds text no form
 *  evaluates, so it has none. */
export function translationUnitProseSlot(
	unit: Pick<TranslationUnit, "owner" | "role">,
): ProseSlotRef | undefined {
	const owner = unit.owner;
	if (owner.kind === "select-option")
		return {
			entity: "field",
			uuid: owner.fieldUuid,
			slot:
				unit.role === "select-option-extended-text"
					? "option_extended_text"
					: "option_label",
			member: { optionUuid: owner.optionUuid },
		};
	if (owner.kind !== "field") return undefined;
	switch (unit.role) {
		case "field-label":
			return { entity: "field", uuid: owner.fieldUuid, slot: "label" };
		case "field-hint":
			return { entity: "field", uuid: owner.fieldUuid, slot: "hint" };
		case "field-help":
			return { entity: "field", uuid: owner.fieldUuid, slot: "help" };
		case "field-first-add-label":
		case "field-add-label":
		case "field-validation-message":
			return {
				entity: "field",
				uuid: owner.fieldUuid,
				slot: FIELD_ITEXT_SLOTS[unit.role],
			};
		case "field-extended-hint":
		case "field-extended-help":
		case "field-extended-validation-message":
			return {
				entity: "field",
				uuid: owner.fieldUuid,
				slot: EXTENDED_FIELD_TEXT_SLOT_OF_ROLE[unit.role],
			};
		case "field-extended-text":
		case "field-qr-code":
		case "field-spoken-text":
			return {
				entity: "field",
				uuid: owner.fieldUuid,
				slot: LABEL_TEXT_SLOT_OF_ROLE[unit.role],
			};
		default:
			return undefined;
	}
}

/** A protected part's identity: a reference by what it names, a calculated
 *  value by its whole expression, so a translation may move a value and may
 *  not change it. */
function proseReferenceIdentity(part: ProseAtomPart): string {
	switch (part.kind) {
		case "value":
			return `value\0${canonicalJsonText(part.expression)}`;
		case "field-ref":
			return `field-ref\0${part.uuid}`;
		case "case-ref":
			return `case-ref\0${part.caseType}\0${part.property}`;
		case "user-property-ref":
			return `user-property-ref\0${part.userPropertyUuid}`;
		case "user-ref":
			return `user-ref\0${part.property}`;
	}
}

function proseReferenceSignature(template: ProseTemplate): readonly string[] {
	return template.parts
		.filter((part): part is ProseAtomPart => part.kind !== "text")
		.map(proseReferenceIdentity)
		.sort();
}

export type TranslationValueIntegrityIssue =
	| "value-kind"
	| "blank-content"
	| "protected-content";

/** References are protected tokens: translation may move but not edit them. */
export function translationValueIntegrityIssue(
	unit: TranslationUnit,
	value: LocalizedValue,
): TranslationValueIntegrityIssue | undefined {
	if (!sameValueKind(unit, value)) return "value-kind";
	if (unit.valueKind === "text") {
		return unit.contentPolicy === "require-nonblank" &&
			(value as string).trim().length === 0
			? "blank-content"
			: undefined;
	}
	const source = unit.source as ProseTemplate;
	const translated = value as ProseTemplate;
	return JSON.stringify(proseReferenceSignature(source)) ===
		JSON.stringify(proseReferenceSignature(translated))
		? undefined
		: "protected-content";
}

/** A deliberate change to the values shown by one worker language. Plain
 * locale strings and prose outside a form have no expression context. */
export function authoredTranslationValueMode(
	unit: TranslationUnit,
	value: LocalizedValue,
): Pick<TranslationEntry, "valueMode"> {
	return translationUnitProseSlot(unit) !== undefined &&
		typeof unit.source !== "string" &&
		typeof value !== "string"
		? translatedProseValueMode(unit.source, value)
		: {};
}

export function translatedProseValueMode(
	source: ProseTemplate,
	target: ProseTemplate,
): Pick<TranslationEntry, "valueMode"> {
	return JSON.stringify(proseReferenceSignature(source)) ===
		JSON.stringify(proseReferenceSignature(target))
		? {}
		: { valueMode: "independent-values" };
}

/** Reviewing an independent translation against a new source can bring the
 * two sets of references back into agreement. */
export function reviewedTranslationValueMode(
	unit: TranslationUnit,
	entry: TranslationEntry,
): Pick<TranslationEntry, "valueMode"> {
	return entry.valueMode === undefined
		? {}
		: authoredTranslationValueMode(unit, entry.value);
}

/** The stricter two-argument check above is also the automatic translator's contract. */
export function translationEntryIntegrityIssue(
	unit: TranslationUnit,
	entry: Pick<TranslationEntry, "value" | "valueMode">,
): TranslationValueIntegrityIssue | undefined {
	const issue = translationValueIntegrityIssue(unit, entry.value);
	if (entry.valueMode === undefined) return issue;
	if (
		issue === "protected-content" &&
		translationUnitProseSlot(unit) !== undefined
	)
		return undefined;
	return issue ?? "protected-content";
}

interface StoredTranslation {
	readonly explicit?: TranslationEntry;
	readonly effective: LocalizedValue;
	readonly status: TranslationStatus;
}

/** Whether the stored draft can serve as current worker text for this source.
 * A still-active fallback deliberately keeps its saved draft separate. */
export function translationIsOutOfDate(
	entry: TranslationEntry,
	unit: TranslationUnit,
	language?: LanguageTag,
	isOriginal = false,
): boolean {
	const activeFallback =
		entry.workerFallback &&
		translationSourceFingerprintsEqual(
			entry.workerFallback.sourceFingerprint,
			unit.sourceFingerprint,
		);
	// A directly authored output, including a former original, belongs to
	// this control in this language. A translation draft also depends on the
	// source text it was prepared against, even after a person reviews it.
	const independent =
		hasGeneratedWording(unit) &&
		(isOriginal ||
			entry.origin === "human" ||
			entry.translatedFrom === language);
	return (
		!!activeFallback ||
		(!independent &&
			!translationSourceFingerprintsEqual(
				entry.sourceFingerprint,
				unit.sourceFingerprint,
			)) ||
		translationEntryIntegrityIssue(unit, entry) !== undefined
	);
}

/** The wording produced without an override of this particular output. */
export function defaultWording(
	doc: BlueprintDoc,
	language: LanguageTag,
	unit: TranslationUnit,
): LocalizedValue {
	if (
		unit.role === "form-submit-label" &&
		language !== effectiveAppLocalization(doc.localization).sourceLanguage
	)
		return DEFAULT_FORM_SUBMIT_LABEL;
	const base =
		unit.generated?.base &&
		snapshotTranslationUnits(doc).get(unit.generated.base);
	const value = base
		? storedTranslation(doc, language, base).effective
		: unit.source;
	return typeof value === "string" || !unit.generated
		? value
		: projectProseTemplate(value, doc).text;
}

function storedTranslation(
	doc: BlueprintDoc,
	language: LanguageTag,
	unitValue: TranslationUnit,
): StoredTranslation {
	const localization = effectiveAppLocalization(doc.localization);
	if (!localization.languageOrder.includes(language)) {
		throw new Error(`Language ${language} does not belong to this app.`);
	}
	const isSource = language === localization.sourceLanguage;
	const explicit = isSource
		? localization.generatedSourceWording?.[unitValue.id]
		: localization.translations[language]?.[unitValue.id];
	if (
		explicit === undefined ||
		(unitValue.generated && explicit.value === "")
	) {
		if (unitValue.generated) {
			return {
				...(explicit && { explicit }),
				effective: defaultWording(doc, language, unitValue),
				status: "ready",
			};
		}
		return {
			effective: defaultWording(doc, language, unitValue),
			status:
				isSource ||
				(unitValue.role === "search-screen-title" && unitValue.source === "")
					? "ready"
					: "missing",
		};
	}
	const fallback = explicit.workerFallback;
	if (
		fallback !== undefined &&
		translationSourceFingerprintsEqual(
			fallback.sourceFingerprint,
			unitValue.sourceFingerprint,
		) &&
		translationValueIntegrityIssue(unitValue, fallback.value) === undefined
	) {
		return { explicit, effective: fallback.value, status: "out-of-date" };
	}
	if (translationIsOutOfDate(explicit, unitValue, language, isSource)) {
		return {
			explicit,
			effective: defaultWording(doc, language, unitValue),
			status: "out-of-date",
		};
	}
	return {
		explicit,
		effective: explicit.value,
		status: explicit.review === "reviewed" ? "ready" : "needs-review",
	};
}

/**
 * The value a unit stores for one language: the source language's canonical
 * value, a current translation, or the source where the translation is
 * missing or stale. It is the value before the form builder's fill
 * (`translationFill.ts`), which reads it for every language.
 */
export function storedTranslationValue(
	doc: BlueprintDoc,
	language: LanguageTag,
	unitValue: TranslationUnit,
): LocalizedValue {
	return storedTranslation(doc, language, unitValue).effective;
}

/**
 * One unit in one language. A current translation of an itext role that is
 * blank beside text in another language is `missing`, with `filledFrom`
 * naming the language whose text workers read in its place; it keeps its
 * stored blank as `effective`.
 */
export function localizeTranslationUnit(
	doc: BlueprintDoc,
	language: LanguageTag,
	unitValue: TranslationUnit,
): LocalizedTranslationUnit {
	const stored = storedTranslation(doc, language, unitValue);
	const original = hasGeneratedWording(unitValue)
		? storedTranslation(
				doc,
				effectiveAppLocalization(doc.localization).sourceLanguage,
				unitValue,
			).effective
		: unitValue.source;
	const localized: LocalizedTranslationUnit = {
		...unitValue,
		source: original,
		language,
		...(hasGeneratedWording(unitValue) && {
			defaultText: defaultWording(doc, language, unitValue),
		}),
		...stored,
	};
	if (stored.explicit === undefined || stored.status === "out-of-date") {
		return localized;
	}
	const filledFrom = translationFillSource(doc, unitValue, language);
	return filledFrom === undefined
		? localized
		: { ...localized, status: "missing", filledFrom };
}

export function collectLocalizedTranslationUnits(
	doc: BlueprintDoc,
	language: LanguageTag,
): readonly LocalizedTranslationUnit[] {
	return collectTranslationUnits(doc)
		.filter((unit) => !unit.generated?.dormant)
		.map((entry) => localizeTranslationUnit(doc, language, entry));
}

/**
 * The units a language added by copying another takes a translation of: each
 * whose text, as the copied language shows it, can be a translation. A unit
 * whose shown text can't (a Search title the app shows none of, blank where
 * its role needs text) gets none, and the new language shows what the unit
 * holds, as the copied language does. Shared by every editor that adds a
 * language, so none copies what the gate refuses.
 */
export function unitsCopiedToANewLanguage<T extends LocalizedTranslationUnit>(
	units: readonly T[],
): readonly T[] {
	return units.filter(
		(unit) =>
			(!unit.generated || unit.explicit !== undefined) &&
			translationValueIntegrityIssue(unit, unit.effective) === undefined,
	);
}

export function resolveTranslationUnitValue(
	doc: BlueprintDoc,
	language: LanguageTag,
	id: TranslationUnitId,
): LocalizedValue {
	const unitValue = translationUnitsById(doc).get(id);
	if (unitValue === undefined) {
		throw new Error(`Unknown translation unit ${id}.`);
	}
	return localizeTranslationUnit(doc, language, unitValue).effective;
}
