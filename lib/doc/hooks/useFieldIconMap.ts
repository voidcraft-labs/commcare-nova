/**
 * Field-icon-map hook + field-count helpers used by the AppTree rows.
 *
 * `useFieldIconMap` walks a form's field subtree once and memoizes a
 * `FieldPath → IconifyIcon` map keyed by path. FormCard passes the
 * map down the tree via `FormIconContext` so FieldRow can render
 * reference chips (e.g. `#form/question_id`) with the correct
 * field-kind icon without prop-drilling.
 *
 * `useFormDescendantCount` + the underlying pure `countQuestionsFromOrder`
 * helper live here because they walk the same subtree shape. Keeping the
 * pure walker as a primitive-returning function lets Zustand's equality
 * check skip re-renders when unrelated forms' field lists change.
 *
 * Lives in `lib/doc/hooks/` because — despite the "iconmap" name — these
 * are narrow doc-store subscription hooks, not AppTree-presentation
 * utilities. Colocating them with the other `lib/doc/hooks/*` entries
 * keeps the boundary rule (components import hooks, never the raw
 * store) trivially enforceable.
 */

"use client";

import type { IconifyIcon } from "@iconify/react/offline";
import { useMemo } from "react";
import {
	useBlueprintDoc,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
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
 * result — safe to call inside a Zustand selector so the caller re-renders
 * only when its own count actually changes.
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

/**
 * Recursive descendant count for a form or container. Subscribes to the
 * whole `fieldOrder` map (Immer-stable reference) and walks the subtree
 * via `countQuestionsFromOrder`. Returns a number primitive, so the
 * default `Object.is` comparison inside `useBlueprintDoc` re-renders
 * the caller only when the count actually changes.
 *
 * Accepts `Uuid | undefined` so call sites that derive the parent uuid
 * from an optional URL selection don't need to guard the hook call.
 * Returns 0 when `parentUuid` is missing.
 */
export function useFormDescendantCount(parentUuid: Uuid | undefined): number {
	return useBlueprintDoc((s) =>
		parentUuid ? countQuestionsFromOrder(parentUuid, s.fieldOrder) : 0,
	);
}
