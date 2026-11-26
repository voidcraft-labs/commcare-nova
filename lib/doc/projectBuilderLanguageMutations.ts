/**
 * Redirect edits of existing worker-facing strings into the selected target
 * overlay while preserving structural edits in the canonical source document.
 */

import { mappingRowUnitMoves } from "@/lib/doc/caseListColumnMutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	authoredTranslationValueMode,
	caseListWordingUnitId,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	effectiveAppLocalization,
	FIELD_PROSE_SLOTS,
	isOrdinaryCaseSearchConfig,
	type LanguageTag,
	type LocalizedValue,
	localizeTranslationUnit,
	makeTranslationUnitId,
	proseText,
	searchScreenTitleSchema,
	type TranslationEntry,
	type TranslationUnitId,
	translationEntryIntegrityIssue,
	translationUnitsById,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import { languageDisplayLabel } from "@/lib/domain/languageRegistry";

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
	language: LanguageTag | null,
	mutations: readonly Mutation[],
): BuilderLanguageMutationProjection {
	if (language === null) return { ok: true, mutations: [...mutations] };
	const localization = effectiveAppLocalization(doc.localization);
	if (language === localization.sourceLanguage) {
		return { ok: true, mutations: [...mutations] };
	}
	if (!localization.languageOrder.includes(language)) {
		return {
			ok: false,
			message:
				"The selected worker language no longer belongs to this app. Choose another language and try again.",
		};
	}
	const units = translationUnitsById(doc);
	const targetWrites = new Map<TranslationUnitId, TranslationEntry | null>();
	let refusal: string | undefined;
	const refuseMissingSource = (): void => {
		const source = languageDisplayLabel(localization.sourceLanguage);
		const target = languageDisplayLabel(language);
		refusal ??=
			source !== undefined && target !== undefined
				? `Add this worker-facing content in ${source} first, then translate it into ${target}.`
				: "Add this worker-facing content under the source language first, then translate it here.";
	};

	/** Returns the canonical source when `id` is an existing localizable slot. */
	const redirect = (
		id: TranslationUnitId,
		presented: LocalizedValue,
	): LocalizedValue | undefined => {
		const unit = units.get(id);
		if (unit === undefined) return undefined;
		const mode = authoredTranslationValueMode(unit, presented);
		const issue = translationEntryIntegrityIssue(unit, {
			value: presented,
			...mode,
		});
		if (issue !== undefined) {
			refusal =
				issue === "protected-content"
					? "This translation keeps every answer, case value, worker value and calculated value its source shows. You can repair them in Languages."
					: "That value is not valid for this worker-facing translation. Edit it in Languages and try again.";
			return unit.source;
		}
		// Compare with the preceding edit in this batch. Reading only the
		// original overlay loses a later edit that restores the original value.
		const current = targetWrites.has(id)
			? (targetWrites.get(id)?.value ?? unit.source)
			: localizeTranslationUnit(doc, language, unit).effective;
		if (!sameValue(current, presented)) {
			targetWrites.set(id, {
				value: structuredClone(presented),
				...mode,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: localization.sourceLanguage,
			});
		}
		return unit.source;
	};

	/** `redirect` for a row whose unit this batch moves (`mappingRowUnitMoves`):
	 * the words are compared with the row's old unit, and a changed value is
	 * written under the unit it moves to, where the batch's carry puts the
	 * row's existing translation. */
	const redirectMoved = (
		from: TranslationUnitId,
		to: TranslationUnitId,
		presented: LocalizedValue,
	): LocalizedValue | undefined => {
		const pending = targetWrites.has(from);
		const source = redirect(from, presented);
		if (!pending && targetWrites.has(from)) {
			targetWrites.set(to, targetWrites.get(from) ?? null);
			targetWrites.delete(from);
		}
		return source;
	};

	/** A reset on a localized configuration slot means use source fallback. */
	const redirectClear = (id: TranslationUnitId): boolean => {
		const unit = units.get(id);
		if (unit === undefined) return false;
		if (
			targetWrites.has(id) ||
			localization.translations[language]?.[id] !== undefined
		) {
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
					] as const) {
						if (!hasOwn(searchPatch, slot)) continue;
						const id = makeTranslationUnitId("module", mutation.uuid, unitSlot);
						const value = searchPatch[slot];
						// Showing a title is the source's setting, in every language:
						// the source takes turning it off, and this language drops a
						// title of its own, so it shows none. Turning it back on clears
						// the source's `none`, so every language shows its title again;
						// clearing a title of this language's own over a source that
						// shows one is a translation's clear. A brought-in language with
						// a title of its own over the source's `none` keeps it
						// (`searchTitleLanguages.ts`).
						if (slot === "searchScreenTitle" && isNoSearchScreenTitle(value)) {
							if (units.has(id)) redirectClear(id);
							continue;
						}
						const stored = doc.modules[mutation.uuid]?.caseSearchConfig;
						if (
							slot === "searchScreenTitle" &&
							value === null &&
							isOrdinaryCaseSearchConfig(stored) &&
							isNoSearchScreenTitle(stored.searchScreenTitle)
						) {
							if (units.has(id)) redirectClear(id);
							continue;
						}
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
				for (const slot of FIELD_PROSE_SLOTS) {
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
			case "setCaseListMeta": {
				// A case list's own wording edited in a target language is that
				// language's translation; the source keeps its text.
				const next = structuredClone(mutation);
				const patch = next.patch;
				for (const [key, slot] of [
					["emptyText", "empty"],
					["selectButtonText", "select"],
				] as const) {
					if (!hasOwn(patch, key)) continue;
					const id = caseListWordingUnitId(mutation.uuid, slot);
					const value = patch[key];
					if (!units.has(id)) {
						if (value != null) refuseMissingSource();
					} else if (value === null) redirectClear(id);
					else if (typeof value === "string") redirect(id, value);
					delete patch[key];
				}
				if (Object.keys(patch).length > 0) projected.push(next);
				break;
			}
			case "updateCalculatedSort": {
				if (!hasOwn(mutation.patch, "label")) {
					projected.push(mutation);
					break;
				}
				const next = structuredClone(mutation);
				const id = makeTranslationUnitId("case-sort", mutation.uuid, "label");
				if (!units.has(id)) {
					if (next.patch.label != null) refuseMissingSource();
				} else if (next.patch.label === null) redirectClear(id);
				else if (typeof next.patch.label === "string")
					redirect(id, next.patch.label);
				delete next.patch.label;
				if (next.after !== undefined || Object.keys(next.patch).length > 0)
					projected.push(next);
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
					// A row the edit moves to another unit (a row saved before rows
					// carried identities, given one or a new value) is the row it was:
					// its words are read against its old unit, and a changed label is
					// this language's translation under the unit it moves to.
					const moves = mappingRowUnitMoves(
						mutation.uuid,
						current.mapping,
						column.mapping,
						"mapping",
					);
					column.mapping = column.mapping.map((mapping, index) => {
						const unitId = caseMappingTextUnit(
							mutation.uuid,
							mapping,
							"mapping",
						);
						const prior = current.mapping.find(
							(candidate) =>
								caseMappingTextUnit(mutation.uuid, candidate, "mapping") ===
								unitId,
						);
						const move = moves.get(index);
						let source: LocalizedValue | undefined;
						if (prior !== undefined) source = redirect(unitId, mapping.label);
						else if (move !== undefined)
							source = redirectMoved(move.from, move.to, mapping.label);
						else refuseMissingSource();
						return typeof source === "string"
							? { ...mapping, label: source }
							: mapping;
					});
				}
				if (column.kind === "id-mapping" && current.kind !== "id-mapping") {
					if (column.mapping.length > 0) refuseMissingSource();
				}
				if (column.kind === "calculated" && column.texts) {
					const prior =
						current.kind === "calculated" ? current.texts : undefined;
					column.texts = column.texts.map((piece) => {
						if (!prior?.some((item) => item.uuid === piece.uuid))
							refuseMissingSource();
						const original = redirect(
							makeTranslationUnitId(
								"column",
								mutation.uuid,
								"calculation-text",
								piece.uuid,
							),
							piece.label,
						);
						if (typeof original !== "string") refuseMissingSource();
						return {
							...piece,
							label: typeof original === "string" ? original : piece.label,
						};
					});
				}
				if (column.kind === "image-map") {
					const moves =
						current.kind === "image-map"
							? mappingRowUnitMoves(
									mutation.uuid,
									current.mapping,
									column.mapping,
									"image-description",
								)
							: undefined;
					column.mapping = column.mapping.map((row, index) => {
						const move = moves?.get(index);
						const id =
							move?.from ??
							caseMappingTextUnit(mutation.uuid, row, "image-description");
						if (row.altText === undefined) {
							if (units.has(id)) {
								if (move === undefined) redirectClear(id);
								else if (
									localization.translations[language]?.[id] !== undefined
								)
									targetWrites.set(move.to, null);
								const original = units.get(id)?.source;
								if (typeof original === "string")
									return { ...row, altText: original };
							}
							return row;
						}
						const original =
							move === undefined
								? redirect(id, row.altText)
								: redirectMoved(move.from, move.to, row.altText);
						if (typeof original !== "string") refuseMissingSource();
						return {
							...row,
							altText: typeof original === "string" ? original : row.altText,
						};
					});
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
				const current = doc.modules[
					mutation.moduleUuid
				]?.caseListConfig?.searchInputs.find(
					(candidate) => candidate.uuid === mutation.uuid,
				);
				const source = redirect(
					makeTranslationUnitId("search-input", mutation.uuid, "label"),
					next.searchInput.label,
				);
				if (typeof source === "string" && current !== undefined) {
					next.searchInput.label = current.label;
				}
				// The three worker-facing sentences a visible prompt carries
				// follow the field rule: a changed sentence under a worker
				// language is that language's translation and the source stays;
				// a removed sentence clears the translation; a sentence the
				// source does not yet hold cannot be added here.
				if (
					next.searchInput.kind !== "hidden" &&
					current !== undefined &&
					current.kind !== "hidden"
				) {
					const proposed = next.searchInput;
					const sentences = [
						{
							slot: "hint",
							presented: proposed.hint,
							source: current.hint,
							restore: () => {
								proposed.hint = current.hint;
							},
						},
						{
							slot: "required-message",
							presented: proposed.required?.message,
							source: current.required?.message,
							restore: () => {
								if (proposed.required !== undefined) {
									proposed.required = {
										...proposed.required,
										message: current.required?.message,
									};
								}
							},
						},
						{
							slot: "validation-message",
							presented: proposed.validation?.message,
							source: current.validation?.message,
							restore: () => {
								if (
									proposed.validation !== undefined &&
									current.validation !== undefined
								) {
									proposed.validation = {
										...proposed.validation,
										message: current.validation.message,
									};
								}
							},
						},
					] as const;
					for (const sentence of sentences) {
						if (sentence.presented === sentence.source) continue;
						const id = makeTranslationUnitId(
							"search-input",
							mutation.uuid,
							sentence.slot,
						);
						if (sentence.source === undefined) {
							refuseMissingSource();
							sentence.restore();
							continue;
						}
						if (sentence.presented === undefined) {
							if (redirectClear(id)) sentence.restore();
							continue;
						}
						if (redirect(id, sentence.presented) !== undefined) {
							sentence.restore();
						}
					}
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
				const nextOptions = next.property.options ?? [];
				next.property.options = nextOptions.map((option, index) => {
					const occurrence = casePropertyOptionOccurrence(nextOptions, index);
					const prior = current.options?.filter(
						(candidate) => candidate.value === option.value,
					)[occurrence];
					if (prior === undefined) return option;
					// Kind conversions re-declare the complete case property from the
					// canonical catalog. That structural snapshot is not a target-language
					// edit, so it must not replace an existing translation with the source
					// label merely because the Builder is currently showing a target lens.
					if (sameValue(prior.label, option.label)) return option;
					const source = redirect(
						casePropertyOptionTranslationUnitId(
							mutation.caseType,
							mutation.property.name,
							option.value,
							occurrence,
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

/** Whether a stored or patched search title is the `none` arm. */
function isNoSearchScreenTitle(value: unknown): boolean {
	const parsed = searchScreenTitleSchema.safeParse(value);
	return parsed.success && typeof parsed.data !== "string";
}
