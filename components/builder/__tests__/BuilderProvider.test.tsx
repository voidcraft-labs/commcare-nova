// @vitest-environment happy-dom

/**
 * BuilderProvider lifecycle — regression tests for hydrator handoff.
 *
 * The session store is seeded with `loading: true` whenever an initial
 * blueprint or replay script is passed to the provider, so the very first
 * render shows the Loading skeleton instead of flashing an empty Idle
 * state. Whichever hydrator runs must clear that flag when hydration
 * completes — `LoadAppHydrator` for existing-app loads, `ReplayHydrator`
 * for replay mode.
 *
 * Replay had a regression where `ReplayHydrator` dispatched stream events
 * but never called `setLoading(false)`, stranding the builder in
 * `BuilderPhase.Loading` forever (user-visible as the pulsing Logo
 * skeleton on `/build/replay/{id}`). These tests mount the full provider
 * with each hydration mode and assert the flag transitions.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { Event } from "@/lib/log/types";
import { useInReplayMode, useIsLoading } from "@/lib/session/hooks";
import type { ReplayChapter } from "@/lib/session/types";

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

/** Empty replay fixtures — no events and no chapters. `initialCursor: 0`
 *  is the legal empty-replay position (the store clamps to `[0, events.length-1]`,
 *  collapsing to 0 when `events` is empty). With zero events, the replay
 *  dispatcher walks nothing, isolating the test to the loading-flag
 *  transition rather than doc-store mutation side effects. */
const EMPTY_REPLAY_EVENTS: Event[] = [];
const EMPTY_REPLAY_CHAPTERS: ReplayChapter[] = [];

describe("BuilderProvider — replay hydration", () => {
	it("clears the loading flag after ReplayHydrator runs", () => {
		/* Wrap the observation hook in a full BuilderProvider seeded with a
		 * replay prop. `renderHook` flushes mount effects before returning,
		 * so by the time we read `result.current`, the hydrator's useEffect
		 * has already finalized the lifecycle. */
		function wrapper({ children }: { children: ReactNode }) {
			return (
				<BuilderProvider
					buildId="replay"
					replay={{
						events: EMPTY_REPLAY_EVENTS,
						chapters: EMPTY_REPLAY_CHAPTERS,
						initialCursor: 0,
						exitPath: "/admin",
					}}
				>
					{children}
				</BuilderProvider>
			);
		}

		const { result } = renderHook(
			() => ({
				loading: useIsLoading(),
				inReplayMode: useInReplayMode(),
			}),
			{ wrapper },
		);

		/* Regression assertion — without the `setLoading(false)` call in
		 * ReplayHydrator, `loading` stays true and `BuilderLayout` renders
		 * its Loading skeleton indefinitely. */
		expect(result.current.loading).toBe(false);
		/* Sanity check — `loadReplay` must also run so downstream consumers
		 * (ReplayController, exit nav) see replay state. */
		expect(result.current.inReplayMode).toBe(true);
	});
});

describe("BuilderProvider — existing-app hydration", () => {
	it("clears the loading flag after LoadAppHydrator runs", () => {
		/* Parallel test for the non-replay path so the two hydrators stay
		 * in lock-step — if one regresses on lifecycle finalization, the
		 * other should catch reviewers' eyes in the same file. */
		function wrapper({ children }: { children: ReactNode }) {
			return (
				<BuilderProvider buildId="test-app-id" initialDoc={EMPTY_DOC}>
					{children}
				</BuilderProvider>
			);
		}

		const { result } = renderHook(
			() => ({
				loading: useIsLoading(),
				inReplayMode: useInReplayMode(),
			}),
			{ wrapper },
		);

		expect(result.current.loading).toBe(false);
		expect(result.current.inReplayMode).toBe(false);
	});
});

describe("BuilderProvider — fresh build", () => {
	it("starts with loading=false when no replay or blueprint is provided", () => {
		/* The Idle path — `buildId="new"` with no seeded data. The session
		 * store's initializer leaves `loading` at its default of false, so
		 * `derivePhase` returns `Idle` on first render (landing chat UI,
		 * no skeleton). This test guards against a future change that
		 * accidentally inverts the init default. */
		function wrapper({ children }: { children: ReactNode }) {
			return <BuilderProvider buildId="new">{children}</BuilderProvider>;
		}

		const { result } = renderHook(() => useIsLoading(), { wrapper });

		expect(result.current).toBe(false);
	});
});
