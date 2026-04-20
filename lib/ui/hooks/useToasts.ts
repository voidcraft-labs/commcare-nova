"use client";

import { useSyncExternalStore } from "react";
import { toastStore } from "@/lib/services/toastStore";

export function useToasts() {
	useSyncExternalStore(
		toastStore.subscribe,
		toastStore.getSnapshot,
		toastStore.getSnapshot,
	);
	return toastStore;
}
