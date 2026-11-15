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
import { readManagedLookupTableViewAction } from "@/lib/deployment/managedDataActions";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	getLookupDefinitionAction,
	getLookupManifestAction,
	getLookupTableAction,
} from "@/lib/lookup/actions";
import type {
	LookupDefinitionsSnapshot,
	LookupFailure,
	LookupManifest,
	LookupTableManifestEntry,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";
import {
	useAccessPhase,
	useCanDelete,
	useProjectCanEdit,
	useProjectId,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { useProjectDataWorkspace } from "./ProjectDataWorkspaceLazyProvider";
import {
	freshestManifestEntry,
	NO_TABLE_EDITS,
	type TableEditability,
	tableEditability,
} from "./projectDataModel";
import type { ProjectDataRead } from "./projectDataReadIdentity";
import {
	projectDataReadForIdentity,
	type ScopedProjectDataRead,
	scopeProjectDataRead,
} from "./projectDataReadIdentity";

export type { ProjectDataRead } from "./projectDataReadIdentity";

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
	/** The Project generation that the table entries came from. Pairing this
	 * with a rows-free definition read lets pickers distinguish a coherent
	 * deletion from two independently settled, mismatched snapshots. */
	readonly projectRevision: LookupManifest["projectRevision"];
	readonly tables: readonly LookupTableManifestEntry[];
}

/**
 * Every lookup table in the app's Project, newest revision first known to
 * this session. Reloads whenever the Project clock advances.
 */
export function useProjectDataManifest(enabled = true): {
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
	const resourceIdentity = useMemo(
		() =>
			[
				runtimeScopeId,
				String(scopeEpoch),
				projectId ?? "",
				accessPhase,
				enabled ? "enabled" : "disabled",
			].join(" "),
		[runtimeScopeId, scopeEpoch, projectId, accessPhase, enabled],
	);

	const reloadToken = useMemo(
		() => [resourceIdentity, pushedRevision].join(" "),
		[resourceIdentity, pushedRevision],
	);

	const { state: scopedState, reload } = useReloadableResource<
		ScopedProjectDataRead<ProjectDataManifest>
	>({
		prepare: () => {
			if (!enabled || projectId === undefined || accessPhase !== "authorized") {
				return {
					notReady: scopeProjectDataRead(resourceIdentity, { kind: "idle" }),
				};
			}
			const id = projectId;
			const owner = resourceIdentity;
			return {
				fetch: async (): Promise<
					ScopedProjectDataRead<ProjectDataManifest>
				> => {
					const result = await getLookupManifestAction(id);
					if (!result.success) {
						return scopeProjectDataRead(owner, {
							kind: "failed",
							failure: result,
						});
					}
					return scopeProjectDataRead(owner, {
						kind: "data",
						value: {
							projectId: id,
							projectRevision: result.value.projectRevision,
							tables: result.value.tables,
						},
					});
				},
			};
		},
		loading: scopeProjectDataRead(resourceIdentity, { kind: "loading" }),
		toError: () =>
			scopeProjectDataRead(resourceIdentity, {
				kind: "failed",
				failure: transportFailure(),
			}),
		/* Stale-while-revalidate is legal only inside the same tenant. The
		 * resource survives Project navigation, so `kind === data` alone would
		 * paint the previous Project's manifest under the new Project name. */
		keepStale: (prev) =>
			prev.resourceIdentity === resourceIdentity &&
			prev.kind === "data" &&
			prev.value.projectId === projectId,
		reloadToken,
	});
	const state = projectDataReadForIdentity({
		read: scopedState,
		resourceIdentity,
		ready: enabled && projectId !== undefined && accessPhase === "authorized",
	});

	return { state, reload };
}

/**
 * One table's complete snapshot: definition, ordered columns, ordered rows,
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
	const resourceIdentity = useMemo(
		() =>
			[
				runtimeScopeId,
				String(scopeEpoch),
				projectId ?? "",
				accessPhase,
				tableId ?? "",
			].join(" "),
		[runtimeScopeId, scopeEpoch, projectId, accessPhase, tableId],
	);

	const reloadToken = useMemo(
		() => [resourceIdentity, pushedTableRevision].join(" "),
		[resourceIdentity, pushedTableRevision],
	);

	const { state: scopedState, reload } = useReloadableResource<
		ScopedProjectDataRead<LookupTableSnapshot>
	>({
		prepare: () => {
			if (
				projectId === undefined ||
				tableId === undefined ||
				accessPhase !== "authorized"
			) {
				return {
					notReady: scopeProjectDataRead(resourceIdentity, { kind: "idle" }),
				};
			}
			const id = projectId;
			const table = tableId;
			const owner = resourceIdentity;
			return {
				fetch: async (): Promise<
					ScopedProjectDataRead<LookupTableSnapshot>
				> => {
					const result = await getLookupTableAction(id, table);
					return scopeProjectDataRead(
						owner,
						result.success
							? { kind: "data", value: result.value }
							: { kind: "failed", failure: result },
					);
				},
			};
		},
		loading: scopeProjectDataRead(resourceIdentity, { kind: "loading" }),
		toError: () =>
			scopeProjectDataRead(resourceIdentity, {
				kind: "failed",
				failure: transportFailure(),
			}),
		/* Both axes are identity fences. Keeping another table (or another
		 * Project's table) for even one loading frame is a cross-context data
		 * disclosure, not useful stale state. */
		keepStale: (prev) =>
			prev.resourceIdentity === resourceIdentity &&
			prev.kind === "data" &&
			prev.value.projectId === projectId &&
			prev.value.id === tableId,
		reloadToken,
	});
	const state = projectDataReadForIdentity({
		read: scopedState,
		resourceIdentity,
		ready:
			projectId !== undefined &&
			tableId !== undefined &&
			accessPhase === "authorized",
	});

	return { state, reload };
}

/**
 * One table definition, explicitly without rows.
 *
 * Field option pickers need names and columns, not the table body. Keeping
 * this projection separate prevents a field inspector from downloading a
 * 5,000-row table merely to populate two column selects.
 */
export function useProjectDataDefinition(tableId: LookupTableId | undefined): {
	readonly state: ProjectDataRead<LookupDefinitionsSnapshot>;
	readonly reload: () => Promise<void>;
} {
	const projectId = useProjectId();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const runtimeScopeId = useRuntimeScopeId();
	const pushed = usePushedManifest();
	const pushedDefinitionRevision =
		pushed !== null && pushed.projectId === projectId
			? (pushed.tables.find((entry) => entry.id === tableId)
					?.definitionRevision ?? "")
			: "";
	const pushedProjectRevision =
		pushed !== null && pushed.projectId === projectId
			? pushed.projectRevision
			: "";
	const resourceIdentity = useMemo(
		() =>
			[
				runtimeScopeId,
				String(scopeEpoch),
				projectId ?? "",
				accessPhase,
				tableId ?? "",
			].join(" "),
		[runtimeScopeId, scopeEpoch, projectId, accessPhase, tableId],
	);

	const reloadToken = useMemo(
		() =>
			[resourceIdentity, pushedProjectRevision, pushedDefinitionRevision].join(
				" ",
			),
		[resourceIdentity, pushedProjectRevision, pushedDefinitionRevision],
	);

	const { state: scopedState, reload } = useReloadableResource<
		ScopedProjectDataRead<LookupDefinitionsSnapshot>
	>({
		prepare: () => {
			if (
				projectId === undefined ||
				tableId === undefined ||
				accessPhase !== "authorized"
			) {
				return {
					notReady: scopeProjectDataRead(resourceIdentity, { kind: "idle" }),
				};
			}
			const id = projectId;
			const focusedId = tableId;
			const owner = resourceIdentity;
			return {
				fetch: async (): Promise<
					ScopedProjectDataRead<LookupDefinitionsSnapshot>
				> => {
					const result = await getLookupDefinitionAction(id, focusedId);
					return scopeProjectDataRead(
						owner,
						result.success
							? { kind: "data", value: result.value }
							: { kind: "failed", failure: result },
					);
				},
			};
		},
		loading: scopeProjectDataRead(resourceIdentity, { kind: "loading" }),
		toError: () =>
			scopeProjectDataRead(resourceIdentity, {
				kind: "failed",
				failure: transportFailure(),
			}),
		keepStale: (prev) =>
			prev.resourceIdentity === resourceIdentity &&
			prev.kind === "data" &&
			prev.value.projectId === projectId &&
			prev.value.definitions.length === 1 &&
			prev.value.definitions[0]?.id === tableId,
		reloadToken,
	});
	const state = projectDataReadForIdentity({
		read: scopedState,
		resourceIdentity,
		ready:
			projectId !== undefined &&
			tableId !== undefined &&
			accessPhase === "authorized",
	});

	return { state, reload };
}

/**
 * The table's entry in the freshest manifest this tab holds: the one the
 * stream pushed, which every open builder receives, or the one the workspace
 * read. Who manages a table is read from here and never from the table's
 * snapshot, so a change of it shows the moment a frame lands; the snapshot
 * is refetched for the same change, since it stamps the table's definition.
 */
export function useManifestEntry(
	tableId: LookupTableId | undefined,
): LookupTableManifestEntry | undefined {
	const projectId = useProjectId();
	const pushed = usePushedManifest();
	const workspace = useProjectDataWorkspace();
	const read =
		workspace?.manifest.kind === "data" ? workspace.manifest.value : null;
	return useMemo(
		() => freshestManifestEntry([pushed, read], projectId, tableId),
		[pushed, read, projectId, tableId],
	);
}

/**
 * What this viewer may do with the table: their Project's `edit` and
 * `delete`, and-ed with the table not being a copy CommCare HQ manages.
 * Nothing is offered until the table's manifest entry is known, or once it
 * has left the manifest.
 */
export function useTableIsEditable(
	tableId: LookupTableId | undefined,
): TableEditability {
	const entry = useManifestEntry(tableId);
	const canEdit = useProjectCanEdit();
	const canDelete = useCanDelete();
	return useMemo(
		() =>
			entry === undefined
				? NO_TABLE_EDITS
				: tableEditability(entry, canEdit, canDelete),
		[entry, canEdit, canDelete],
	);
}

/** What the table page shows of a table that came from CommCare HQ. */
export type ManagedTableView = NonNullable<
	Awaited<ReturnType<typeof readManagedLookupTableViewAction>>
>;

export type ManagedTableViewRead =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "data"; readonly value: ManagedTableView }
	| { readonly kind: "failed" };

type ScopedManagedTableViewRead = ManagedTableViewRead & {
	readonly resourceIdentity: string;
};

/**
 * The view of a table that came from CommCare HQ: where it lives, whether
 * this viewer is connected there, and the apps that read it and each of its
 * gone columns. Read again whenever the table's revision or who manages it
 * moves, so the apps a confirmation names are the ones that read it now.
 * Idle for a table that did not come from CommCare HQ.
 */
export function useManagedLookupTableView(
	table:
		| Pick<LookupTableSnapshot, "id" | "projectId" | "tableRevision" | "hq">
		| undefined,
	enabled = true,
): {
	readonly state: ManagedTableViewRead;
	readonly reload: () => Promise<void>;
} {
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const runtimeScopeId = useRuntimeScopeId();
	const fromHq = enabled && table?.hq !== undefined;
	const resourceIdentity = [
		runtimeScopeId,
		String(scopeEpoch),
		table?.projectId ?? "",
		accessPhase,
		table?.id ?? "",
		fromHq ? "from-hq" : "plain",
	].join(" ");
	const reloadToken = [
		resourceIdentity,
		table?.tableRevision ?? "",
		table?.hq?.managedBy ?? "",
	].join(" ");
	const ready = fromHq && accessPhase === "authorized";
	const { state, reload } = useReloadableResource<ScopedManagedTableViewRead>({
		prepare: () => {
			if (!ready || table === undefined) {
				return { notReady: { kind: "idle", resourceIdentity } };
			}
			const { projectId, id } = table;
			const owner = resourceIdentity;
			return {
				fetch: async (): Promise<ScopedManagedTableViewRead> => {
					const view = await readManagedLookupTableViewAction(projectId, id);
					return view === null
						? { kind: "failed", resourceIdentity: owner }
						: { kind: "data", value: view, resourceIdentity: owner };
				},
			};
		},
		loading: { kind: "loading", resourceIdentity },
		toError: () => ({ kind: "failed", resourceIdentity }),
		keepStale: (prev) =>
			prev.resourceIdentity === resourceIdentity && prev.kind === "data",
		reloadToken,
	});
	const shown: ManagedTableViewRead =
		state.resourceIdentity === resourceIdentity
			? state
			: ready
				? { kind: "loading" }
				: { kind: "idle" };
	return { state: shown, reload };
}
