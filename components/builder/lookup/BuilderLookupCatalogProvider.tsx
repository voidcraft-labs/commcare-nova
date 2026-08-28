"use client";

import {
	type ContextType,
	createContext,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
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

function sameCatalogValue(
	left: BuilderLookupCatalog,
	right: BuilderLookupCatalog,
): boolean {
	if (left === right) return true;
	if (left.kind !== right.kind) return false;
	if (left.kind === "loading" || left.kind === "unmanaged") return true;
	if (left.kind === "error" && right.kind === "error") {
		return left.message === right.message && left.retry === right.retry;
	}
	if (left.kind === "ready" && right.kind === "ready") {
		if (
			left.lookupContext.kind !== "available" ||
			right.lookupContext.kind !== "available"
		) {
			return false;
		}
		// The Project revision is the lookup store's optimistic clock. Equal
		// revisions describe the same complete definition snapshot, even when a
		// manifest arrival causes the server action to return fresh object copies.
		return (
			left.lookupContext.projectId === right.lookupContext.projectId &&
			left.lookupContext.projectRevision ===
				right.lookupContext.projectRevision &&
			left.retry === right.retry
		);
	}
	return false;
}

const BuilderLookupCatalogBoundary = memo(
	function BuilderLookupCatalogBoundary({
		value,
		commitState,
		children,
	}: {
		readonly value: BuilderLookupCatalog;
		readonly commitState: ContextType<typeof LookupCommitContext>;
		readonly children: ReactNode;
	}) {
		return (
			<>
				<span
					hidden
					aria-hidden="true"
					data-builder-resource="lookup-catalog"
					data-state={value.kind}
				/>
				<LookupCommitContext.Provider value={commitState}>
					<BuilderLookupCatalogContext.Provider value={value}>
						{children}
					</BuilderLookupCatalogContext.Provider>
				</LookupCommitContext.Provider>
			</>
		);
	},
);

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

	const calculatedValue = useMemo<BuilderLookupCatalog>(() => {
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
	const stableValueRef = useRef(calculatedValue);
	if (!sameCatalogValue(stableValueRef.current, calculatedValue)) {
		stableValueRef.current = calculatedValue;
	}
	const value = stableValueRef.current;

	const commitState = useMemo(
		() =>
			value.kind === "ready"
				? { kind: "ready" as const, lookupContext: value.lookupContext }
				: value.kind === "unmanaged"
					? { kind: "unmanaged" as const, lookupContext: value.lookupContext }
					: {
							kind: value.kind,
							lookupContext: value.lookupContext,
						},
		[value],
	);
	return (
		<BuilderLookupCatalogBoundary value={value} commitState={commitState}>
			{children}
		</BuilderLookupCatalogBoundary>
	);
}

export function useBuilderLookupCatalog(): BuilderLookupCatalog {
	return useContext(BuilderLookupCatalogContext);
}
