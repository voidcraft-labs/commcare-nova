/**
 * useBuilder — context-based access to the Builder state machine.
 *
 * The Builder instance is created and owned by BuilderProvider, which scopes
 * its lifecycle to the /build/{id} page. When buildId changes, a fresh Builder
 * is created. When the page unmounts, the Builder is garbage collected. No
 * singleton, no stale state, no manual reset.
 *
 * BuilderProvider also handles app loading from Firestore — it's the
 * single owner of the buildId → Builder → app data lifecycle.
 */
"use client";

import { useRouter } from "next/navigation";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { Builder, BuilderPhase } from "@/lib/services/builder";
import { showToast } from "@/lib/services/toastStore";

/** React context carrying the current Builder instance. Null outside the build page. */
const BuilderContext = createContext<Builder | null>(null);

/**
 * BuilderProvider — owns the Builder lifecycle for a specific buildId.
 *
 * Creates a fresh Builder when buildId changes using the React "adjusting state
 * during rendering" pattern (synchronous, no stale frame). Handles app
 * loading from Firestore for existing apps. Provides the Builder via
 * context to all descendant components.
 *
 * Lifecycle:
 * - `/` → `/build/{id}`: provider mounts, fresh Builder, loads app
 * - `/build/A` → `/build/B`: buildId changes, fresh Builder, loads B
 * - `/build/*` → `/`: provider unmounts, Builder is garbage collected
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

	const isExistingApp = buildId !== "new";

	/* Track which buildId the current builder was created for. When buildId
	 * changes (same-route navigation, e.g. /build/A → /build/B), create a
	 * fresh builder synchronously during render — no stale frame, no effect
	 * delay. This is the React-recommended "adjusting state during rendering"
	 * pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
	 *
	 * Existing apps start in Loading phase — they never pass through Idle.
	 * New builds start in Idle (centered chat). The initial phase is baked
	 * into the Builder at construction time so the very first render shows
	 * the correct layout with zero intermediate states. */
	const [state, setState] = useState(() => ({
		builder: new Builder(
			isExistingApp ? BuilderPhase.Loading : BuilderPhase.Idle,
		),
		buildId,
	}));

	if (buildId !== state.buildId) {
		setState({
			builder: new Builder(
				isExistingApp ? BuilderPhase.Loading : BuilderPhase.Idle,
			),
			buildId,
		});
	}

	const { builder } = state;

	/* Fetch the app from Firestore for existing apps. Hydrates the
	 * builder to Ready phase with the saved blueprint via loadApp() —
	 * a single atomic transition with no transient states. Auth is
	 * cookie-based — the browser sends it automatically, and the API
	 * returns 401 if invalid (handled by the catch block). */
	useEffect(() => {
		if (!isExistingApp) return;
		if (builder.phase !== BuilderPhase.Loading) return;
		const controller = new AbortController();

		fetch(`/api/apps/${buildId}`, { signal: controller.signal })
			.then((res) => {
				if (!res.ok)
					throw new Error(res.status === 404 ? "not-found" : "load-failed");
				return res.json();
			})
			.then((data) => {
				/* Non-complete apps (error, stale generating) can't be hydrated —
				 * redirect to the app list with an explanatory toast. */
				if (data.status !== "complete") {
					showToast(
						"error",
						"App unavailable",
						"This app didn't finish generating.",
					);
					router.replace("/");
					return;
				}
				if (data.blueprint) {
					builder.loadApp(buildId, data.blueprint);
				}
			})
			.catch((err) => {
				/* Aborted fetches throw — silently ignore them. */
				if (err.name === "AbortError") return;
				if (err.message === "not-found") {
					showToast(
						"error",
						"App not found",
						"This app may have been deleted.",
					);
				} else {
					showToast("error", "Failed to load app");
				}
				router.replace("/");
			});

		return () => {
			controller.abort();
		};
	}, [buildId, isExistingApp, builder, router]);

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
