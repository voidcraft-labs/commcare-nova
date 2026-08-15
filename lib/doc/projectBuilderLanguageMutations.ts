/**
 * Redirect edits of existing worker-facing strings into the selected target
 * overlay while preserving structural edits in the canonical source document.
 */

import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	effectiveAppLocalization,
	type LanguageCode,
	type LocalizedValue,
	localizeTranslationUnit,
	makeTranslationUnitId,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
	translationValueIntegrityIssue,
} from "@/lib/domain";

export type BuilderLanguageMutationProjection =
	| { readonly ok: true; readonly mutations: Mutation[] }
	| { readonly ok: false; readonly message: string };

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(record: object, key: PropertyKey): boolean {
	return Object.hasOwn(record, key);
}

/**
 * This projector runs only inside the Builder provider. Agent, MCP, replay,
 * autosave folding, and direct domain callers continue to speak canonical
 * mutations with no ambient language behavior.
 */
export function projectBuilderLanguageMutations(
	doc: BlueprintDoc,
	language: LanguageCode | null,
	mutations: readonly Mutation[],
): BuilderLanguageMutationProjection {
	if (language === null) return { ok: true, mutations: [...mutations] };
	const localization = effectiveAppLocalization(doc.localization);
	if (language === localization.sourceLanguage) {
		return { ok: true, mutations: [...mutations] };
	}
	if (localization.languages[language] === undefined) {
		return {
			ok: false,
			message: `The selected worker language ${language} no longer belongs to this app. Choose another language and try again.`,
		};
	}

	const units = translationUnitsById(doc);
	const targetWrites = new Map<TranslationUnitId, TranslationEntry | null>();
	let refusal: string | undefined;
	const refuseMissingSource = (): void => {
		refusal ??= `Add this worker-facing content in ${localization.languages[localization.sourceLanguage].name} first, then translate it into ${localization.languages[language].name}.`;
	};

	/** Returns the canonical source when `id` is an existing localizable slot. */
	const redirect = (
		id: TranslationUnitId,
		presented: LocalizedValue,
	): LocalizedValue | undefined => {
		const unit = units.get(id);
		if (unit === undefined) return undefined;
		const issue = translationValueIntegrityIssue(unit, presented);
		if (issue !== undefined) {
			refusal =
				issue === "protected-content"
					? "This translation must preserve every referenced answer, case value, and worker value. Edit it in Languages to repair the protected references."
					: "That value is not valid for this worker-facing translation. Edit it in Languages and try again.";
			return unit.source;
		}
		const current = localizeTranslationUnit(doc, language, unit).effective;
		if (!sameValue(current, presented)) {
			targetWrites.set(id, {
				value: structuredClone(presented),
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: localization.sourceLanguage,
			});
		}
		return unit.source;
	};

	/** A reset on a localized configuration slot means use source fallback. */
	const redirectClear = (id: TranslationUnitId): boolean => {
		const unit = units.get(id);
		if (unit === undefined) return false;
		if (localization.translations[language]?.[id] !== undefined) {
			targetWrites.set(id, null);
		}
		return true;
	};

	const projected: Mutation[] = [];
	for (const mutation of mutations) {
		switch (mutation.kind) {
			case "setAppName": {
				const source = redirect(
					makeTranslationUnitId("app", "name"),
					mutation.name,
				);
				if (source === undefined) projected.push(mutation);
				break;
			}
			case "renameModule": {
				const source = redirect(
					makeTranslationUnitId("module", mutation.uuid, "name"),
					mutation.newId,
				);
				if (source === undefined) projected.push(mutation);
				break;
			}
			case "renameForm": {
				const source = redirect(
					makeTranslationUnitId("form", mutation.uuid, "name"),
					mutation.newId,
				);
				if (source === undefined) projected.push(mutation);
				break;
			}
			case "updateModule": {
				const next = structuredClone(mutation);
				const searchPatch = next.caseSearchConfigPatch as
					| Record<string, unknown>
					| undefined;
				if (searchPatch !== undefined) {
					for (const [slot, unitSlot] of [
						["searchScreenTitle", "search-title"],
						["searchScreenSubtitle", "search-subtitle"],
						["searchButtonLabel", "search-button"],
					] as const) {
						if (!hasOwn(searchPatch, slot)) continue;
						const id = makeTranslationUnitId("module", mutation.uuid, unitSlot);
						const value = searchPatch[slot];
						let handled = false;
						if (!units.has(id)) {
							handled = true;
							if (value !== null) refuseMissingSource();
						} else {
							handled =
								value === null
									? redirectClear(id)
									: typeof value === "string" &&
										redirect(id, value) !== undefined;
						}
						if (handled) delete searchPatch[slot];
					}
					if (Object.keys(searchPatch).length === 0) {
						delete next.caseSearchConfigPatch;
					}
				}
				if (
					Object.keys(next.patch).length > 0 ||
					next.ensureCaseListConfig !== undefined ||
					next.caseSearchConfigOperation !== undefined ||
					next.caseSearchConfigValue !== undefined ||
					next.caseSearchConfigPatch !== undefined
				) {
					projected.push(next);
				}
				break;
			}
			case "updateForm": {
				const next = structuredClone(mutation);
				if (
					Object.keys(next.patch).length > 0 ||
					next.caseOperationChange !== undefined ||
					next.caseOperationPatch !== undefined
				) {
					projected.push(next);
				}
				break;
			}
			case "updateField": {
				const next = structuredClone(mutation);
				const patch = next.patch as Record<string, unknown>;
				const currentField = doc.fields[mutation.uuid];
				for (const slot of ["label", "hint", "help", "validate_msg"] as const) {
					if (!hasOwn(patch, slot)) continue;
					const id = makeTranslationUnitId("field", mutation.uuid, slot);
					if (!units.has(id) && currentField !== undefined) {
						if (patch[slot] !== null) refuseMissingSource();
						delete patch[slot];
						continue;
					}
					const proposed = patch[slot] === null ? proseText("") : patch[slot];
					if (typeof proposed !== "object" || proposed === null) continue;
					const source = redirect(id, proposed as LocalizedValue);
					if (source !== undefined) delete patch[slot];
				}
				const proposedOptions = patch.optionsSource;
				if (
					typeof proposedOptions === "object" &&
					proposedOptions !== null &&
					"kind" in proposedOptions &&
					proposedOptions.kind === "inline" &&
					"options" in proposedOptions &&
					Array.isArray(proposedOptions.options) &&
					currentField !== undefined &&
					"optionsSource" in currentField &&
					currentField.optionsSource.kind === "inline"
				) {
					const sourceByUuid = new Map(
						currentField.optionsSource.options.map((option) => [
							option.uuid,
							option,
						]),
					);
					proposedOptions.options = proposedOptions.options.map((option) => {
						if (
							typeof option !== "object" ||
							option === null ||
							!("uuid" in option) ||
							!("label" in option)
						)
							return option;
						const prior = sourceByUuid.get(option.uuid);
						if (prior === undefined) return option;
						const source = redirect(
							makeTranslationUnitId(
								"field",
								mutation.uuid,
								"option",
								prior.uuid,
							),
							option.label as LocalizedValue,
						);
						return typeof source === "object" && source !== null
							? { ...option, label: source }
							: option;
					});
				}
				if (Object.keys(next.patch).length > 0) projected.push(next);
				break;
			}
			case "updateColumn": {
				if (mutation.column === undefined) {
					projected.push(mutation);
					break;
				}
				const next = structuredClone(mutation);
				const column = next.column;
				const current = doc.modules[
					mutation.moduleUuid
				]?.caseListConfig?.columns.find(
					(candidate) => candidate.uuid === mutation.uuid,
				);
				if (column === undefined || current === undefined) {
					projected.push(mutation);
					break;
				}
				const headerId = makeTranslationUnitId(
					"column",
					mutation.uuid,
					"header",
				);
				const headerSource = redirect(headerId, column.header);
				if (typeof headerSource === "string") column.header = headerSource;
				else if (!units.has(headerId) && column.header !== current.header) {
					refuseMissingSource();
				}
				if (column.kind === "id-mapping" && current.kind === "id-mapping") {
					if (
						column.mapping.some(
							(mapping) =>
								!current.mapping.some(
									(candidate) => candidate.value === mapping.value,
								),
						)
					) {
						refuseMissingSource();
					}
					column.mapping = column.mapping.map((mapping) => {
						const prior = current.mapping.find(
							(candidate) => candidate.value === mapping.value,
						);
						if (prior === undefined) return mapping;
						const source = redirect(
							makeTranslationUnitId(
								"column",
								mutation.uuid,
								"mapping",
								mapping.value,
							),
							mapping.label,
						);
						return typeof source === "string"
							? { ...mapping, label: source }
							: mapping;
					});
				}
				if (column.kind === "id-mapping" && current.kind !== "id-mapping") {
					if (column.mapping.length > 0) refuseMissingSource();
				}
				if (column.kind === "interval") {
					if (current.kind === "interval") {
						const source = redirect(
							makeTranslationUnitId("column", mutation.uuid, "text"),
							column.text,
						);
						if (typeof source === "string") column.text = source;
					} else {
						refuseMissingSource();
					}
				}
				projected.push(next);
				break;
			}
			case "updateSearchInput": {
				const next = structuredClone(mutation);
				const source = redirect(
					makeTranslationUnitId("search-input", mutation.uuid, "label"),
					next.searchInput.label,
				);
				const current = doc.modules[
					mutation.moduleUuid
				]?.caseListConfig?.searchInputs.find(
					(candidate) => candidate.uuid === mutation.uuid,
				);
				if (typeof source === "string" && current !== undefined) {
					next.searchInput.label = current.label;
				}
				projected.push(next);
				break;
			}
			case "updateOption": {
				const next = structuredClone(mutation);
				const source = redirect(
					makeTranslationUnitId(
						"field",
						mutation.fieldUuid,
						"option",
						mutation.uuid,
					),
					next.option.label,
				);
				if (typeof source === "object" && source !== null) {
					next.option.label = source;
				}
				projected.push(next);
				break;
			}
			case "setCaseProperty": {
				const current = doc.caseTypes
					?.find((candidate) => candidate.name === mutation.caseType)
					?.properties.find(
						(candidate) => candidate.name === mutation.property.name,
					);
				if (current === undefined || mutation.property.options === undefined) {
					projected.push(mutation);
					break;
				}
				const next = structuredClone(mutation);
				next.property.options = next.property.options?.map((option) => {
					const prior = current.options?.find(
						(candidate) => candidate.value === option.value,
					);
					if (prior === undefined) return option;
					// Kind conversions re-declare the complete case property from the
					// canonical catalog. That structural snapshot is not a target-language
					// edit, so it must not replace an existing translation with the source
					// label merely because the Builder is currently showing a target lens.
					if (sameValue(prior.label, option.label)) return option;
					const source = redirect(
						makeTranslationUnitId(
							"case-property-option",
							mutation.caseType,
							mutation.property.name,
							option.value,
						),
						option.label,
					);
					return typeof source === "object" && source !== null
						? { ...option, label: source }
						: option;
				});
				if (!sameValue(current, next.property)) projected.push(next);
				break;
			}
			default:
				projected.push(mutation);
		}
	}

	if (refusal !== undefined) return { ok: false, message: refusal };
	for (const [unitId, entry] of targetWrites) {
		projected.push({
			kind: "setTranslation",
			language,
			unitId,
			entry,
		});
	}
	return { ok: true, mutations: projected };
}
