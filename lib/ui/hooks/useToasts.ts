"use client";

import { useSyncExternalStore } from "react";
import { toastStore } from "../toastStore";

export function useToasts() {
	useSyncExternalStore(
		toastStore.subscribe,
		toastStore.getSnapshot,
		toastStore.getSnapshot,
	);
	return toastStore;
}
