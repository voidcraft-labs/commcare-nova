/**
 * Pure computation of the signal grid's edit focus zone.
 *
 * Given the current blueprint structure (module/form/field ordering) and
 * the agent's current edit scope (which module, form, or field the SA is
 * working on), this function returns a normalized `{ start, end }` range
 * (0–1) that the `SignalGridController` uses to highlight the active zone.
 *
 * Extracted from `BuilderEngine.computeEditFocus()` during Phase 3 engine
 * dissolution. The function is now pure — it takes data as parameters
 * instead of reading engine instance fields.
 */

import type { EditScope } from "@/lib/session/builderTypes";
import type { EditFocus } from "@/lib/signalGridController";

/**
 * Minimum normalized width for the focus zone. Prevents the highlight from
 * collapsing to a hairline when the scope targets a single field in a
 * large form.
 */
const MIN_EDIT_ZONE = 0.15;

/**
 * Data required to compute the edit focus zone. This matches the ordering
 * shape shared by both the legacy `BuilderState` and the normalized
 * `BlueprintDoc` — allowing callers to pass either source.
 */
export interface EditFocusData {
	moduleOrder: readonly string[];
	formOrder: Readonly<Record<string, readonly string[]>>;
	fieldOrder: Readonly<Record<string, readonly string[]>>;
}

/**
 * Compute the normalized focus zone for the signal grid's editing mode.
 *
 * Returns `null` when the scope is absent, the app has no modules, or the
 * targeted module/form has no fields. Otherwise returns a `{ start, end }`
 * range in [0, 1] that covers the scope's fields with a minimum width
 * of `MIN_EDIT_ZONE`.
 *
 * @param data  - The blueprint's ordering maps (module, form, field order).
 * @param scope - The agent's current edit scope, or `null` if not editing.
 */
export function computeEditFocus(
	data: EditFocusData,
	scope: EditScope | null,
): EditFocus | null {
	if (data.moduleOrder.length === 0 || !scope) return null;

	/* Count total fields across all forms and build a positional map so
	 * we can convert index-based scope coordinates into a 0-1 range. */
	let total = 0;
	const formPositions: Array<{
		moduleIndex: number;
		formIndex: number;
		start: number;
		count: number;
	}> = [];

	for (let mi = 0; mi < data.moduleOrder.length; mi++) {
		const moduleId = data.moduleOrder[mi];
		const formIds = data.formOrder[moduleId] ?? [];
		for (let fi = 0; fi < formIds.length; fi++) {
			const formId = formIds[fi];
			const count = countFieldsDeep(data.fieldOrder, formId);
			formPositions.push({
				moduleIndex: mi,
				formIndex: fi,
				start: total,
				count,
			});
			total += count;
		}
	}

	if (total === 0) return null;

	/* Module-level scope — span all of the module's forms. */
	if (scope.formIndex == null) {
		const modForms = formPositions.filter(
			(f) => f.moduleIndex === scope.moduleIndex,
		);
		if (modForms.length === 0) return null;
		const start = modForms[0].start / total;
		const end =
			(modForms[modForms.length - 1].start +
				modForms[modForms.length - 1].count) /
			total;
		return clampEditFocus(start, end);
	}

	/* Form-level or field-level scope. */
	const form = formPositions.find(
		(f) =>
			f.moduleIndex === scope.moduleIndex && f.formIndex === scope.formIndex,
	);
	if (!form || form.count === 0) return null;

	/* Field-level — center a zone around the specific field. */
	if (scope.fieldIndex != null) {
		const fieldPos =
			(form.start + Math.min(scope.fieldIndex, form.count - 1)) / total;
		const halfZone = Math.max(MIN_EDIT_ZONE / 2, (form.count / total) * 0.3);
		return clampEditFocus(fieldPos - halfZone, fieldPos + halfZone);
	}

	/* Form-level — span the form's full field range. */
	return clampEditFocus(form.start / total, (form.start + form.count) / total);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Clamp and pad the focus zone to respect the minimum width and [0, 1] bounds.
 */
function clampEditFocus(start: number, end: number): EditFocus {
	let width = end - start;
	if (width < MIN_EDIT_ZONE) {
		const center = (start + end) / 2;
		start = center - MIN_EDIT_ZONE / 2;
		end = center + MIN_EDIT_ZONE / 2;
		width = MIN_EDIT_ZONE;
	}
	if (start < 0) {
		end -= start;
		start = 0;
	}
	if (end > 1) {
		start -= end - 1;
		end = 1;
	}
	return { start: Math.max(0, start), end: Math.min(1, end) };
}

/**
 * Count all fields reachable from a parent in the fieldOrder tree.
 * Recursively counts children of groups and repeats.
 */
function countFieldsDeep(
	fieldOrder: Readonly<Record<string, readonly string[]>>,
	parentId: string,
): number {
	const childIds = fieldOrder[parentId];
	if (!childIds) return 0;
	let count = childIds.length;
	for (const uuid of childIds) {
		count += countFieldsDeep(fieldOrder, uuid);
	}
	return count;
}
