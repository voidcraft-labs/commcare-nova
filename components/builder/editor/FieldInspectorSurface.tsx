/**
 * FieldInspectorSurface — docks the selected field's editor into the right
 * rail. The form-editing counterpart of the case-list workspace's inspector
 * mount: when a field is selected in edit mode it claims the rail and renders
 * the field's properties; deselecting (the close button, or the builder's
 * global Escape in `useBuilderShortcuts`, which already clears `selectedUuid`)
 * releases it. The claim self-releases too when `FormScreen`'s Activity hides.
 *
 * Edit-mode only: selection survives a preview toggle in the URL, but the
 * inspector must not dock over the running app — so preview renders nothing
 * here and the rail returns to chat.
 */
"use client";
import { useCallback } from "react";
import { FieldInspectorBody } from "@/components/builder/editor/FieldInspectorBody";
import { InspectorSurface } from "@/components/builder/inspector/InspectorSurface";
import { type Field, fieldRegistry } from "@/lib/domain";
import { useSelect, useSelectedField } from "@/lib/routing/hooks";
import { useEditMode } from "@/lib/session/hooks";

/**
 * Gate the dock on an active edit-mode selection BEFORE reaching for
 * `useSelect` (which subscribes to the URL and consults the edit guard).
 * FieldInspectorSurface mounts on every form render; calling `useSelect`
 * here unconditionally would run that subscription + guard consult even when
 * nothing is selected, and would couple `FormScreen` to an EditGuardProvider
 * in the tests that render it standalone. The inner `FieldInspectorDock`
 * only mounts once a field is actually selected, so the consult rides the
 * same lifecycle the old inline panel did. (In the app the provider is
 * always present — `BuilderProvider` wraps the whole tree — so this is about
 * doing no work while idle, not a production correctness requirement.)
 */
export function FieldInspectorSurface() {
	const field = useSelectedField();
	const mode = useEditMode();
	if (!field || mode !== "edit") return null;
	return <FieldInspectorDock field={field} />;
}

function FieldInspectorDock({ field }: { field: Field }) {
	const select = useSelect();
	const handleClose = useCallback(() => select(undefined), [select]);

	// Title = the field's prompt, falling back to its id (the `hidden` kind
	// carries no label). The header truncates, so a long markdown label is
	// shown raw rather than rendered — short labels are the norm.
	const label = "label" in field ? field.label?.trim() : undefined;
	const title = label || field.id;

	return (
		<InspectorSurface
			kicker={fieldRegistry[field.kind].label}
			title={title}
			onClose={handleClose}
		>
			<FieldInspectorBody field={field} />
		</InspectorSurface>
	);
}
