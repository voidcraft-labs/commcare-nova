// lib/domain/translationUnits.ts
//
// The one inventory and effective-value resolver for every static
// worker-facing Blueprint string Nova can localize. Builder, Preview, tools,
// translation orchestration, and CommCare emission consume this projection;
// none independently walks display slots.

import type { BlueprintDoc, CaseProperty } from "./blueprint";
import type { Field } from "./fields";
import { isContainer } from "./fields";
import {
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedValue,
	makeTranslationUnitId,
	type TranslationEntry,
	type TranslationUnitId,
	translationSourceFingerprint,
} from "./localization";
import { collectAssetRefs } from "./mediaRefs";
import {
	caseListColumnIsEmitted,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	type Module,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
} from "./modules";
import {
	type ProseReferencePart,
	type ProseTemplate,
	projectProseTemplate,
} from "./prose";
import { SEARCH_RUNTIME_VALIDATION_MESSAGES } from "./searchRuntimeValidationMessages";
import type { Uuid } from "./uuid";

export const translationUnitRoles = [
	"app-name",
	"module-name",
	"form-name",
	"form-entry-label",
	"field-label",
	"field-hint",
	"field-help",
	"field-validation-message",
	"select-option-label",
	"case-list-header",
	"case-list-mapping-label",
	"case-list-interval-text",
	"search-input-label",
	"search-input-hint",
	"search-input-required-message",
	"search-input-validation-message",
	"search-screen-title",
	"search-screen-subtitle",
	"search-button-label",
	"search-runtime-validation-message",
	"case-property-option-label",
] as const;
export type TranslationUnitRole = (typeof translationUnitRoles)[number];

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
	readonly optionValue?: string;
	readonly caseType?: string;
	readonly caseProperty?: string;
	readonly systemMessageDescription?: string;
}

export interface TranslationUnit {
	readonly id: TranslationUnitId;
	readonly valueKind: "text" | "prose";
	readonly role: TranslationUnitRole;
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
	"app-name",
	"module-name",
	"form-name",
	"form-entry-label",
	"search-screen-title",
	"search-screen-subtitle",
	"search-button-label",
	"search-input-label",
	"search-input-required-message",
	"search-input-validation-message",
	"search-runtime-validation-message",
]);

export interface LocalizedTranslationUnit extends TranslationUnit {
	readonly language: LanguageTag;
	readonly explicit?: TranslationEntry;
	readonly effective: LocalizedValue;
	readonly status: TranslationStatus;
}

export const translationCoverageDiagnosticCodes = [
	"lookup-labels-need-localized-data",
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
	if (lookupFields > 0) {
		diagnostics.push({
			code: "lookup-labels-need-localized-data",
			title: "Lookup table choices come from your Project data",
			explanation:
				"These choices come from a lookup table, which is shared Project data rather than app text, so translations here can't reach them.",
			affectedCount: lookupFields,
		});
	}
	const connectForms = Object.values(doc.forms).filter(
		(form) => form.connect !== undefined,
	).length;
	if (connectForms > 0) {
		diagnostics.push({
			code: "connect-text-has-no-locale-carrier",
			title: "CommCare Connect names stay in one language",
			explanation:
				"CommCare Connect stores learn and delivery content in a single language, so names and descriptions there can't be translated per language.",
			affectedCount: connectForms,
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
	const contentPolicy = NONBLANK_TRANSLATION_ROLES.has(input.role)
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
				"field-label" | "field-hint" | "field-help" | "field-validation-message"
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
		addProse("field-hint", "hint", "hint" in field ? field.hint : undefined);
		addProse("field-help", "help", "help" in field ? field.help : undefined);
		addProse(
			"field-validation-message",
			"validate_msg",
			"validate_msg" in field ? field.validate_msg : undefined,
		);

		if ("optionsSource" in field && field.optionsSource.kind === "inline") {
			for (const option of field.optionsSource.options) {
				out.push(
					unit({
						id: makeTranslationUnitId(
							"field",
							fieldUuid,
							"option",
							option.uuid,
						),
						valueKind: "prose",
						role: "select-option-label",
						source: option.label,
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

		if (isContainer(field)) {
			fieldUnits(doc, context, fieldUuid, [...ancestorLabels, label], out);
		}
	}
}

function caseProperty(
	doc: BlueprintDoc,
	caseType: string | undefined,
	property: string,
): CaseProperty | undefined {
	return doc.caseTypes
		?.find((candidate) => candidate.name === caseType)
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
			module.caseType ?? "",
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
					caseType: module.caseType ?? "",
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
			// The Register action's label on Results, when authored; the
			// wire falls back to the form-name unit when it is not.
			if (form.entry?.label !== undefined) {
				out.push(
					unit({
						id: makeTranslationUnitId("form", formUuid, "entry-label"),
						valueKind: "text",
						role: "form-entry-label",
						source: form.entry.label,
						owner: { kind: "form", moduleUuid, formUuid },
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
		for (const column of list?.columns ?? []) {
			if (!caseListColumnIsEmitted(column)) continue;
			const owner = {
				kind: "case-list-column" as const,
				moduleUuid,
				columnUuid: column.uuid,
			};
			const context: TranslationUnitContext = {
				moduleName: module.name,
				columnKind: column.kind,
			};
			out.push(
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
			if (column.kind === "id-mapping") {
				for (const mapping of column.mapping) {
					out.push(
						unit({
							id: makeTranslationUnitId(
								"column",
								column.uuid,
								"mapping",
								mapping.value,
							),
							valueKind: "text",
							role: "case-list-mapping-label",
							source: mapping.label,
							owner,
							breadcrumb: [
								...moduleBreadcrumb,
								"Cases",
								column.header,
								mapping.value,
							],
							context: { ...context, optionValue: mapping.value },
						}),
					);
				}
			}
			if (column.kind === "interval") {
				out.push(
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
			if (column.kind === "plain") {
				const property = caseProperty(doc, module.caseType, column.field);
				if (property !== undefined) {
					addCasePropertyOptionUnits(
						doc,
						module,
						property,
						seenCaseOptions,
						out,
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
			if (input.required !== undefined) {
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
			if (input.validation !== undefined) {
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
			const title = search.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE;
			out.push(
				unit({
					id: makeTranslationUnitId("module", moduleUuid, "search-title"),
					valueKind: "text",
					role: "search-screen-title",
					source: title,
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
			out.push(
				unit({
					id: makeTranslationUnitId("module", moduleUuid, "search-button"),
					valueKind: "text",
					role: "search-button-label",
					source: search.searchButtonLabel ?? DEFAULT_CASE_SEARCH_BUTTON_LABEL,
					owner: searchOwner,
					breadcrumb: [...moduleBreadcrumb, "Search", "button"],
					context: { moduleName: module.name },
				}),
			);
		}
	}

	if (hasSearchInputs) {
		for (const message of SEARCH_RUNTIME_VALIDATION_MESSAGES) {
			out.push(
				unit({
					id: makeTranslationUnitId("system", "search-validation", message.key),
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
	}
	if (needsDefaultRequiredMessage) {
		const description = "Search answer required";
		out.push(
			unit({
				id: makeTranslationUnitId("system", "search-required", "default"),
				valueKind: "text",
				role: "search-runtime-validation-message",
				source: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
				owner: { kind: "app" },
				breadcrumb: [doc.appName, "Search", "System messages", description],
				context: { systemMessageDescription: description },
			}),
		);
	}

	return out;
}

export function translationUnitsById(
	doc: BlueprintDoc,
): ReadonlyMap<TranslationUnitId, TranslationUnit> {
	return new Map(
		collectTranslationUnits(doc).map((entry) => [entry.id, entry]),
	);
}

function sameValueKind(unit: TranslationUnit, value: LocalizedValue): boolean {
	return unit.valueKind === "text"
		? typeof value === "string"
		: typeof value === "object" && value !== null;
}

function proseReferenceIdentity(part: ProseReferencePart): string {
	switch (part.kind) {
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
		.filter((part): part is ProseReferencePart => part.kind !== "text")
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

export function localizeTranslationUnit(
	doc: BlueprintDoc,
	language: LanguageTag,
	unitValue: TranslationUnit,
): LocalizedTranslationUnit {
	const localization = effectiveAppLocalization(doc.localization);
	if (!localization.languageOrder.includes(language)) {
		throw new Error(`Language ${language} does not belong to this app.`);
	}
	if (language === localization.sourceLanguage) {
		return {
			...unitValue,
			language,
			effective: unitValue.source,
			status: "ready",
		};
	}
	const explicit = localization.translations[language]?.[unitValue.id];
	if (explicit === undefined) {
		return {
			...unitValue,
			language,
			effective: unitValue.source,
			status: "missing",
		};
	}
	const current =
		explicit.sourceFingerprint === unitValue.sourceFingerprint &&
		translationValueIntegrityIssue(unitValue, explicit.value) === undefined;
	if (!current) {
		return {
			...unitValue,
			language,
			explicit,
			effective: unitValue.source,
			status: "out-of-date",
		};
	}
	return {
		...unitValue,
		language,
		explicit,
		effective: explicit.value,
		status: explicit.review === "reviewed" ? "ready" : "needs-review",
	};
}

export function collectLocalizedTranslationUnits(
	doc: BlueprintDoc,
	language: LanguageTag,
): readonly LocalizedTranslationUnit[] {
	return collectTranslationUnits(doc).map((entry) =>
		localizeTranslationUnit(doc, language, entry),
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
