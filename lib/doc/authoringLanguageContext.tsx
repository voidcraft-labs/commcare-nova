"use client";

import { createContext } from "react";
import type { LanguageCode } from "@/lib/domain";

/** Selected worker-content language inside the Builder provider tree. */
export const BlueprintAuthoringLanguageContext =
	createContext<LanguageCode | null>(null);
