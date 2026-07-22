// @vitest-environment happy-dom

/**
 * BuilderProvider lifecycle — regression tests for hydrator handoff.
 *
 * The session store is seeded with `loading: true` whenever an initial
 * blueprint is passed to the provider, so the very first render shows the
 * Loading skeleton instead of flashing an empty Idle state. `LoadAppHydrator`
 * must clear that flag when hydration completes; a fresh build (no seeded
 * data) starts at `loading: false` so `derivePhase` returns Idle. These tests
 * mount the full provider in each mode and assert the flag transitions.
 */

import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { useCanEdit, useIsLoading } from "@/lib/session/hooks";

/* Mock `useAuth` (the presence layer reads it for the display name) so mounting
 * the builder tree doesn't subscribe Better Auth's client session atom — its
 * nanostores `onMount` schedules a `setTimeout(0) → fetchSession()` real fetch
 * that the async-leak detector pins (a Timeout + a Promise). A static
 * unauthenticated result is enough for these hydrator-lifecycle tests (with no
 * resolved name, `presenceCanBeat` gates the heartbeat off — the leak-free path). */
vi.mock("@/lib/auth/hooks/useAuth", () => ({
	useAuth: () => ({
		user: null,
		isAuthenticated: false,
		isAdmin: false,
		isImpersonating: false,
		isPending: false,
		error: null,
		signIn: () => {},
		signOut: () => {},
	}),
}));

/* happy-dom DEFINES `EventSource` (jsdom does not), so `ReconcilerProvider`'s
 * `typeof EventSource === "undefined"` guard would otherwise let it open a REAL
 * stream to `/api/apps/{id}/stream` against no server — happy-dom's EventSource
 * leaves the connection attempt pending even after `.close()`, which the
 * async-leak detector pins here (and hangs the pool). Stubbing it undefined puts
 * the provider on its documented NON-BROWSER path (mount the reconciler state
 * machine, no live stream) — exactly what these hydrator-lifecycle tests want, and
 * `renderHook`'s unmount `cleanup()` tears the rest down. */
beforeAll(() => {
	vi.stubGlobal("EventSource", undefined);
});
afterAll(() => {
	vi.unstubAllGlobals();
});
afterEach(() => {
	cleanup();
});

/**
 * Minimal valid normalized doc for LoadAppHydrator tests.
 *
 * Zero modules is a legal shape — the doc store hydrates without entity
 * mutations, making this fixture useful for lifecycle (loading-flag)
 * regression tests that don't need real blueprint content.
 */
const EMPTY_DOC: BlueprintDoc = {
	appId: "test-app-id",
	appName: "Test App",
	connectType: null,
	/* `caseTypes: null` is the canonical survey-only shape. */
	caseTypes: null,
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
	fieldParent: {},
};

describe("BuilderProvider — existing-app hydration", () => {
	it("clears the loading flag after LoadAppHydrator runs", () => {
		function wrapper({ children }: { children: ReactNode }) {
			return (
				<BuilderProvider buildId="test-app-id" initialDoc={EMPTY_DOC}>
					{children}
				</BuilderProvider>
			);
		}

		const { result } = renderHook(
			() => ({ loading: useIsLoading(), canEdit: useCanEdit() }),
			{ wrapper },
		);

		expect(result.current).toEqual({ loading: false, canEdit: false });
	});
});

describe("BuilderProvider — fresh build", () => {
	it("starts with loading=false when no blueprint is provided", () => {
		/* The Idle path — `buildId="new"` with no seeded data. The session
		 * store's initializer leaves `loading` at its default of false, so
		 * `derivePhase` returns `Idle` on first render (landing chat UI,
		 * no skeleton). This test guards against a future change that
		 * accidentally inverts the init default. */
		function wrapper({ children }: { children: ReactNode }) {
			return <BuilderProvider buildId="new">{children}</BuilderProvider>;
		}

		const { result } = renderHook(
			() => ({ loading: useIsLoading(), canEdit: useCanEdit() }),
			{ wrapper },
		);

		expect(result.current).toEqual({ loading: false, canEdit: false });
	});

	it("seeds a dormant new build with the active Project's viewer capability", () => {
		function wrapper({ children }: { children: ReactNode }) {
			return (
				<BuilderProvider
					buildId="new"
					initialAccess={{
						projectId: "shared-project",
						role: "viewer",
						canEdit: false,
						baseSeq: 0,
					}}
				>
					{children}
				</BuilderProvider>
			);
		}

		const { result } = renderHook(
			() => ({ loading: useIsLoading(), canEdit: useCanEdit() }),
			{ wrapper },
		);

		expect(result.current).toEqual({ loading: false, canEdit: false });
	});
});
