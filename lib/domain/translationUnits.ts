// lib/domain/translationUnits.ts
//
// The one inventory and effective-value resolver for every static
// worker-facing Blueprint string Nova can localize. Builder, Preview, tools,
// translation orchestration, and CommCare emission consume this projection;
// none independently walks display slots.

import type { BlueprintDoc, CaseProperty } from "./blueprint";
import type { Field } from "./fields";
import {
	effectiveAppLocalization,
	type LanguageCode,
	type LocalizedValue,
	makeTranslationUnitId,
	type TranslationEntry,
	type TranslationUnitId,
	translationSourceFingerprint,
} from "./localization";
import {
	caseListColumnIsEmitted,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	type Module,
} from "./modules";
import {
	type ProseReferencePart,
	type ProseTemplate,
	projectProseTemplate,
} from "./prose";

export const translationUnitRoles = [
	"app-name",
	"module-name",
	"form-name",
	"field-label",
	"field-hint",
	"field-help",
	"field-validation-message",
	"select-option-label",
	"case-list-header",
	"case-list-mapping-label",
	"case-list-interval-text",
	"search-input-label",
	"search-screen-title",
	"search-screen-subtitle",
	"search-button-label",
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
	| { readonly kind: "module"; readonly moduleUuid: string }
	| {
			readonly kind: "form";
			readonly moduleUuid: string;
			readonly formUuid: string;
	  }
	| {
			readonly kind: "field";
			readonly moduleUuid: string;
			readonly formUuid: string;
			readonly fieldUuid: string;
	  }
	| {
			readonly kind: "select-option";
			readonly moduleUuid: string;
			readonly formUuid: string;
			readonly fieldUuid: string;
			readonly optionUuid: string;
	  }
	| {
			readonly kind: "case-list-column";
			readonly moduleUuid: string;
			readonly columnUuid: string;
	  }
	| {
			readonly kind: "search-input";
			readonly moduleUuid: string;
			readonly searchInputUuid: string;
	  }
	| {
			readonly kind: "case-property-option";
			readonly caseType: string;
			readonly property: string;
			readonly value: string;
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
	"search-screen-title",
	"search-screen-subtitle",
	"search-button-label",
	"search-input-label",
]);

export interface LocalizedTranslationUnit extends TranslationUnit {
	readonly language: LanguageCode;
	readonly explicit?: TranslationEntry;
	readonly effective: LocalizedValue;
	readonly status: TranslationStatus;
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

interface FormWalkContext {
	readonly module: Module;
	readonly formUuid: string;
	readonly formName: string;
}

function fieldUnits(
	doc: BlueprintDoc,
	context: FormWalkContext,
	parentUuid: string,
	ancestorLabels: readonly string[],
	out: TranslationUnit[],
): void {
	for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
		const field = doc.fields[fieldUuid];
		if (field === undefined) continue;
		const label = proseLabel(field, doc);
		const breadcrumb = [
			doc.appName,
			context.module.name,
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

		if (field.kind === "group" || field.kind === "repeat") {
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
	for (const option of property.options ?? []) {
		const id = makeTranslationUnitId(
			"case-property-option",
			module.caseType ?? "",
			property.name,
			option.value,
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
				},
				breadcrumb: [doc.appName, module.name, property.name, option.value],
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

	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		out.push(
			unit({
				id: makeTranslationUnitId("module", moduleUuid, "name"),
				valueKind: "text",
				role: "module-name",
				source: module.name,
				owner: { kind: "module", moduleUuid },
				breadcrumb: [doc.appName, module.name],
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
					breadcrumb: [doc.appName, module.name, form.name],
					context: { moduleName: module.name, formName: form.name },
				}),
			);
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
					breadcrumb: [doc.appName, module.name, "Cases", column.header],
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
								doc.appName,
								module.name,
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
							doc.appName,
							module.name,
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
			out.push(
				unit({
					id: makeTranslationUnitId("search-input", input.uuid, "label"),
					valueKind: "text",
					role: "search-input-label",
					source: input.label,
					owner: {
						kind: "search-input",
						moduleUuid,
						searchInputUuid: input.uuid,
					},
					breadcrumb: [doc.appName, module.name, "Search", input.label],
					context: { moduleName: module.name },
				}),
			);
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
					breadcrumb: [doc.appName, module.name, "Search", "title"],
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
						breadcrumb: [doc.appName, module.name, "Search", "subtitle"],
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
					breadcrumb: [doc.appName, module.name, "Search", "button"],
					context: { moduleName: module.name },
				}),
			);
		}
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
	language: LanguageCode,
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
	language: LanguageCode,
): readonly LocalizedTranslationUnit[] {
	return collectTranslationUnits(doc).map((entry) =>
		localizeTranslationUnit(doc, language, entry),
	);
}

export function resolveTranslationUnitValue(
	doc: BlueprintDoc,
	language: LanguageCode,
	id: TranslationUnitId,
): LocalizedValue {
	const unitValue = translationUnitsById(doc).get(id);
	if (unitValue === undefined) {
		throw new Error(`Unknown translation unit ${id}.`);
	}
	return localizeTranslationUnit(doc, language, unitValue).effective;
}
