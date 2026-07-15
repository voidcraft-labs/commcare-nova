/**
 * useEngineState — subscribe to runtime state for a single field by UUID.
 *
 * Delegates to Zustand's `useStore` with a UUID-keyed selector over the
 * controller's runtime store. Zustand compares by reference, so fields
 * whose computed state object didn't change skip re-rendering — editing
 * field A only re-renders the row for A, not its siblings. Missing
 * UUIDs fall back to `DEFAULT_RUNTIME_STATE` so rows render safely
 * during the brief window between blueprint insertion and the next
 * engine tick.
 */
"use client";
import { useStore } from "zustand";
import {
	DEFAULT_RUNTIME_STATE,
	type RuntimeStoreState,
} from "@/lib/preview/engine/engineController";
import type { FieldState } from "@/lib/preview/engine/types";
import { useEngineController } from "./useEngineController";

export function useEngineState(uuid: string): FieldState {
	const controller = useEngineController();
	return useStore(
		controller.store,
		(s: RuntimeStoreState) => s[uuid] ?? DEFAULT_RUNTIME_STATE,
	);
}

/**
 * useEngineStateAt — subscribe to runtime state for a field at a concrete
 * engine path.
 *
 * Repeat-instance paths (any `[N]` segment, e.g. `/data/orders[1]/name`)
 * are keyed by path in the runtime store — one FieldState per live
 * instance, which is what lets two instances of the same field hold
 * different values, visibility, and validity. Every other field keeps the
 * uuid key, and the uuid also covers the render before the doc row (and
 * therefore the path) resolves.
 */
export function useEngineStateAt(
	uuid: string,
	path: string | undefined,
): FieldState {
	const controller = useEngineController();
	const key = path?.includes("[") ? path : uuid;
	return useStore(
		controller.store,
		(s: RuntimeStoreState) => s[key] ?? DEFAULT_RUNTIME_STATE,
	);
}
