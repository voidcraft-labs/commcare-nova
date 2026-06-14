// components/builder/case-list-config/useCaseListPreview.ts
//
// Live case rows for the authoring canvases. One load at the
// workspace level feeds both the case-list table (all rows) and the
// case-detail card (first row) — same `loadCaseListPreviewAction`
// Server Action the magazine-era preview used, querying the case
// store with the authored filter / sort / calculated projections
// applied.
//
// Authoring contract: the load is suppressed while the caller's
// `configValid` is `false`. Sending an invalid expression AST to
// `compileExpression` would throw at the SQL layer; the validity gate
// is the structural defense rather than a hint.

"use client";

import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig } from "@/lib/domain";
import { loadCaseListPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import type { LoadCaseListPreviewResult } from "@/lib/preview/engine/caseDataBindingTypes";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";

export type CaseListPreviewState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "paused" }
	| LoadCaseListPreviewResult;

export function useCaseListPreview(args: {
	appId: string;
	caseListConfig: CaseListConfig;
	currentCaseType: string;
	configValid: boolean;
}): {
	state: CaseListPreviewState;
	fetching: boolean;
	/** Re-runs the load; the returned promise resolves once the re-fired
	 *  load SETTLES, so the sample-data action can hold its spinner until
	 *  the fresh rows are on screen rather than the write merely returning. */
	reload: () => Promise<void>;
} {
	const { appId, caseListConfig, currentCaseType, configValid } = args;
	const docApi = useBlueprintDocApi();

	/* `docApi.getState` is a stable bound method on the doc-store singleton,
	 * so the load only re-fires on a real config / case-type / validity change.
	 * The blueprint is read fresh inside the fetch so a reload after an edit
	 * materializes calculated columns against the current doc. */
	return useReloadableResource<CaseListPreviewState>({
		prepare: () =>
			!configValid
				? /* An invalid expression AST would throw at the SQL layer — the
					 * validity gate is the structural defense, not a hint. */
					{ notReady: { kind: "paused" } }
				: {
						fetch: () =>
							loadCaseListPreviewAction({
								appId,
								caseType: currentCaseType,
								blueprint: pickBlueprintDoc(docApi.getState()),
								caseListConfig,
							}),
					},
		loading: { kind: "loading" },
		toError: (err) => ({
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load preview.",
		}),
		keepStale: (prev) => prev.kind === "rows" || prev.kind === "empty",
		deps: [
			appId,
			caseListConfig,
			currentCaseType,
			configValid,
			docApi.getState,
		],
	});
}
