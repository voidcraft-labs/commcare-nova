"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { CaseType } from "@/lib/domain";
import type { NavigationDeviceCases } from "./displayConditionEvaluation";
import { useBuilderFormEngine } from "./provider";

const NO_CASE_TYPES: readonly CaseType[] = [];
const serverSnapshot = () => null;

/** The worker's device cases for the menus' display conditions: the snapshot
 * the case database provider installs on the engine controller, `null` while
 * it loads. */
export function useNavigationDeviceCases(
	caseTypes: readonly CaseType[] | undefined,
): NavigationDeviceCases {
	const controller = useBuilderFormEngine();
	const snapshot = useSyncExternalStore(
		controller.subscribeDeviceCaseDatabase,
		() => controller.deviceCaseDatabase,
		serverSnapshot,
	);
	const types = caseTypes ?? NO_CASE_TYPES;
	return useMemo(() => ({ snapshot, caseTypes: types }), [snapshot, types]);
}
