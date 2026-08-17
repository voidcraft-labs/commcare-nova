"use client";

import { createContext } from "react";
import type { LanguageTag } from "@/lib/domain";

/** Selected worker-content language inside the Builder provider tree. */
export const BlueprintAuthoringLanguageContext =
	createContext<LanguageTag | null>(null);
