"use client";

// The builder session's lookup fixture cache: one fetch of the doc's
// referenced tables' definitions + complete ordered rows, projected
// for client evaluation. Generation-keyed exactly like the case-data
// hooks — the request identity carries the reconciler's runtime scope
// id and the Project scope epoch, so the reconciler reset registry's
// epoch advance invalidates it (the recorded "S05 definition cache
// joins the registry" obligation), and readiness requires an
// authorized access phase. Freshness rides the Project realtime
// lookup clock: the manifest broker replays the latest validated
// manifest and every referenced table's revision joins the key, so a
// lookup edit anywhere in the Project refetches between form sessions
// (an active engine keeps its captured snapshot — per-form-session
// choice stability).

import { useEffect, useMemo, useState } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { useBlueprintDocEq } from "@/lib/doc/hooks/useBlueprintDoc";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { LookupManifest } from "@/lib/lookup/types";
import {
	useAccessPhase,
	useAppId,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { useReloadableResource } from "../hooks/useReloadableResource";
import { loadLookupFixtureDataAction } from "./lookupDataBinding";
import { type PreviewLookupData, previewLookupData } from "./lookupEvaluation";

type LookupDataState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "data"; data: PreviewLookupData }
	| { kind: "error" };

function sameIdList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The doc's referenced lookup table ids, sorted + deduped by the
 *  structural extractor registry — the ONE definition of "the doc
 *  references this table", the same set the commit path materializes
 *  as reference edges server-side. Value-stable across unrelated doc
 *  mutations. */
function useReferencedTableIds(): readonly string[] {
	return useBlueprintDocEq(
		(s) => extractLookupReferenceTargets(s).tableIds as readonly string[],
		sameIdList,
	);
}

/** Per-referenced-table revision fingerprint from the live manifest —
 *  `tableRevision` is each table's optimistic token
 *  (`max(definitionRevision, rowsRevision)`); a table absent from the
 *  manifest contributes its absence. */
function manifestRevisionKey(
	manifest: LookupManifest | null,
	tableIds: readonly string[],
): string {
	if (manifest === null) return "";
	const byId = new Map(manifest.tables.map((t) => [t.id as string, t]));
	return tableIds
		.map((id) => {
			const entry = byId.get(id);
			return entry === undefined
				? `${id}:absent`
				: `${id}:${entry.tableRevision}`;
		})
		.join(" ");
}

/**
 * The lookup fixture data the running preview evaluates carriers
 * against, or `null` while the doc references no tables, the load is
 * in flight, or the load failed (the engine treats null as its typed
 * loading state; navigation surfaces skip lookup folding until data
 * arrives). Mount ONCE in `BuilderFormEngineProvider` — the
 * controller install is the single distribution point.
 */
export function useLookupPreviewData(): PreviewLookupData | null {
	const appId = useAppId();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const reconciler = useReconcilerContext();
	const runtimeScopeId = reconciler?.projectScopeId ?? "provider-light";
	const tableIds = useReferencedTableIds();

	const [manifest, setManifest] = useState<LookupManifest | null>(null);
	useEffect(
		() => reconciler?.subscribeLookupManifest(setManifest),
		[reconciler],
	);
	const revisionKey = manifestRevisionKey(manifest, tableIds);

	const reloadToken = useMemo(
		() =>
			[
				runtimeScopeId,
				String(scopeEpoch),
				appId ?? "",
				tableIds.join(","),
				revisionKey,
			].join(" "),
		[runtimeScopeId, scopeEpoch, appId, tableIds, revisionKey],
	);

	const { state } = useReloadableResource<LookupDataState>({
		prepare: () => {
			if (
				appId === undefined ||
				tableIds.length === 0 ||
				accessPhase !== "authorized"
			) {
				return { notReady: { kind: "idle" } };
			}
			const id = appId;
			const ids = tableIds;
			return {
				fetch: async (): Promise<LookupDataState> => {
					const result = await loadLookupFixtureDataAction(id, ids);
					if (result.kind !== "data") return { kind: "error" };
					return {
						kind: "data",
						data: previewLookupData({
							projectRevision: result.data.projectRevision,
							definitions: result.data.definitions,
							/* The wire flattens branded table-id keys to plain strings;
							 * the ids came from the branded snapshot server-side. */
							rowsByTable: new Map(
								Object.entries(result.data.rowsByTable),
							) as unknown as PreviewLookupData["rowsByTable"],
						}),
					};
				},
			};
		},
		loading: { kind: "loading" },
		toError: () => ({ kind: "error" }),
		keepStale: (prev) => prev.kind === "data",
		reloadToken,
	});

	return state.kind === "data" ? state.data : null;
}
