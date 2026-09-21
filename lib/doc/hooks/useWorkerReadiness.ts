"use client";

import { useMemo } from "react";
import { workerReadiness } from "@/lib/domain/workerReadiness";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/** Subscribe to authored worker setup, not unrelated form edits or live rows. */
export function useWorkerReadiness() {
	const source = useBlueprintDocShallow((s) => ({
		userProperties: s.userProperties,
		userPropertyOrder: s.userPropertyOrder,
		userTypes: s.userTypes,
		userTypeOrder: s.userTypeOrder,
		personas: s.personas,
		personaOrder: s.personaOrder,
		organizationLevels: s.organizationLevels,
		organizationLevelOrder: s.organizationLevelOrder,
	}));
	return useMemo(() => workerReadiness(source), [source]);
}
