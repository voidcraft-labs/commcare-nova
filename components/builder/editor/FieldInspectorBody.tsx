/**
 * FieldInspectorBody — the right-rail inspector body for a selected form
 * field. Rendered by the rail from shared selection state (`useActiveInspector`
 * builds the descriptor, `InspectorPanel` owns the kicker/title/close header),
 * it stacks the field's editing surface:
 *
 *   - `FieldIdentitySection` — the "Field ID" section (id editor + actions).
 *   - `FieldEditorPanel`     — Data / Logic / Appearance, registry-driven.
 *   - shared `RemoveRow`     — deletion, always the body's last row.
 *
 * The wrapper `div` owns two things beyond layout:
 *   - `space-y-4` — the rail's section rhythm. A wrapper (not a fragment) so
 *     the delegated focus handler has one ancestor to listen on; the sections
 *     are still direct children of this div, so they get the same `space-y-4`
 *     + `first:` divider treatment as the case-list inspector's sections.
 *   - the delegated `onFocus` — tracks which `[data-field-id]` element holds
 *     focus so zundo snapshots capture the right field even for blur-triggered
 *     saves (where `document.activeElement` has already moved).
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerLock from "@iconify-icons/tabler/lock";
import { useCallback } from "react";
import { RemoveRow } from "@/components/builder/inspector/inspectorChrome";
import type { Field } from "@/lib/domain";
import { useDeleteSelectedField } from "@/lib/routing/builderActions";
import { useCanEdit, useSetActiveFieldId } from "@/lib/session/hooks";
import { FieldEditorPanel } from "./FieldEditorPanel";
import { FieldIdentitySection } from "./FieldIdentitySection";

interface FieldInspectorBodyProps {
	field: Field;
}

export function FieldInspectorBody({ field }: FieldInspectorBodyProps) {
	const setActiveFieldId = useSetActiveFieldId();
	const deleteSelected = useDeleteSelectedField();
	const canEdit = useCanEdit();

	const handleFocus = useCallback(
		(e: React.FocusEvent) => {
			const fieldEl = (e.target as HTMLElement).closest("[data-field-id]");
			setActiveFieldId(fieldEl?.getAttribute("data-field-id") ?? undefined);
		},
		[setActiveFieldId],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegated focusin for undo/redo field tracking
		<div
			onFocus={handleFocus}
			className="space-y-4"
			// Stable uuid tag (survives renames) so undo/redo's
			// `findFieldElement` can locate this field's property element in the
			// rail to flash it — see `lib/routing/domQueries.ts`.
			data-field-inspector={field.uuid}
		>
			{canEdit ? (
				<>
					<FieldIdentitySection field={field} />
					<FieldEditorPanel field={field} />
					<RemoveRow label="Delete field" onClick={deleteSelected} />
				</>
			) : (
				<>
					{/* A view-only Project member sees the field's full config —
					 *  it just can't take focus or be changed, and the delete +
					 *  identity-actions menu are gone (see `FieldIdentitySection`). */}
					<div aria-disabled className="space-y-4 pointer-events-none">
						<FieldIdentitySection field={field} />
						<FieldEditorPanel field={field} />
					</div>
					<p className="flex items-center gap-1.5 border-t border-nova-border pt-3 text-[11px] text-nova-text-muted">
						<Icon
							icon={tablerLock}
							width="13"
							height="13"
							className="shrink-0"
						/>
						View only — ask a Project admin for edit access.
					</p>
				</>
			)}
		</div>
	);
}
