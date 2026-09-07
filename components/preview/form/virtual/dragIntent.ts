/** The live document owns both the visible drag landing and its eventual move. */
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { type DropTargetData, targetContainerUuidFor } from "./dragData";
import { draggedRowSpan } from "./dropNoOp";
import { landingAllowed } from "./landingGuards";
import type { FormRow } from "./rowModel";

export interface FormDropTarget {
	readonly drop: DropTargetData;
	readonly edge: Edge | null;
}

export interface FormDropPlan {
	readonly uuid: Uuid;
	readonly placement: {
		readonly toParentUuid: Uuid;
		readonly beforeUuid?: Uuid;
		readonly afterUuid?: Uuid;
	};
	readonly placeholderIndex: number;
	readonly placeholderDepth: number;
}

export function resolveFormDrop(
	doc: BlueprintDoc,
	rows: readonly FormRow[],
	uuid: Uuid,
	{ drop, edge }: FormDropTarget,
): FormDropPlan | null {
	const source = doc.fields[uuid];
	if (!source) return null;
	const sectionDrag = source.kind === "section";
	const toParentUuid = targetContainerUuidFor(drop, edge, sectionDrag);
	if (!doc.forms[toParentUuid] && !doc.fields[toParentUuid]) return null;
	if (!landingAllowed(doc, uuid, toParentUuid)) return null;

	// A peer can remove or reparent the row after the drag last observed it.
	// Refuse that stale target instead of resolving its old ordinal elsewhere.
	if (drop.kind !== "drop-empty-container") {
		if (
			!doc.fields[drop.uuid] ||
			doc.fieldParent[drop.uuid] !== drop.parentUuid
		) {
			return null;
		}
		if (drop.uuid === uuid) return null;
	}
	const siblings = orderedFieldUuids(doc, toParentUuid);
	let beforeIndex: number;
	let placement: FormDropPlan["placement"];
	if (
		drop.kind === "drop-empty-container" ||
		((drop.kind === "drop-group-header" ||
			drop.kind === "drop-section-header") &&
			edge !== "top" &&
			!sectionDrag)
	) {
		beforeIndex = 0;
		const first = siblings[0];
		placement = first ? { toParentUuid, beforeUuid: first } : { toParentUuid };
	} else {
		const targetIndex = siblings.indexOf(drop.uuid);
		if (targetIndex < 0) return null;
		beforeIndex = targetIndex + (edge === "top" ? 0 : 1);
		placement =
			edge === "top"
				? { toParentUuid, beforeUuid: drop.uuid }
				: { toParentUuid, afterUuid: drop.uuid };
	}
	// The source already occupies either side of this gap.
	const sourceIndex = siblings.indexOf(uuid);
	if (
		sourceIndex >= 0 &&
		(beforeIndex === sourceIndex || beforeIndex === sourceIndex + 1)
	) {
		return null;
	}
	const placeholderIndex =
		drop.kind === "drop-empty-container"
			? rows.findIndex(
					(row) =>
						row.kind === "empty-container" && row.parentUuid === toParentUuid,
				)
			: rows.findIndex(
					(row) =>
						row.kind === "insertion" &&
						row.parentUuid === toParentUuid &&
						row.beforeIndex === beforeIndex,
				);
	if (placeholderIndex < 0) return null;
	const span = draggedRowSpan(rows, uuid);
	if (
		span &&
		(placeholderIndex === span[0] - 1 || placeholderIndex === span[1] + 1)
	)
		return null;
	return {
		uuid,
		placement,
		placeholderIndex,
		placeholderDepth: rows[placeholderIndex].depth,
	};
}

export interface FormDragSnapshot {
	readonly dragActive: boolean;
	readonly placeholderIndex: number | null;
	readonly placeholderDepth: number;
}

/** Owns one drag independently of React and the browser's native event adapter. */
export function createFormDragSession(options: {
	readonly getDoc: () => BlueprintDoc;
	readonly getRows: () => readonly FormRow[];
	readonly onChange: (snapshot: FormDragSnapshot) => void;
}) {
	let source: Uuid | null = null;
	let pending: FormDropTarget | null = null;
	let snapshot: FormDragSnapshot = {
		dragActive: false,
		placeholderIndex: null,
		placeholderDepth: 0,
	};
	function publish(next: FormDragSnapshot) {
		if (
			next.dragActive === snapshot.dragActive &&
			next.placeholderIndex === snapshot.placeholderIndex &&
			next.placeholderDepth === snapshot.placeholderDepth
		)
			return;
		snapshot = next;
		options.onChange(snapshot);
	}
	function cancel() {
		source = null;
		pending = null;
		publish({ dragActive: false, placeholderIndex: null, placeholderDepth: 0 });
	}
	return {
		getSnapshot: () => snapshot,
		start(uuid: Uuid) {
			source = uuid;
			pending = null;
			publish({
				dragActive: true,
				placeholderIndex: null,
				placeholderDepth: 0,
			});
		},
		hover(target: FormDropTarget | null) {
			// The placeholder opens an untargeted gap. Preserve the last landing
			// there, otherwise removing the gap would shift the rows under the cursor.
			if (!source || !target) return;
			const plan = resolveFormDrop(
				options.getDoc(),
				options.getRows(),
				source,
				target,
			);
			pending = plan ? target : null;
			publish({
				dragActive: true,
				placeholderIndex: plan?.placeholderIndex ?? null,
				placeholderDepth: plan?.placeholderDepth ?? 0,
			});
		},
		drop(): FormDropPlan | null {
			const plan =
				source && pending
					? resolveFormDrop(
							options.getDoc(),
							options.getRows(),
							source,
							pending,
						)
					: null;
			cancel();
			return plan;
		},
		cancel,
	};
}
