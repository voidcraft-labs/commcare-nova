/**
 * Field-icon-map hook + field-count helper used by the AppTree rows.
 *
 * `useFieldIconMap` walks a form's field subtree once and memoizes a
 * `FieldPath → IconifyIcon` map keyed by path. FormCard passes the
 * map down the tree via `FormIconContext` so FieldRow can render
 * reference chips (e.g. `#form/question_id`) with the correct
 * field-kind icon without prop-drilling.
 *
 * `countQuestionsFromOrder` is kept alongside because it walks the same
 * subtree and is called from FormCard's selector. Keeping it a pure
 * function (primitive result) lets Zustand's equality check skip
 * re-renders when unrelated forms' field lists change.
 */
"use client";
import type { IconifyIcon } from "@iconify/react/offline";
import { useMemo } from "react";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import { fieldRegistry } from "@/lib/domain";
import { type FieldPath, fpath } from "@/lib/services/fieldPath";

/**
 * Build a `FieldPath → field-kind icon` map for a form's fields.
 *
 * Recurses through the form's `fieldOrder` subtree and records the
 * per-kind icon from `fieldRegistry`. The registry lookup is total
 * (every kind has an icon) so no defensive branch is needed.
 *
 * The map is memoized on `{formId, fields, fieldOrder}` — entity-map
 * reference equality means the walk runs once per actual change.
 */
export function useFieldIconMap(formId: Uuid): Map<string, IconifyIcon> {
	const { fields, fieldOrder } = useBlueprintDocShallow((s) => ({
		fields: s.fields,
		fieldOrder: s.fieldOrder,
	}));

	return useMemo(() => {
		const map = new Map<string, IconifyIcon>();
		function walk(parentId: Uuid, parentPath?: FieldPath) {
			const uuids = fieldOrder[parentId] ?? [];
			for (const uuid of uuids) {
				const f = fields[uuid];
				if (!f) continue;
				const p = fpath(f.id, parentPath);
				// Icon comes from `fieldRegistry[kind]` — the domain-owned
				// metadata registry. Every kind has an icon, so no defensive
				// branch is needed; the lookup is total.
				map.set(p, fieldRegistry[f.kind].icon);
				walk(uuid, p);
			}
		}
		walk(formId);
		return map;
	}, [formId, fields, fieldOrder]);
}

/**
 * Count questions recursively under a form or group. Pure, primitive
 * result — safe to call inside a Zustand selector so the FormCard
 * re-renders only when its own count actually changes.
 */
export function countQuestionsFromOrder(
	parentId: Uuid,
	fieldOrder: Record<Uuid, Uuid[]>,
): number {
	let count = 0;
	function walk(pid: Uuid) {
		const uuids = fieldOrder[pid] ?? [];
		count += uuids.length;
		for (const uuid of uuids) {
			walk(uuid);
		}
	}
	walk(parentId);
	return count;
}
