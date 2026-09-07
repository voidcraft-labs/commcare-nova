/** Browser adapter for the document-backed form drag session. */
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useContext, useEffect, useState } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { useSelect } from "@/lib/routing/hooks";
import { isDraggableFieldData, readDropTargetData } from "./dragData";
import { createFormDragSession, type FormDragSnapshot } from "./dragIntent";
import type { FormRow } from "./rowModel";

export function useDragIntent({
	formUuid: _formUuid,
	baseRowsRef,
}: {
	readonly formUuid: Uuid;
	readonly baseRowsRef: React.RefObject<readonly FormRow[]>;
}) {
	const docStore = useContext(BlueprintDocContext);
	const { moveField } = useBlueprintMutations();
	const select = useSelect();
	const [snapshot, setSnapshot] = useState<FormDragSnapshot>({
		dragActive: false,
		placeholderIndex: null,
		placeholderDepth: 0,
	});

	useEffect(() => {
		if (!docStore) return;
		const session = createFormDragSession({
			getDoc: () => docStore.getState(),
			getRows: () => baseRowsRef.current,
			onChange: setSnapshot,
		});
		setSnapshot(session.getSnapshot());
		let previousCursor: string | null = null;
		function restoreCursor() {
			if (previousCursor === null) return;
			document.body.style.cursor = previousCursor;
			previousCursor = null;
		}
		const stop = monitorForElements({
			canMonitor: ({ source }) => isDraggableFieldData(source.data),
			onDragStart: ({ source }) => {
				if (!isDraggableFieldData(source.data)) return;
				session.start(source.data.uuid);
				previousCursor ??= document.body.style.cursor;
				document.body.style.cursor = "grabbing";
				select(undefined);
			},
			onDrag: ({ location }) => {
				const innermost = location.current.dropTargets[0];
				const drop = innermost && readDropTargetData(innermost.data);
				session.hover(
					drop ? { drop, edge: extractClosestEdge(innermost.data) } : null,
				);
			},
			onDrop: ({ location }) => {
				// Native dragover is frame-throttled. A quick drop may arrive
				// before the last hover callback, so the drop event owns its target.
				const innermost = location.current.dropTargets[0];
				const drop = innermost && readDropTargetData(innermost.data);
				if (!drop && innermost?.data.kind !== "drop-placeholder") {
					// Pragmatic DnD also emits onDrop after Escape or an unhandled
					// browser drop, with no targets. Only the registered placeholder
					// may reuse the last landing; cancellation must retire it.
					restoreCursor();
					session.cancel();
					return;
				}
				session.hover(
					drop ? { drop, edge: extractClosestEdge(innermost.data) } : null,
				);
				restoreCursor();
				const plan = session.drop();
				if (plan && moveField(plan.uuid, plan.placement).ok) select(plan.uuid);
			},
		});
		return () => {
			stop();
			restoreCursor();
		};
	}, [docStore, moveField, select, baseRowsRef]);

	return snapshot;
}
