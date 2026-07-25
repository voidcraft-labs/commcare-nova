"use client";

// The Project data workspace's two reads: the Project's table manifest and
// one open table's full snapshot.
//
// Both are generation-keyed exactly like the case-data and lookup-fixture
// hooks. The request identity carries the reconciler's runtime scope id and
// the Project scope epoch, so a cross-Project move (which advances the epoch
// and reseeds `useProjectId`) invalidates every cached read rather than
// showing the previous Project's tables under the new one. Readiness requires
// an authorized access phase, so a paused session never fetches.
//
// Freshness rides the Project realtime lookup clock. The manifest broker
// replays the latest validated manifest; its `projectRevision` joins the
// manifest key and each table's own `tableRevision` joins that table's key,
// so a co-member's edit refetches exactly what it changed. The pushed
// manifest is used as the INVALIDATION signal rather than as the data,
// because a session with a dormant reconciler (a replay view, a new build)
// receives no frames at all and must still load.

import { useEffect, useMemo, useState } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	getLookupManifestAction,
	getLookupTableAction,
} from "@/lib/lookup/actions";
import type {
	LookupFailure,
	LookupManifest,
	LookupTableManifestEntry,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";
import {
	useAccessPhase,
	useProjectId,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";

/**
 * A Project-scoped read's state. `idle` means there is nothing to read yet
 * (no Project resolved, or access is not authorized) — deliberately distinct
 * from `loading`, so a surface can tell "waiting for the session" from
 * "waiting for the server" and neither renders as an empty result.
 */
export type ProjectDataRead<Value> =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "data"; value: Value }
	| { kind: "failed"; failure: LookupFailure };

/** The wire failure a Server Action throw collapses to. A thrown boundary is
 *  an infrastructure fault, not one of the service's typed rejections, so it
 *  gets its own words rather than borrowing `internal_error`'s. */
function transportFailure(): LookupFailure {
	return {
		success: false,
		code: "internal_error",
		message:
			"Nova could not reach the project's data tables. Check your connection and try again.",
	};
}

/** The live Project lookup manifest, or `null` before one arrives. Used only
 *  as a freshness signal; the authoritative read is the action below. */
function usePushedManifest(): LookupManifest | null {
	const reconciler = useReconcilerContext();
	const [manifest, setManifest] = useState<LookupManifest | null>(null);
	useEffect(
		() => reconciler?.subscribeLookupManifest(setManifest),
		[reconciler],
	);
	return manifest;
}

/** The runtime scope id every Project-scoped request identity carries, so a
 *  reset registry epoch advance can never let a stale settle commit. */
function useRuntimeScopeId(): string {
	return useReconcilerContext()?.projectScopeId ?? "provider-light";
}

export interface ProjectDataManifest {
	readonly projectId: string;
	readonly tables: readonly LookupTableManifestEntry[];
}

/**
 * Every lookup table in the app's Project, newest revision first known to
 * this session. Reloads whenever the Project clock advances.
 */
export function useProjectDataManifest(): {
	readonly state: ProjectDataRead<ProjectDataManifest>;
	readonly reload: () => Promise<void>;
} {
	const projectId = useProjectId();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const runtimeScopeId = useRuntimeScopeId();
	const pushed = usePushedManifest();
	/* Only a manifest for THIS Project may invalidate this read; a frame that
	 * arrived for the previous Project during a move must not retrigger a
	 * fetch keyed on the new one. */
	const pushedRevision =
		pushed !== null && pushed.projectId === projectId
			? pushed.projectRevision
			: "";

	const reloadToken = useMemo(
		() =>
			[
				runtimeScopeId,
				String(scopeEpoch),
				projectId ?? "",
				accessPhase,
				pushedRevision,
			].join(" "),
		[runtimeScopeId, scopeEpoch, projectId, accessPhase, pushedRevision],
	);

	const { state, reload } = useReloadableResource<
		ProjectDataRead<ProjectDataManifest>
	>({
		prepare: () => {
			if (projectId === undefined || accessPhase !== "authorized") {
				return { notReady: { kind: "idle" } };
			}
			const id = projectId;
			return {
				fetch: async (): Promise<ProjectDataRead<ProjectDataManifest>> => {
					const result = await getLookupManifestAction(id);
					if (!result.success) return { kind: "failed", failure: result };
					return {
						kind: "data",
						value: { projectId: id, tables: result.value.tables },
					};
				},
			};
		},
		loading: { kind: "loading" },
		toError: () => ({ kind: "failed", failure: transportFailure() }),
		keepStale: (prev) => prev.kind === "data",
		reloadToken,
	});

	return { state, reload };
}

/**
 * One table's complete snapshot — definition, ordered columns, ordered rows,
 * and the optimistic revisions every write against it carries.
 *
 * Keyed on the table's own `tableRevision` from the live manifest, so a
 * co-member's row edit refetches this table and nothing else. A table that
 * has left the manifest keeps its last known revision in the key; the fetch
 * then resolves `not_found`, which is the workspace's "this table is gone"
 * state rather than a silent empty grid.
 */
export function useProjectDataTable(tableId: LookupTableId | undefined): {
	readonly state: ProjectDataRead<LookupTableSnapshot>;
	readonly reload: () => Promise<void>;
} {
	const projectId = useProjectId();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const runtimeScopeId = useRuntimeScopeId();
	const pushed = usePushedManifest();
	const pushedTableRevision =
		pushed !== null && pushed.projectId === projectId
			? (pushed.tables.find((entry) => entry.id === tableId)?.tableRevision ??
				"")
			: "";

	const reloadToken = useMemo(
		() =>
			[
				runtimeScopeId,
				String(scopeEpoch),
				projectId ?? "",
				accessPhase,
				tableId ?? "",
				pushedTableRevision,
			].join(" "),
		[
			runtimeScopeId,
			scopeEpoch,
			projectId,
			accessPhase,
			tableId,
			pushedTableRevision,
		],
	);

	const { state, reload } = useReloadableResource<
		ProjectDataRead<LookupTableSnapshot>
	>({
		prepare: () => {
			if (
				projectId === undefined ||
				tableId === undefined ||
				accessPhase !== "authorized"
			) {
				return { notReady: { kind: "idle" } };
			}
			const id = projectId;
			const table = tableId;
			return {
				fetch: async (): Promise<ProjectDataRead<LookupTableSnapshot>> => {
					const result = await getLookupTableAction(id, table);
					if (!result.success) return { kind: "failed", failure: result };
					return { kind: "data", value: result.value };
				},
			};
		},
		loading: { kind: "loading" },
		toError: () => ({ kind: "failed", failure: transportFailure() }),
		keepStale: (prev) => prev.kind === "data",
		reloadToken,
	});

	return { state, reload };
}
