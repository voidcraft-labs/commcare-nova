"use client";

// The builder session's lookup fixture cache: one fetch of the doc's
// referenced tables' definitions + complete ordered rows, projected
// for client evaluation. Generation-keyed exactly like the case-data
// hooks — the request identity carries the reconciler's runtime scope
// id and the Project scope epoch, so the reconciler reset registry's
// epoch advance invalidates it, and readiness requires an
// authorized access phase. Freshness rides the Project realtime
// lookup clock: the manifest broker replays the latest validated
// manifest and every referenced table's revision joins the key, so a
// lookup edit anywhere in the Project refetches between form sessions
// (an active engine keeps its captured snapshot — per-form-session
// choice stability).

import {
	createContext,
	memo,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { useBlueprintDocEq } from "@/lib/doc/hooks/useBlueprintDoc";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { LookupManifest } from "@/lib/lookup/types";
import {
	useAccessPhase,
	useAppId,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { useEngineController } from "../hooks/useEngineController";
import { useReloadableResource } from "../hooks/useReloadableResource";
import { loadLookupFixtureDataAction } from "./lookupDataBinding";
import { type PreviewLookupData, previewLookupData } from "./lookupEvaluation";

/**
 * The builder session's lookup-data status, as navigation surfaces
 * consume it: `idle` — the doc references no tables; `loading` — the
 * fetch is in flight (carrier-bearing surfaces render placeholders);
 * `data` — the evaluation-ready snapshot; `error` — the load failed
 * (a carrier evaluation then fails loudly rather than resolving
 * blank).
 */
export type PreviewLookupStatus =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "data"; data: PreviewLookupData }
	| { kind: "error" };

/** The provider's own state: a snapshot also names the referenced tables it
 * was read for, which tells a waiting form whether a newer read is coming. */
type LookupDataState =
	| Exclude<PreviewLookupStatus, { kind: "data" }>
	| {
			kind: "data";
			data: PreviewLookupData;
			tableIds: readonly string[];
	  };

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

function useLookupPreviewDataResource(): {
	readonly status: LookupDataState;
	readonly reload: () => Promise<void>;
} {
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

	const { state, reload } = useReloadableResource<LookupDataState>({
		prepare: () => {
			if (
				appId === undefined ||
				tableIds.length === 0 ||
				accessPhase !== "authorized"
			) {
				return { notReady: { kind: "idle" } };
			}
			/* A null manifest is an explicit current-page reset, including the
			 * malformed-frame recovery window. Drop any retained fixture snapshot
			 * and wait for the authoritative manifest before fetching definitions or
			 * rows; Preview must never run against stale lookup bytes. */
			if (manifest === null) {
				return { notReady: { kind: "loading" } };
			}
			const id = appId;
			const ids = tableIds;
			return {
				fetch: async (): Promise<LookupDataState> => {
					const result = await loadLookupFixtureDataAction(id, ids);
					if (result.kind !== "data") return { kind: "error" };
					return {
						kind: "data",
						tableIds: ids,
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

	return { status: state, reload };
}

const PreviewLookupDataContext = createContext<PreviewLookupStatus>({
	kind: "idle",
});

/** Read the session's lookup data again, after a failed load. */
const PreviewLookupReloadContext = createContext<() => void>(() => undefined);

function samePreviewLookupStatus(
	left: LookupDataState,
	right: LookupDataState,
): boolean {
	if (left === right) return true;
	if (left.kind !== right.kind) return false;
	/* The Project revision alone is not the snapshot's identity: an edit
	 * that reads one more unchanged table reads a snapshot at the same
	 * revision with that table in it. */
	return (
		left.kind === "data" &&
		right.kind === "data" &&
		left.data.projectRevision === right.data.projectRevision &&
		sameIdList(left.tableIds, right.tableIds)
	);
}

const PreviewLookupDataBoundary = memo(function PreviewLookupDataBoundary({
	status,
	reload,
	children,
}: {
	readonly status: PreviewLookupStatus;
	readonly reload: () => void;
	readonly children: ReactNode;
}) {
	return (
		<>
			<span
				hidden
				aria-hidden="true"
				data-builder-resource="lookup-preview"
				data-state={status.kind}
			/>
			<PreviewLookupDataContext value={status}>
				<PreviewLookupReloadContext value={reload}>
					{children}
				</PreviewLookupReloadContext>
			</PreviewLookupDataContext>
		</>
	);
});

/**
 * Owns the ONE builder-session lookup fetch: installs the snapshot on
 * the engine controller (the distribution point every form activation
 * captures from) and provides the live status to navigation surfaces.
 * Mount inside the session, doc, reconciler, AND engine providers —
 * `BuilderProvider` wraps the builder subtree with it.
 */
export function PreviewLookupDataProvider({
	children,
}: {
	children: ReactNode;
}) {
	const controller = useEngineController();
	const { status: calculatedStatus, reload } = useLookupPreviewDataResource();
	const stableStatusRef = useRef(calculatedStatus);
	if (!samePreviewLookupStatus(stableStatusRef.current, calculatedStatus)) {
		stableStatusRef.current = calculatedStatus;
	}
	const status = stableStatusRef.current;
	const data = status.kind === "data" ? status.data : null;
	const tableIds = status.kind === "data" ? status.tableIds : undefined;
	const failed = status.kind === "error";
	useEffect(() => {
		controller.setLookupData(data, tableIds);
	}, [controller, data, tableIds]);
	useEffect(() => {
		controller.setLookupLoadFailed(failed);
	}, [controller, failed]);
	const retry = useCallback(() => {
		controller.setLookupLoadFailed(false);
		reload().catch(() => undefined);
	}, [controller, reload]);
	return (
		<PreviewLookupDataBoundary status={status} reload={retry}>
			{children}
		</PreviewLookupDataBoundary>
	);
}

/** The live lookup-data status — `idle` outside the provider, which
 *  is also correct for surfaces rendered outside the builder. */
export function usePreviewLookupStatus(): PreviewLookupStatus {
	return useContext(PreviewLookupDataContext);
}

/** Read the session's lookup data again: the retry a failed load offers. */
export function usePreviewLookupReload(): () => void {
	return useContext(PreviewLookupReloadContext);
}
