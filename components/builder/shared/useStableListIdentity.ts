"use client";

import { useId, useLayoutEffect, useRef } from "react";
import {
	createStableListIdentity,
	type StableListIdentity,
} from "./stableListIdentity";

export type {
	StableListIdentity,
	StableListOperation,
} from "./stableListIdentity";
export {
	reconcileStableListKeys,
	stableValueFingerprint,
} from "./stableListIdentity";

/** React commits the production sidecar ledger; speculative renders never do. */
export function useStableListIdentity<T>(
	items: readonly T[],
): StableListIdentity<T> {
	const prefix = useId();
	const ownerRef = useRef<ReturnType<
		typeof createStableListIdentity<T>
	> | null>(null);
	if (ownerRef.current === null)
		ownerRef.current = createStableListIdentity<T>(prefix);
	const frame = ownerRef.current.render(items);
	useLayoutEffect(() => frame.commit(), [frame]);
	return { keys: frame.keys, stage: frame.stage };
}
