/**
 * InsertionPointRow — flat-row wrapper around the existing `InsertionPoint`.
 *
 * In the legacy recursive renderer, insertion points were emitted as
 * sibling JSX between fields. The virtual list emits them as typed
 * row records, but the interactive behavior (lazy shell, hover reveal,
 * menu trigger) is the same — so this row is a thin delegation wrapper
 * that positions the existing component at the correct depth.
 *
 * Layout-stability during drag: `InsertionPoint` returns `null` when
 * `disabled` is true (which is during any active drag). That would
 * collapse this row's measured height to 0, the virtualizer's
 * `measureElement` ResizeObserver would pick it up, and every row below
 * the drag source would shift up — making the dragged row look
 * "smooshed". To prevent that we set `minHeight` on the wrapper equal
 * to the InsertionPoint's rest height, so the 24px gap is preserved
 * even when the inner button is intentionally hidden.
 */

"use client";
import { memo, type RefObject } from "react";
import { InsertionPoint } from "@/components/preview/form/InsertionPoint";
import type { Uuid } from "@/lib/doc/types";
import { depthPadding, INSERTION_REST_HEIGHT_PX } from "../rowStyles";

interface InsertionPointRowProps {
	/** Parent container uuid — form uuid for root level, group/repeat uuid
	 *  inside nested containers. */
	readonly parentUuid: Uuid;
	/** Insertion index in the parent's child array. */
	readonly beforeIndex: number;
	readonly depth: number;
	/** Ref to the EMA-smoothed cursor speed, shared from the scroll
	 *  container level so all insertion points coordinate hover gating. */
	readonly cursorSpeedRef?: RefObject<number>;
	readonly lastCursorRef?: RefObject<
		{ x: number; y: number; t: number } | undefined
	>;
	/** Disable the InsertionPoint's hover/click affordances during an
	 *  active drag. The wrapper still preserves the 24px gap so the
	 *  virtualizer doesn't collapse the spacing between rows. */
	readonly disabled?: boolean;
}

export const InsertionPointRow = memo(function InsertionPointRow({
	parentUuid,
	beforeIndex,
	depth,
	cursorSpeedRef,
	lastCursorRef,
	disabled,
}: InsertionPointRowProps) {
	return (
		<div
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(depth),
				// Preserve the gap even while `InsertionPoint` is disabled
				// (returns null). See the module docstring for why this
				// matters to the virtualizer.
				minHeight: INSERTION_REST_HEIGHT_PX,
			}}
		>
			<InsertionPoint
				atIndex={beforeIndex}
				parentUuid={parentUuid}
				disabled={disabled}
				cursorSpeedRef={cursorSpeedRef}
				lastCursorRef={lastCursorRef}
			/>
		</div>
	);
});
