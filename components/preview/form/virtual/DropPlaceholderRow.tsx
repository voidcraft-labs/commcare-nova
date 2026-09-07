import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { useEffect, useRef } from "react";
import { depthPadding, INSERTION_REST_HEIGHT_PX } from "./rowStyles";

// ── Drop placeholder row ────────────────────────────────────────────

/**
 * The visible gap that opens at the drop position during drag. Registered
 * as a `dropTargetForElements` so the browser accepts the native drop
 * (calls `preventDefault` on `dragover`): without this, the browser
 * rejects the drop, plays its snap-back animation, and THEN our monitor
 * fires the mutation, producing a jarring delay.
 */
export function DropPlaceholderRow({ depth }: { depth: number }) {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		return dropTargetForElements({
			element: el,
			// Accept anything: the monitor handles the actual mutation.
			getData: () => ({ kind: "drop-placeholder" }),
		});
	}, []);

	return (
		<div
			ref={ref}
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(depth),
				paddingTop: INSERTION_REST_HEIGHT_PX / 2,
				paddingBottom: INSERTION_REST_HEIGHT_PX / 2,
			}}
		>
			<div className="h-[56px] rounded-lg border-2 border-dashed border-nova-violet bg-nova-violet/20" />
		</div>
	);
}
