/**
 * Preview's case-selection value is an ordered set of case ids.
 *
 * Array order is the worker's selection order and therefore the batch
 * execution order. Every helper preserves existing order, appends new choices,
 * and removes duplicates without sorting by a mutable label or database row
 * order.
 */

import type { PreviewCaseChoice } from "@/lib/session/types";

export type { PreviewCaseChoice } from "@/lib/session/types";

export function togglePreviewCaseChoice(
	current: readonly PreviewCaseChoice[],
	choice: PreviewCaseChoice,
): readonly PreviewCaseChoice[] {
	const existing = current.findIndex((entry) => entry.caseId === choice.caseId);
	if (existing >= 0) {
		return current.filter((_, index) => index !== existing);
	}
	return [...current, choice];
}

export function addVisiblePreviewCaseChoices(
	current: readonly PreviewCaseChoice[],
	visible: readonly PreviewCaseChoice[],
	maximum: number,
): {
	readonly choices: readonly PreviewCaseChoice[];
	readonly skipped: number;
} {
	const seen = new Set(current.map((choice) => choice.caseId));
	const choices = [...current];
	let skipped = 0;
	for (const choice of visible) {
		if (seen.has(choice.caseId)) continue;
		if (choices.length >= maximum) {
			skipped += 1;
			continue;
		}
		seen.add(choice.caseId);
		choices.push(choice);
	}
	return { choices, skipped };
}

/** Keep only authoritative rows while restoring the worker's selection order. */
export function reconcilePreviewCaseChoices<
	Row extends { readonly case_id: string },
>(
	current: readonly PreviewCaseChoice[],
	rows: readonly Row[],
): {
	readonly choices: readonly PreviewCaseChoice[];
	readonly rows: readonly Row[];
	readonly removed: number;
} {
	const rowById = new Map(rows.map((row) => [row.case_id, row] as const));
	const choices: PreviewCaseChoice[] = [];
	const orderedRows: Row[] = [];
	for (const choice of current) {
		const row = rowById.get(choice.caseId);
		if (row === undefined) continue;
		choices.push(choice);
		orderedRows.push(row);
	}
	return {
		choices,
		rows: orderedRows,
		removed: current.length - choices.length,
	};
}

export function previewCaseSelectionMessage(
	count: number,
	maximum: number,
): string | undefined {
	if (count === 0) return "Choose at least one case to continue";
	if (count > maximum) {
		const extra = count - maximum;
		return `Choose ${extra} fewer ${extra === 1 ? "case" : "cases"} to continue`;
	}
	return undefined;
}
