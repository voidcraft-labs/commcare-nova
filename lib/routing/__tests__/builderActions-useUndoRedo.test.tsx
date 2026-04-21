// @vitest-environment happy-dom

/**
 * Positive-path coverage for `useUndoRedo` — verifies the hook actually
 * invokes the doc store's temporal undo/redo and that the scroll/flash
 * affordance is triggered or skipped based on the current location and
 * DOM state.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ScrollRegistryProvider,
	useRegisterScrollCallback,
} from "@/components/builder/contexts/ScrollRegistryContext";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";

/* Mock the client path hook — segments control the current location. */
const mockSegments = { current: [] as string[] };
vi.mock("@/lib/routing/useClientPath", () => ({
	useBuilderPathSegments: () => mockSegments.current,
	notifyPathChange: vi.fn(),
}));

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		usePathname: () => "/build/a",
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
	};
});

const findFieldElement = vi.fn<
	(uuid: string, fieldId?: string) => HTMLElement | null
>(() => null);
const scrollToField = vi.fn();
const flashUndoHighlight = vi.fn();
const setFocusHint = vi.fn();
const activeFieldIdRef = { current: undefined as string | undefined };

vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => () => true,
}));

vi.mock("@/lib/routing/domQueries", () => ({
	findFieldElement: (uuid: string, fieldId?: string) =>
		findFieldElement(uuid, fieldId),
	flashUndoHighlight: (el: HTMLElement) => flashUndoHighlight(el),
}));

vi.mock("@/lib/session/hooks", () => ({
	useActiveFieldId: () => activeFieldIdRef.current,
	useSetFocusHint: () => setFocusHint,
}));

import { useUndoRedo } from "@/lib/routing/builderActions";

function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			appId: "test-app",
			appName: "T",
			modules: [
				{
					uuid: "module-1-uuid",
					name: "M",
					forms: [
						{
							uuid: "form-1-uuid",
							name: "F",
							type: "survey",
							fields: [
								f({
									uuid: "q-a-0000-0000-0000-000000000000",
									kind: "text",
									id: "a",
									label: "A",
								}),
								f({
									uuid: "q-b-0000-0000-0000-000000000000",
									kind: "text",
									id: "b",
									label: "B",
								}),
							],
						},
					],
				},
			],
		}),
	);
	store.temporal.getState().resume();
	return store;
}

function ScrollCallbackInstaller({ children }: { children: ReactNode }) {
	useRegisterScrollCallback(scrollToField);
	return <>{children}</>;
}

function wrap(store: ReturnType<typeof makeStore>) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<ScrollRegistryProvider>
				<ScrollCallbackInstaller>
					<BlueprintDocContext.Provider value={store}>
						{children}
					</BlueprintDocContext.Provider>
				</ScrollCallbackInstaller>
			</ScrollRegistryProvider>
		);
	};
}

describe("useUndoRedo", () => {
	beforeEach(() => {
		findFieldElement.mockReset();
		findFieldElement.mockImplementation(() => null);
		scrollToField.mockReset();
		flashUndoHighlight.mockReset();
		setFocusHint.mockReset();
		activeFieldIdRef.current = undefined;
		mockSegments.current = [];
	});

	it("undo no-ops when pastStates is empty (fresh load)", () => {
		const store = makeStore();
		store.temporal.getState().clear();

		const countBefore = Object.keys(store.getState().fields).length;
		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		act(() => result.current.undo());

		expect(Object.keys(store.getState().fields).length).toBe(countBefore);
	});

	it("redo no-ops when futureStates is empty", () => {
		const store = makeStore();
		store.temporal.getState().clear();

		const countBefore = Object.keys(store.getState().fields).length;
		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		act(() => result.current.redo());

		expect(Object.keys(store.getState().fields).length).toBe(countBefore);
	});

	it("undo reverses the last mutation; redo reapplies it", () => {
		const store = makeStore();

		const qaUuid = asUuid("q-a-0000-0000-0000-000000000000");
		act(() => {
			store.getState().applyMany([{ kind: "removeField", uuid: qaUuid }]);
		});
		expect(store.getState().fields[qaUuid]).toBeUndefined();
		expect(store.temporal.getState().pastStates.length).toBeGreaterThan(0);

		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		act(() => result.current.undo());
		expect(store.getState().fields[qaUuid]).toBeDefined();

		act(() => result.current.redo());
		expect(store.getState().fields[qaUuid]).toBeUndefined();
	});

	it("skips scroll/flash when not on a form location", () => {
		const store = makeStore();
		act(() => {
			store.getState().applyMany([
				{
					kind: "removeField",
					uuid: asUuid("q-a-0000-0000-0000-000000000000"),
				},
			]);
		});

		/* URL segments empty → home location. */
		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});
		act(() => result.current.undo());

		expect(scrollToField).not.toHaveBeenCalled();
		expect(flashUndoHighlight).not.toHaveBeenCalled();
		expect(setFocusHint).not.toHaveBeenCalled();
	});

	it("skips scroll/flash gracefully when the DOM has no matching element", () => {
		const store = makeStore();
		act(() => {
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: asUuid("q-a-0000-0000-0000-000000000000"),
					/* Cast needed: patch type is Partial<Omit<Field, "uuid">>
					 * which is a discriminated union variant — label is shared
					 * across all members via FieldBase but TS can't prove it. */
					patch: { label: "Renamed" } as never,
				},
			]);
		});

		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockSegments.current = [formUuid, "q-a-0000-0000-0000-000000000000"];

		const qsSpy = vi.spyOn(document, "querySelector").mockReturnValue(null);
		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		expect(() => {
			act(() => result.current.undo());
		}).not.toThrow();

		expect(scrollToField).not.toHaveBeenCalled();
		expect(flashUndoHighlight).not.toHaveBeenCalled();

		qsSpy.mockRestore();
	});

	it("scrolls and flashes when the selection has a live DOM target", () => {
		const store = makeStore();
		act(() => {
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: asUuid("q-a-0000-0000-0000-000000000000"),
					/* Cast needed: patch type is Partial<Omit<Field, "uuid">>
					 * which is a discriminated union variant — label is shared
					 * across all members via FieldBase but TS can't prove it. */
					patch: { label: "Renamed" } as never,
				},
			]);
		});

		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockSegments.current = [formUuid, "q-a-0000-0000-0000-000000000000"];

		const fakeEl = document.createElement("div") as HTMLElement;
		findFieldElement.mockReturnValue(fakeEl);

		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});
		act(() => result.current.undo());

		expect(findFieldElement).toHaveBeenCalledWith(
			"q-a-0000-0000-0000-000000000000",
			undefined,
		);
		expect(scrollToField).toHaveBeenCalledWith(
			"q-a-0000-0000-0000-000000000000",
			fakeEl,
			"instant",
			undefined,
		);
		expect(flashUndoHighlight).toHaveBeenCalledWith(fakeEl);
		expect(setFocusHint).not.toHaveBeenCalled();
	});

	it("sets focus hint when activeFieldId is present", () => {
		const store = makeStore();
		act(() => {
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: asUuid("q-a-0000-0000-0000-000000000000"),
					/* Cast needed: patch type is Partial<Omit<Field, "uuid">>
					 * which is a discriminated union variant — label is shared
					 * across all members via FieldBase but TS can't prove it. */
					patch: { label: "Renamed" } as never,
				},
			]);
		});

		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockSegments.current = [formUuid, "q-a-0000-0000-0000-000000000000"];

		activeFieldIdRef.current = "label";
		const fakeEl = document.createElement("div") as HTMLElement;
		findFieldElement.mockReturnValue(fakeEl);

		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});
		act(() => result.current.undo());

		expect(setFocusHint).toHaveBeenCalledWith("label");
	});
});
