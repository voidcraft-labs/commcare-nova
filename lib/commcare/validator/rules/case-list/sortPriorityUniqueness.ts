/**
 * Rule: every sorted column on `caseListConfig.columns` carries a
 * `sort.priority` that is unique across the column set.
 *
 * Sort directives live per-column, keyed by an integer priority.
 * The wire emitter orders the emission by priority ascending and
 * tie-breaks to source-array index when two columns share a
 * priority — so collisions never produce malformed XML. But the
 * authored intent ("two primary sorts" / "two secondary sorts") is
 * structurally undefined: the editor maintains uniqueness on
 * save, but SA tool calls / MCP API / recovery scripts bypass the
 * editor and can persist colliding priorities. The runtime would
 * silently order by source-array index, picking up whichever
 * column happens to land first in `columns`.
 *
 * Short-circuits cleanly when fewer than two columns carry a
 * `sort` slot — collisions are trivially absent.
 */

import type { BlueprintDoc, Column, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function sortPriorityUniqueness(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];
	if (columns.length === 0) return [];

	// Walk the column list once, tracking the first column index at
	// every priority. Second occurrences emit one error each — the
	// reported pair is the new (duplicate) row against the first one,
	// so the editor highlights the row the author would amend.
	const firstByPriority = new Map<number, number>();
	const errors: ValidationError[] = [];

	for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
		const column = columns[columnIndex];
		if (!column.sort) continue;
		const priority = column.sort.priority;
		const firstIndex = firstByPriority.get(priority);
		if (firstIndex === undefined) {
			firstByPriority.set(priority, columnIndex);
			continue;
		}
		const firstLabel = describeColumn(columns[firstIndex], firstIndex);
		const duplicateLabel = describeColumn(column, columnIndex);
		errors.push(
			validationError(
				"CASE_LIST_DUPLICATE_SORT_PRIORITY",
				"module",
				`Module "${mod.name}" has two sorted columns sharing sort priority ${priority}: ${firstLabel} and ${duplicateLabel}. Change one of the priorities, or remove the sort from the column that shouldn't be ordered.`,
				{ moduleUuid, moduleName: mod.name },
				{
					priority: String(priority),
					firstIndex: String(firstIndex),
					duplicateIndex: String(columnIndex),
					firstUuid: columns[firstIndex].uuid,
					duplicateUuid: column.uuid,
				},
			),
		);
	}

	return errors;
}

/**
 * Compose a short author-facing handle for a column referenced from
 * an error message. Calculated columns have no `field`, so the
 * `header` is the most informative slot when present; non-calculated
 * columns fall back to `field` when `header` is empty.
 */
function describeColumn(column: Column, index: number): string {
	const header = column.header.trim();
	if (header.length > 0) return `"${header}" (column #${index + 1})`;
	if (column.kind !== "calculated" && column.field.trim().length > 0) {
		return `"${column.field}" (column #${index + 1})`;
	}
	return `column #${index + 1}`;
}
