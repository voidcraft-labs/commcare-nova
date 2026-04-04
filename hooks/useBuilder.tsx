/**
 * useBuilder — context-based access to the Builder state machine.
 *
 * The Builder instance is created and owned by BuilderProvider, which scopes
 * its lifecycle to the /build/{id} page. When buildId changes, a fresh Builder
 * is created. When the page unmounts, the Builder is garbage collected. No
 * singleton, no stale state, no manual reset.
 *
 * BuilderProvider also handles project loading from Firestore — it's the
 * single owner of the buildId → Builder → project data lifecycle.
 */
"use client";

import { useRouter } from "next/navigation";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { useAuth } from "@/hooks/useAuth";
import { Builder, BuilderPhase } from "@/lib/services/builder";
import { showToast } from "@/lib/services/toastStore";

/** React context carrying the current Builder instance. Null outside the build page. */
const BuilderContext = createContext<Builder | null>(null);

/**
 * BuilderProvider — owns the Builder lifecycle for a specific buildId.
 *
 * Creates a fresh Builder when buildId changes using the React "adjusting state
 * during rendering" pattern (synchronous, no stale frame). Handles project
 * loading from Firestore for existing projects. Provides the Builder via
 * context to all descendant components.
 *
 * Lifecycle:
 * - `/builds` → `/build/{id}`: provider mounts, fresh Builder, loads project
 * - `/build/A` → `/build/B`: buildId changes, fresh Builder, loads B
 * - `/build/*` → `/builds`: provider unmounts, Builder is garbage collected
 * - `/build/new` generation: buildId stays 'new' (replaceState), no reset
 */
export function BuilderProvider({
	buildId,
	children,
}: {
	buildId: string;
	children: ReactNode;
}) {
	const router = useRouter();
	const { isAuthenticated } = useAuth();

	/* Track which buildId the current builder was created for. When buildId
	 * changes (same-route navigation, e.g. /build/A → /build/B), create a
	 * fresh builder synchronously during render — no stale frame, no effect
	 * delay. This is the React-recommended "adjusting state during rendering"
	 * pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders). */
	const [state, setState] = useState(() => ({
		builder: new Builder(),
		buildId,
	}));

	if (buildId !== state.buildId) {
		setState({ builder: new Builder(), buildId });
	}

	const { builder } = state;
	const isExistingProject = buildId !== "new" && isAuthenticated;

	/* Transition to Loading phase before first paint so the layout renders
	 * the loading spinner immediately (not the centered chat). */
	useLayoutEffect(() => {
		if (isExistingProject && builder.phase === BuilderPhase.Idle) {
			builder.startLoading();
		}
	}, [isExistingProject, builder]);

	/* Fetch the project from Firestore for existing projects. Hydrates the
	 * builder to Ready phase with the saved blueprint via loadProject() —
	 * a single atomic transition with no transient states. */
	useEffect(() => {
		if (!isExistingProject || !isAuthenticated) return;
		if (builder.phase !== BuilderPhase.Loading) return;
		let cancelled = false;

		fetch(`/api/projects/${buildId}`)
			.then((res) => {
				if (!res.ok)
					throw new Error(res.status === 404 ? "not-found" : "load-failed");
				return res.json();
			})
			.then((data) => {
				if (cancelled) return;
				/* Non-complete projects (error, stale generating) can't be hydrated —
				 * redirect to the project list with an explanatory toast. */
				if (data.status !== "complete") {
					showToast(
						"error",
						"Project unavailable",
						"This project didn't finish generating.",
					);
					router.replace("/builds");
					return;
				}
				if (data.blueprint) {
					builder.loadProject(buildId, data.blueprint);
				}
			})
			.catch((err) => {
				if (cancelled) return;
				if (err.message === "not-found") {
					showToast(
						"error",
						"Project not found",
						"This project may have been deleted.",
					);
				} else {
					showToast("error", "Failed to load project");
				}
				router.replace("/builds");
			});

		return () => {
			cancelled = true;
		};
	}, [buildId, isExistingProject, isAuthenticated, builder, router]);

	return <BuilderContext value={builder}>{children}</BuilderContext>;
}

/**
 * useBuilder — access the current Builder from context with reactive subscription.
 *
 * Must be called within a BuilderProvider (i.e. under the /build/* route).
 * Subscribes to the Builder's state via useSyncExternalStore for
 * React-managed re-renders on any state change.
 */
export function useBuilder(): Builder {
	const builder = useContext(BuilderContext);
	if (!builder) {
		throw new Error("useBuilder must be used within a BuilderProvider");
	}
	useSyncExternalStore(
		builder.subscribe,
		builder.getSnapshot,
		builder.getSnapshot,
	);
	return builder;
}

/**
 * useBuilderInstance — access the Builder instance without subscribing to state.
 *
 * Use when a component only needs imperative methods (e.g. `setEditGuard`,
 * `clearEditGuard`) and does NOT need to re-render when builder state changes.
 * Avoids `useSyncExternalStore` overhead for components that don't read
 * reactive builder properties.
 */
export function useBuilderInstance(): Builder {
	const builder = useContext(BuilderContext);
	if (!builder) {
		throw new Error("useBuilderInstance must be used within a BuilderProvider");
	}
	return builder;
}
