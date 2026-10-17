/**
 * Step `option-values`: gives each later choice that shares a stored value
 * with an earlier choice of its list a value of its own. HQ's form builder
 * refuses a select whose choices share a value, and a worker's answer could
 * never say which one was picked (`SELECT_OPTION_VALUE_DUPLICATE`,
 * `CASE_PROPERTY_OPTION_VALUE_DUPLICATE`; part 08 of step 2's plan, Finding
 * 44).
 *
 * Only a select that stores its own choices (`optionsSource.kind` `inline`)
 * and a case property's choice catalog hold a list; a lookup-backed or
 * case-backed select holds none and is left as it is. A value space is the
 * catalog of one case property together with the lists of every field that
 * writes it, and a select that writes no property is a space of its own,
 * keyed by `optionValueSpaceKey` as
 * `scripts/lib/selectOptionValueRepair.ts::selectOptionValueSpaces` keys them
 * (the equality test holds the two groupings equal), so a field and its
 * catalog stay in agreement. In each list the first
 * choice holding a value keeps it. New values are allocated once per space:
 * the k-th later holder of `v` takes the k-th value allocated for `v`, each
 * `suffixUntilFree(v, taken)` over the space's values and those allocated
 * before it (`yes_2`, `yes_3`), so a list with fewer holders uses fewer. A
 * value the grammar refuses is that rule's, not this step's.
 *
 * A catalog choice's translation entry is keyed by its value and its
 * occurrence, so each moves to the renamed choice's key and no wording is
 * lost; a field choice's entry is keyed by its uuid and needs no move.
 * Nothing else follows: the shared value cannot say which choice an answer,
 * a case row or an expression meant, so it keeps reading as the first one.
 *
 * One `option-value-split` line per renamed choice: for a field, naming its
 * form, with the question, the shared value, the new value and both labels;
 * for a catalog, naming the app, with the case type and the property.
 */

import { asUuid } from "@/lib/domain";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import {
	optionValueSpaceKey,
	selectOptionValueProblem,
} from "@/lib/domain/selectOptionValue";
import {
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
} from "@/lib/domain/translationUnits";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { fieldUuidsUnder, isRecord, rawText } from "./relativePaths";

/** A stored choice's label as plain text: its text runs, joined. */
function labelText(label: Json | undefined): string {
	if (!isRecord(label) || !Array.isArray(label.parts)) return "";
	return label.parts
		.map((part) =>
			isRecord(part) && part.kind === "text" ? rawText(part.text) : "",
		)
		.join("");
}

export type ListOwner =
	| {
			readonly kind: "field";
			readonly fieldUuid: string;
			readonly formUuid: string;
			readonly formName: string;
			readonly question: string;
	  }
	| {
			readonly kind: "catalog";
			readonly caseType: string;
			readonly property: string;
	  };

export interface OptionList {
	readonly owner: ListOwner;
	readonly options: JsonRecord[];
}

/** One later holder's new value, and the choice whose value it shared. */
export interface OptionValueSplit {
	readonly owner: ListOwner;
	readonly index: number;
	readonly value: string;
	readonly to: string;
	readonly keptLabel: string;
	readonly label: string;
}

/** Every option list, grouped into value spaces by `optionValueSpaceKey`,
 * in document order. */
export function optionValueSpaces(
	document: RawDocument,
): Map<string, OptionList[]> {
	const spaces = new Map<string, OptionList[]>();
	const add = (key: string, list: OptionList) => {
		const space = spaces.get(key) ?? [];
		space.push(list);
		spaces.set(key, space);
	};
	if (Array.isArray(document.caseTypes)) {
		for (const caseType of document.caseTypes) {
			if (!isRecord(caseType) || !Array.isArray(caseType.properties)) continue;
			for (const property of caseType.properties) {
				if (!isRecord(property) || !Array.isArray(property.options)) continue;
				const name = rawText(caseType.name);
				add(
					optionValueSpaceKey({
						caseType: name,
						property: rawText(property.name),
					}),
					{
						owner: {
							kind: "catalog",
							caseType: name,
							property: rawText(property.name),
						},
						options: property.options.filter(isRecord),
					},
				);
			}
		}
	}
	for (const moduleUuid of document.moduleOrder) {
		for (const formUuid of document.formOrder[moduleUuid] ?? []) {
			const form = document.forms[formUuid];
			if (form === undefined) continue;
			for (const fieldUuid of fieldUuidsUnder(document, formUuid)) {
				const field = document.fields[fieldUuid];
				const source = field?.optionsSource;
				if (
					field === undefined ||
					!isRecord(source) ||
					source.kind !== "inline" ||
					!Array.isArray(source.options)
				) {
					continue;
				}
				const write = field.caseWrite;
				const bound =
					isRecord(write) &&
					rawText(write.caseType) !== "" &&
					rawText(write.property) !== "";
				add(
					optionValueSpaceKey(
						bound
							? {
									caseType: rawText(write.caseType),
									property: rawText(write.property),
								}
							: { fieldUuid },
					),
					{
						owner: {
							kind: "field",
							fieldUuid,
							formUuid,
							formName: rawText(form.name),
							question: rawText(field.id),
						},
						options: source.options.filter(isRecord),
					},
				);
			}
		}
	}
	return spaces;
}

/**
 * Plan and write the split over the raw rows: each later holder's new
 * value, catalog translation entries moved to their new keys.
 */
export function planDuplicateOptionValueSplit(
	document: RawDocument,
): OptionValueSplit[] {
	const splits: OptionValueSplit[] = [];
	const unitMoves = new Map<string, string>();
	for (const space of optionValueSpaces(document).values()) {
		const taken = new Set(
			space.flatMap((list) =>
				list.options.map((option) => rawText(option.value)),
			),
		);
		const allocated = new Map<string, string[]>();
		for (const list of space) {
			const before = list.options.map((option) => ({
				value: rawText(option.value),
			}));
			const firstHolder = new Map<string, number>();
			const laterHolders = new Map<string, number>();
			list.options.forEach((option, index) => {
				const value = rawText(option.value);
				if (selectOptionValueProblem(value) !== undefined) return;
				if (!firstHolder.has(value)) {
					firstHolder.set(value, index);
					return;
				}
				const k = (laterHolders.get(value) ?? 0) + 1;
				laterHolders.set(value, k);
				const values = allocated.get(value) ?? [];
				if (values.length < k) {
					const next = suffixUntilFree(value, taken);
					taken.add(next);
					values.push(next);
					allocated.set(value, values);
				}
				const to = values[k - 1] as string;
				(option as { value: string }).value = to;
				splits.push({
					owner: list.owner,
					index,
					value,
					to,
					keptLabel: labelText(
						list.options[firstHolder.get(value) ?? 0]?.label,
					),
					label: labelText(option.label),
				});
			});
			if (list.owner.kind !== "catalog") continue;
			const after = list.options.map((option) => ({
				value: rawText(option.value),
			}));
			after.forEach((option, index) => {
				const from = before[index]?.value;
				if (from === undefined || from === option.value) return;
				const { caseType, property } = list.owner as Extract<
					ListOwner,
					{ kind: "catalog" }
				>;
				unitMoves.set(
					casePropertyOptionTranslationUnitId(
						caseType,
						property,
						from,
						casePropertyOptionOccurrence(before, index),
					),
					casePropertyOptionTranslationUnitId(
						caseType,
						property,
						option.value,
						casePropertyOptionOccurrence(after, index),
					),
				);
			});
		}
	}
	moveTranslationEntries(document, unitMoves);
	return splits;
}

/** Move each translation entry from its old unit key to its new one, in every language. */
function moveTranslationEntries(
	document: RawDocument,
	moves: ReadonlyMap<string, string>,
): void {
	if (moves.size === 0 || !isRecord(document.localization)) return;
	const translations = document.localization.translations;
	if (!isRecord(translations)) return;
	for (const entries of Object.values(translations)) {
		if (!isRecord(entries)) continue;
		const writable = entries as Record<string, Json>;
		const moved: Record<string, Json> = {};
		for (const [unitId, entry] of Object.entries(writable)) {
			moved[moves.get(unitId) ?? unitId] = entry;
		}
		for (const unitId of Object.keys(writable)) delete writable[unitId];
		Object.assign(writable, moved);
	}
}

export const optionValuesStep: CutoverStep = {
	id: "option-values",
	apply(document) {
		return planDuplicateOptionValueSplit(document).map(
			(split): DocumentChange => {
				const shared = {
					value: split.value,
					to: split.to,
					keptLabel: split.keptLabel,
					label: split.label,
				};
				return split.owner.kind === "field"
					? {
							reason: "option-value-split",
							entity: {
								type: "form",
								uuid: asUuid(split.owner.formUuid),
								nameAtMigration: split.owner.formName,
							},
							detail: { question: split.owner.question, ...shared },
						}
					: {
							reason: "option-value-split",
							entity: { type: "app", nameAtMigration: document.appName },
							detail: {
								caseType: split.owner.caseType,
								property: split.owner.property,
								...shared,
							},
						};
			},
		);
	},
};
