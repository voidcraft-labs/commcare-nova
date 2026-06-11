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

import { useCallback, useEffect, useState } from "react";
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
}): { state: CaseListPreviewState; fetching: boolean; reload: () => void } {
	const { appId, caseListConfig, currentCaseType, configValid } = args;
	const docApi = useBlueprintDocApi();

	const [state, setState] = useState<CaseListPreviewState>({ kind: "idle" });
	const [fetching, setFetching] = useState(false);

	/* Bumps to re-fire the load after an out-of-band data change —
	 * generating or resetting sample data writes rows the config-driven
	 * deps can't see. */
	const [reloadKey, setReloadKey] = useState(0);
	const reload = useCallback(() => setReloadKey((k) => k + 1), []);

	// Re-fire on every config / validity / case-type change. The
	// `cancelled` flag handles in-flight cancellation — a fresh effect
	// fires before the previous resolved.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `reloadKey` is in deps on PURPOSE — it re-fires the load after sample-data writes the effect's own deps can't see.
	useEffect(() => {
		if (!configValid) {
			setState({ kind: "paused" });
			setFetching(false);
			return;
		}
		let cancelled = false;
		/* Stale-while-revalidate: every config keystroke re-fires this
		 * effect, and blanking the live table to a spinner per edit
		 * reads as flicker. Settled data arms stay rendered through
		 * the reload; `fetching` carries the in-flight signal. */
		setState((prev) =>
			prev.kind === "rows" || prev.kind === "empty"
				? prev
				: { kind: "loading" },
		);
		setFetching(true);
		const blueprint = pickBlueprintDoc(docApi.getState());
		loadCaseListPreviewAction({
			appId,
			caseType: currentCaseType,
			blueprint,
			caseListConfig,
		})
			.then((result) => {
				if (cancelled) return;
				setState(result);
				setFetching(false);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({
					kind: "error",
					message:
						err instanceof Error ? err.message : "Failed to load preview.",
				});
				setFetching(false);
			});
		return () => {
			cancelled = true;
		};
		// `docApi.getState` is a stable bound method on the doc-store API
		// singleton — in deps to satisfy the exhaustive-deps linter; its
		// identity never changes so it doesn't re-fire the effect.
	}, [
		appId,
		caseListConfig,
		currentCaseType,
		configValid,
		reloadKey,
		docApi.getState,
	]);

	return { state, fetching, reload };
}
