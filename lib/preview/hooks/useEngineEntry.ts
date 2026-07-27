"use client";

import { useStore } from "zustand";
import type { EngineEntryState } from "@/lib/preview/engine/engineController";
import { useEngineController } from "./useEngineController";

/**
 * Observe the controller's authoritative form-entry identity.
 *
 * Per-field runtime subscriptions cannot stand in for this: a same-persona
 * material identity change rotates the entry from a provider effect, and
 * FormScreen must see that boundary even when none of its own props changed.
 */
export function useEngineEntry(): EngineEntryState {
	const controller = useEngineController();
	return useStore(controller.entryStore);
}
