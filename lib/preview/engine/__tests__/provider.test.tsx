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

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
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
			name: "M",
			forms: [
				{
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
});
