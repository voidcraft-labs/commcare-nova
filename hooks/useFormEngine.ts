/**
 * React hook wrapping FormEngine with subscription-based re-rendering.
 * Persists live-mode values across engine recreations (caused by entity mutations).
 *
 * The form object passed in is assembled from normalized entities via
 * useAssembledForm — it's a new reference when any entity in the form changes
 * (Immer structural sharing). The prevFormRef comparison handles recreation.
 * No mutationCount needed.
 */
"use client";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { FormEngine } from "@/lib/preview/engine/formEngine";
import type { BlueprintForm, CaseType } from "@/lib/schemas/blueprint";

export function useFormEngine(
	form: BlueprintForm,
	caseTypes?: CaseType[],
	moduleCaseType?: string,
	caseData?: Map<string, string>,
): FormEngine {
	/* Persist live values across engine recreations so edits in preview
	 * don't wipe test data. Engine is recreated when any input reference
	 * changes — the assembled form gets a new reference from useMemo when
	 * the underlying entities change. */
	const liveSnapshotRef = useRef<
		{ values: Map<string, string>; touched: Set<string> } | undefined
	>(undefined);
	const engineRef = useRef<FormEngine | undefined>(undefined);
	const prevFormRef = useRef(form);
	const prevCaseTypesRef = useRef(caseTypes);
	const prevModuleCaseTypeRef = useRef(moduleCaseType);
	const prevCaseDataRef = useRef(caseData);

	if (
		!engineRef.current ||
		prevFormRef.current !== form ||
		prevCaseTypesRef.current !== caseTypes ||
		prevModuleCaseTypeRef.current !== moduleCaseType ||
		prevCaseDataRef.current !== caseData
	) {
		/* Snapshot values from previous engine before creating new one */
		if (engineRef.current) {
			liveSnapshotRef.current = engineRef.current.getValueSnapshot();
		}

		const newEngine = new FormEngine(form, caseTypes, moduleCaseType, caseData);

		/* Restore values if we have a snapshot */
		if (liveSnapshotRef.current) {
			newEngine.restoreValues(liveSnapshotRef.current);
		}

		engineRef.current = newEngine;
		prevFormRef.current = form;
		prevCaseTypesRef.current = caseTypes;
		prevModuleCaseTypeRef.current = moduleCaseType;
		prevCaseDataRef.current = caseData;
	}

	if (!engineRef.current) throw new Error("FormEngine was not initialized");
	const engine = engineRef.current;

	/* Re-render when the engine notifies (value changes, validation, etc.) */
	const subscribe = useCallback(
		(cb: () => void) => engine.subscribe(cb),
		[engine],
	);
	const getSnapshot = useCallback(() => engine.getSnapshot(), [engine]);
	useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	return engine;
}
