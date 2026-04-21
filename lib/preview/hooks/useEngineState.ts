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
