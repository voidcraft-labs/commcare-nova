/**
 * BlueprintDoc React context + provider.
 *
 * Task 18 fills in the actual <BlueprintDocProvider> component. The
 * context is defined here so that hooks can import from a stable
 * module path even before the provider ships.
 */

"use client";

import { createContext } from "react";
import type { createBlueprintDocStore } from "@/lib/doc/store";

export type BlueprintDocStore = ReturnType<typeof createBlueprintDocStore>;

export const BlueprintDocContext = createContext<BlueprintDocStore | null>(
	null,
);
