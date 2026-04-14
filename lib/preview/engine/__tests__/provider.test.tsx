// @vitest-environment happy-dom

/**
 * BuilderFormEngineProvider tests — verifies the provider creates a
 * stable EngineController instance and installs/clears the doc store
 * reference across mount/unmount cycles.
 *
 * We wrap the provider in a `BlueprintDocContext.Provider` so the effect
 * inside `BuilderFormEngineProvider` can read the doc store — mirroring
 * the real provider stack in `hooks/useBuilder.tsx`.
 */

import { render, renderHook } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { describe, expect, it } from "vitest";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { EngineController } from "../engineController";
import { BuilderFormEngineProvider, useBuilderFormEngine } from "../provider";

/** Minimal blueprint with a single form — enough for the controller's
 *  doc-store reference to be non-trivially installable. */
const BP: AppBlueprint = {
	app_name: "Test",
	case_types: null,
	modules: [
		{
			uuid: "module-1-uuid",
			name: "M",
			forms: [
				{
					uuid: "form-1-uuid",
					name: "F",
					type: "survey",
					questions: [
						{
							uuid: "11111111-1111-1111-1111-111111111111",
							id: "q1",
							type: "text",
							label: "Q1",
						},
					],
				},
			],
		},
	],
};

function makeWrapper() {
	const docStore = createBlueprintDocStore();
	docStore.getState().load(BP, "test-app");
	docStore.temporal.getState().resume();

	const Wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext value={docStore}>
			<BuilderFormEngineProvider>{children}</BuilderFormEngineProvider>
		</BlueprintDocContext>
	);
	return { docStore, Wrapper };
}

describe("BuilderFormEngineProvider", () => {
	it("returns an EngineController from useBuilderFormEngine", () => {
		const { Wrapper } = makeWrapper();
		const { result } = renderHook(() => useBuilderFormEngine(), {
			wrapper: Wrapper,
		});
		expect(result.current).toBeInstanceOf(EngineController);
	});

	it("returns a stable controller instance across renders", () => {
		const { Wrapper } = makeWrapper();
		const { result, rerender } = renderHook(() => useBuilderFormEngine(), {
			wrapper: Wrapper,
		});
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
	});

	it("installs the doc store so activateForm can resolve entities", () => {
		const { Wrapper } = makeWrapper();
		const { result } = renderHook(() => useBuilderFormEngine(), {
			wrapper: Wrapper,
		});
		/* activateForm short-circuits when the doc store isn't installed, so
		 * reaching any non-empty runtime state proves the effect ran. */
		result.current.activateForm(0, 0);
		const runtime = result.current.store.getState();
		expect(Object.keys(runtime).length).toBeGreaterThan(0);
	});

	it("throws when useBuilderFormEngine is called outside the provider", () => {
		expect(() => renderHook(() => useBuilderFormEngine())).toThrow(
			/useBuilderFormEngine must be used within a BuilderFormEngineProvider/,
		);
	});

	/* Regression for the BL-1 race fixed in lib/preview/engine/provider.tsx:
	 *
	 * React effect ordering is child-before-parent on mount. Prior to the
	 * fix, the provider installed the doc store inside its own useEffect.
	 * A descendant calling `controller.activateForm(...)` from its own
	 * mount effect would therefore fire FIRST — see `docStore === null`
	 * — and silently no-op, leaving the form preview without per-question
	 * runtime state. Direct deep-link loads of `/build/[id]?s=f&...` are
	 * the canonical user trigger.
	 *
	 * The harness here mirrors how `useFormEngine` calls `activateForm`
	 * inside an effect on mount. After the first effect pass the
	 * controller's runtime store MUST be populated — that proves
	 * `activateForm` ran with a non-null doc store, i.e. the synchronous
	 * binding in `useState` worked. */
	it("doc store is bound before child effects run on first mount", () => {
		const docStore = createBlueprintDocStore();
		docStore.getState().load(BP, "test-app");
		docStore.temporal.getState().resume();

		let captured: EngineController | null = null;

		function TestHarness() {
			const controller = useBuilderFormEngine();
			useEffect(() => {
				/* Capture the controller once we know its activate ran with the
				 * doc store available; assertions then read from this ref. */
				controller.activateForm(0, 0);
				captured = controller;
			}, [controller]);
			return null;
		}

		render(
			<BlueprintDocContext value={docStore}>
				<BuilderFormEngineProvider>
					<TestHarness />
				</BuilderFormEngineProvider>
			</BlueprintDocContext>,
		);

		expect(captured).not.toBeNull();
		const runtime = (captured as unknown as EngineController).store.getState();
		expect(Object.keys(runtime).length).toBeGreaterThan(0);
	});
});
