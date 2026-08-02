"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { EditorLookupTableDecl } from "@/components/builder/shared/lookupTablePresentation";
import { useReconcilerContext } from "@/lib/collab/context";
import { LookupCommitContext } from "@/lib/doc/lookupCommitContext";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { getAllLookupDefinitionsAction } from "@/lib/lookup/actions";
import type {
	LookupDefinitionsSnapshot,
	LookupManifest,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";
import {
	useAccessPhase,
	useProjectId,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";

export type BuilderLookupCatalog =
	| {
			readonly kind: "unmanaged";
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "loading";
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "error";
			readonly message: string;
			readonly retry: () => Promise<void>;
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "ready";
			readonly definitions: readonly LookupTableDefinition[];
			readonly tables: readonly EditorLookupTableDecl[];
			readonly byId: ReadonlyMap<
				EditorLookupTableDecl["id"],
				EditorLookupTableDecl
			>;
			readonly lookupContext: LookupValidationContext;
			readonly retry: () => Promise<void>;
	  };

type CatalogResource =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| {
			readonly kind: "data";
			readonly snapshot: LookupDefinitionsSnapshot;
	  }
	| { readonly kind: "error"; readonly message: string };

const BuilderLookupCatalogContext = createContext<BuilderLookupCatalog>({
	kind: "unmanaged",
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});

export function BuilderLookupCatalogProvider({
	children,
}: {
	readonly children: ReactNode;
}) {
	const projectId = useProjectId();
	const accessPhase = useAccessPhase();
	const projectScopeEpoch = useProjectScopeEpoch();
	const reconciler = useReconcilerContext();
	const runtimeScopeId = reconciler?.projectScopeId ?? "provider-light";
	const [manifest, setManifest] = useState<LookupManifest | null>(null);
	useEffect(
		() => reconciler?.subscribeLookupManifest(setManifest),
		[reconciler],
	);
	const manifestRevision =
		manifest !== null && manifest.projectId === projectId
			? manifest.projectRevision
			: "";
	const reloadToken = useMemo(
		() =>
			[
				runtimeScopeId,
				String(projectScopeEpoch),
				projectId ?? "",
				accessPhase,
				manifestRevision,
			].join(" "),
		[
			runtimeScopeId,
			projectScopeEpoch,
			projectId,
			accessPhase,
			manifestRevision,
		],
	);
	const resource = useReloadableResource<CatalogResource>({
		prepare: () => {
			if (projectId === undefined || accessPhase !== "authorized") {
				return { notReady: { kind: "idle" } };
			}
			const id = projectId;
			return {
				fetch: async () => {
					const result = await getAllLookupDefinitionsAction(id);
					return result.success
						? ({ kind: "data", snapshot: result.value } as const)
						: ({
								kind: "error",
								message: result.message,
							} as const);
				},
			};
		},
		loading: { kind: "loading" },
		toError: () => ({
			kind: "error",
			message:
				"Nova could not load this Project's data-table definitions. Try again.",
		}),
		keepStale: (previous) =>
			previous.kind === "data" &&
			previous.snapshot.projectId === projectId &&
			manifestRevision === previous.snapshot.projectRevision,
		reloadToken,
	});

	const value = useMemo<BuilderLookupCatalog>(() => {
		if (resource.state.kind === "idle" || resource.state.kind === "loading") {
			return {
				kind: "loading",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			};
		}
		if (resource.state.kind === "error") {
			return {
				kind: "error",
				message: resource.state.message,
				retry: resource.reload,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			};
		}
		const snapshot = resource.state.snapshot;
		const tables: readonly EditorLookupTableDecl[] = snapshot.definitions.map(
			(definition) => ({
				id: definition.id,
				name: definition.name,
				columns: definition.columns,
			}),
		);
		return {
			kind: "ready",
			definitions: snapshot.definitions,
			tables,
			byId: new Map(tables.map((table) => [table.id, table])),
			lookupContext: {
				kind: "available",
				projectId: snapshot.projectId,
				projectRevision: snapshot.projectRevision,
				definitions: snapshot.definitions,
			},
			retry: resource.reload,
		};
	}, [resource.state, resource.reload]);

	const commitState =
		value.kind === "ready"
			? { kind: "ready" as const, lookupContext: value.lookupContext }
			: value.kind === "unmanaged"
				? { kind: "unmanaged" as const, lookupContext: value.lookupContext }
				: {
						kind: value.kind,
						lookupContext: value.lookupContext,
					};
	return (
		<LookupCommitContext.Provider value={commitState}>
			<BuilderLookupCatalogContext.Provider value={value}>
				{children}
			</BuilderLookupCatalogContext.Provider>
		</LookupCommitContext.Provider>
	);
}

export function useBuilderLookupCatalog(): BuilderLookupCatalog {
	return useContext(BuilderLookupCatalogContext);
}
