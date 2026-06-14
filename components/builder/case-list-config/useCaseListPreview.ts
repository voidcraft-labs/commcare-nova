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

import { useCallback, useEffect, useRef, useState } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig } from "@/lib/domain";
import { loadCaseListPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import type { LoadCaseListPreviewResult } from "@/lib/preview/engine/caseDataBindingTypes";

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

	const [state, setState] = useState<CaseListPreviewState>({ kind: "idle" });
	const [fetching, setFetching] = useState(false);
	const requestId = useRef(0);

	/* One async load drives both the config-change effect and the manual
	 * `reload` (which sample-data generation calls — it writes rows the
	 * config deps can't see). A monotonic request token gives last-write-wins
	 * across that race, and because `reload` IS this promise, the generate
	 * action can await it to hold its spinner until the fresh rows land.
	 *
	 * `docApi.getState` is a stable bound method on the doc-store singleton,
	 * so `load` only re-creates (and the effect only re-fires) on a real
	 * config / case-type / validity change. */
	const load = useCallback(async (): Promise<void> => {
		if (!configValid) {
			/* An invalid expression AST would throw at the SQL layer — the
			 * validity gate is the structural defense, not a hint. */
			setState({ kind: "paused" });
			setFetching(false);
			return;
		}
		requestId.current += 1;
		const id = requestId.current;
		/* Stale-while-revalidate: every config keystroke re-runs this load,
		 * and blanking the live table to a spinner per edit reads as flicker.
		 * Settled data arms stay on screen; `fetching` carries the signal. */
		setState((prev) =>
			prev.kind === "rows" || prev.kind === "empty"
				? prev
				: { kind: "loading" },
		);
		setFetching(true);
		let next: CaseListPreviewState;
		try {
			next = await loadCaseListPreviewAction({
				appId,
				caseType: currentCaseType,
				blueprint: pickBlueprintDoc(docApi.getState()),
				caseListConfig,
			});
		} catch (err: unknown) {
			next = {
				kind: "error",
				message: err instanceof Error ? err.message : "Failed to load preview.",
			};
		}
		if (id !== requestId.current) return; // a newer load / unmount superseded us
		setState(next);
		setFetching(false);
	}, [appId, caseListConfig, currentCaseType, configValid, docApi.getState]);

	useEffect(() => {
		void load();
		return () => {
			requestId.current += 1;
		};
	}, [load]);

	return { state, fetching, reload: load };
}
