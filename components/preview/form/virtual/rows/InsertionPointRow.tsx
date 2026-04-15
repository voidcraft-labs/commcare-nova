/**
 * InsertionPointRow — flat-row wrapper around the existing `InsertionPoint`.
 *
 * In the legacy recursive renderer, insertion points were emitted as
 * sibling JSX between questions. The virtual list emits them as typed
 * row records, but the interactive behavior (lazy shell, hover reveal,
 * menu trigger) is the same — so this row is a thin delegation wrapper
 * that positions the existing component at the correct depth.
 */

"use client";
import { memo, type RefObject } from "react";
import { InsertionPoint } from "@/components/preview/form/InsertionPoint";
import type { Uuid } from "@/lib/doc/types";
import { depthPadding } from "../rowStyles";

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
	/** Disable hover behavior during an active drag. */
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
				paddingRight: depthPadding(0),
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
