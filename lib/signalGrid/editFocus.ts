/**
 * Pure computation of the signal grid's edit focus zone.
 *
 * Given the current blueprint structure (module/form/field ordering) and
 * the agent's current edit scope (which module, form, or field the SA is
 * working on), this function returns a normalized `{ start, end }` range
 * (0–1) that the `SignalGridController` uses to highlight the active zone.
 *
 * Pure in both senses: takes all inputs as parameters, no hidden state.
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
 * Data required to compute the edit focus zone. Mirrors the ordering
 * slices of `BlueprintDoc` (moduleOrder / formOrder / fieldOrder) so
 * callers can pass a narrowed view without cloning the whole doc.
 *
 * `moduleOrder` and each `formOrder` list must be in display order. Scope
 * identity is UUID-backed; these arrays determine only where that stable
 * identity currently renders. `fieldOrder` is the nested display sequence.
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

	/* Count total fields across all forms and build the current display map for
	 * the UUID-backed scope. */
	let total = 0;
	const formPositions: Array<{
		moduleUuid: string;
		formUuid: string;
		start: number;
		fieldUuids: readonly string[];
	}> = [];

	for (let mi = 0; mi < data.moduleOrder.length; mi++) {
		const moduleUuid = data.moduleOrder[mi];
		const formIds = data.formOrder[moduleUuid] ?? [];
		for (let fi = 0; fi < formIds.length; fi++) {
			const formUuid = formIds[fi];
			const fieldUuids = fieldsDeep(data.fieldOrder, formUuid);
			formPositions.push({
				moduleUuid,
				formUuid,
				start: total,
				fieldUuids,
			});
			total += fieldUuids.length;
		}
	}

	if (total === 0) return null;

	/* Module-level scope — span all of the module's forms. */
	if (scope.formUuid == null) {
		const modForms = formPositions.filter(
			(f) => f.moduleUuid === scope.moduleUuid,
		);
		if (modForms.length === 0) return null;
		const start = modForms[0].start / total;
		const end =
			(modForms[modForms.length - 1].start +
				modForms[modForms.length - 1].fieldUuids.length) /
			total;
		return clampEditFocus(start, end);
	}

	/* Form-level or field-level scope. */
	const form = formPositions.find(
		(f) => f.moduleUuid === scope.moduleUuid && f.formUuid === scope.formUuid,
	);
	if (!form || form.fieldUuids.length === 0) return null;

	/* Field-level — center a zone around the specific field. */
	if (scope.fieldUuid != null) {
		const fieldIndex = form.fieldUuids.indexOf(scope.fieldUuid);
		if (fieldIndex < 0) return null;
		const fieldPos = (form.start + fieldIndex) / total;
		const halfZone = Math.max(
			MIN_EDIT_ZONE / 2,
			(form.fieldUuids.length / total) * 0.3,
		);
		return clampEditFocus(fieldPos - halfZone, fieldPos + halfZone);
	}

	/* Form-level — span the form's full field range. */
	return clampEditFocus(
		form.start / total,
		(form.start + form.fieldUuids.length) / total,
	);
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
 * Flatten all fields reachable from a parent in the fieldOrder tree, preserving
 * the current depth-first display order.
 */
function fieldsDeep(
	fieldOrder: Readonly<Record<string, readonly string[]>>,
	parentId: string,
): readonly string[] {
	const childIds = fieldOrder[parentId];
	if (!childIds) return [];
	const result: string[] = [];
	for (const uuid of childIds) {
		result.push(uuid, ...fieldsDeep(fieldOrder, uuid));
	}
	return result;
}
