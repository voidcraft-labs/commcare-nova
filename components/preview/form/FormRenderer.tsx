/**
 * FormRenderer — dispatcher between the edit-mode virtualized list and
 * the interactive (pointer/test) recursive renderer.
 *
 * The form editor has two fundamentally different presentations:
 *
 *   1. Edit view (edit context + edit cursor): structural editing with
 *      selection, insertion points, drag-to-reorder, per-field panels.
 *      Performance critical — rendered via `VirtualFormList` over a flat
 *      row model.
 *
 *   2. Interactive view (pointer cursor, or test mode): the form as the
 *      end-user will fill it in — answer-driven visibility, real repeat
 *      instances, validation feedback. Rendered recursively by
 *      `InteractiveFormRenderer`, which preserves CommCare's runtime
 *      semantics.
 *
 * This component owns the branch. Both render paths are full subtrees,
 * so toggling between them unmounts one and mounts the other — a clean
 * break that avoids cross-contaminating hook orders and makes the two
 * renderers totally independent.
 *
 * Callers (the single entry point is `FormScreen`) don't need to know
 * which path is active — they always render `<FormRenderer parentEntityId
 * ={formUuid} />` and the branch picks the right implementation.
 */

"use client";
import { memo } from "react";
import { asUuid } from "@/lib/doc/types";
import type { FieldPath } from "@/lib/services/fieldPath";
import { useCursorMode, useEditMode } from "@/lib/session/hooks";
import { InteractiveFormRenderer } from "./InteractiveFormRenderer";
import { VirtualFormList } from "./virtual/VirtualFormList";

interface FormRendererProps {
	/** Entity uuid owning this level's children — at the form root this
	 *  is the form's uuid; nested calls (from `InteractiveFormRenderer`
	 *  via GroupField/RepeatField) pass the group or repeat uuid. */
	readonly parentEntityId: string;
	/** XForm data path prefix. Defaults to `"/data"` at the root. */
	readonly prefix?: string;
	/** Blueprint field path of the parent (nested calls only). */
	readonly parentPath?: FieldPath;
}

export const FormRenderer = memo(function FormRenderer({
	parentEntityId,
	prefix,
	parentPath,
}: FormRendererProps) {
	const mode = useEditMode();
	const cursorMode = useCursorMode();

	// The virtualized path applies only at the form root — nested calls
	// come from `GroupField` / `RepeatField` inside the interactive tree
	// and must go recursively. The root-only gate is the `parentPath`
	// check: nested calls always pass one.
	const isRoot = !parentPath;
	const useVirtualized = isRoot && mode === "edit" && cursorMode === "edit";

	if (useVirtualized) {
		// `parentEntityId` at the root is the form uuid — cast to the
		// branded type here so `VirtualFormList`'s domain API stays tight.
		return <VirtualFormList formUuid={asUuid(parentEntityId)} />;
	}

	return (
		<InteractiveFormRenderer
			parentEntityId={parentEntityId}
			prefix={prefix}
			parentPath={parentPath}
		/>
	);
});
