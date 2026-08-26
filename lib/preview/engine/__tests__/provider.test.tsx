// @vitest-environment happy-dom

/**
 * BuilderFormEngineProvider tests — verifies the provider creates a
 * stable EngineController instance and installs/clears the doc store
 * reference across mount/unmount cycles.
 *
 * We wrap the provider in a `BlueprintDocContext.Provider` so the effect
 * inside `BuilderFormEngineProvider` can read the doc store — mirroring
 * the real provider stack in `components/builder/BuilderProvider.tsx`.
 *
 * Fixtures are built in the normalized doc shape directly. The doc store's
 * `load()` takes a `PersistableDoc`.
 */

import { act, render, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";
import { useFormEngine } from "@/lib/preview/hooks/useFormEngine";
import {
	BuilderSessionContext,
	BuilderSessionProvider,
	type BuilderSessionStoreApi,
} from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { EngineController } from "../engineController";
import { BuilderFormEngineProvider, useBuilderFormEngine } from "../provider";

/* The provider resolves "Preview as me" from `useAuth()`. Mock a warm session so
 * the synchronous controller-initialization contract is observable, and so the
 * test doesn't subscribe Better Auth's client session atom — its nanostores
 * `onMount` schedules a `setTimeout(0) → fetchSession()` real fetch that the
 * async-leak detector pins. */
vi.mock("@/lib/auth/hooks/useAuth", () => ({
	useAuth: () => ({
		user: {
			id: "warm-member",
			name: "Warm Member",
			email: "warm@example.com",
		},
		isAuthenticated: true,
		isAdmin: false,
		isImpersonating: false,
		isPending: false,
		error: null,
		signIn: () => {},
		signOut: () => {},
	}),
}));

/** Single-form doc with one text field — the minimum structure the engine
 *  needs to produce a non-empty runtime state from `activateForm(FORM_UUID)`. */
const MODULE_UUID = testUuid("module-1-uuid");
const FORM_UUID = testUuid("form-1-uuid");
const FIELD_UUID = testUuid("11111111-1111-1111-1111-111111111111");

const DOC: PersistableDoc = {
	appId: "test-app",
	appName: "Test",
	connectType: null,
	caseTypes: null,
	modules: {
		[MODULE_UUID]: {
			uuid: MODULE_UUID,
			id: "module-1",
			name: "M",
		},
	},
	forms: {
		[FORM_UUID]: {
			uuid: FORM_UUID,
			id: "form-1",
			name: "F",
			type: "survey",
		},
	},
	fields: {
		[FIELD_UUID]: {
			uuid: FIELD_UUID,
			id: "q1",
			kind: "text",
			label: proseText("Q1"),
		},
	},
	moduleOrder: [MODULE_UUID],
	formOrder: { [MODULE_UUID]: [FORM_UUID] },
	fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
};

function makeWrapper() {
	const docStore = createBlueprintDocStore();
	docStore.getState().load(DOC);
	docStore.getState().startTracking();

	/* The session provider is in the real stack above this one and the
	 * provider now reads it: the acting identity is "Preview as me" or a
	 * selected persona, and which one is ephemeral session state. */
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<BuilderSessionProvider>
			<BlueprintDocContext value={docStore}>
				<BuilderFormEngineProvider>{children}</BuilderFormEngineProvider>
			</BlueprintDocContext>
		</BuilderSessionProvider>
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
		result.current.activateForm(FORM_UUID);
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
	 * — and silently no-op, leaving the form preview without per-field
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
		docStore.getState().load(DOC);
		docStore.getState().startTracking();

		let captured: EngineController | null = null;

		function TestHarness() {
			const controller = useBuilderFormEngine();
			useEffect(() => {
				/* Capture the controller once we know its activate ran with the
				 * doc store available; assertions then read from this ref. */
				controller.activateForm(FORM_UUID);
				captured = controller;
			}, [controller]);
			return null;
		}

		render(
			<BuilderSessionProvider>
				<BlueprintDocContext value={docStore}>
					<BuilderFormEngineProvider>
						<TestHarness />
					</BuilderFormEngineProvider>
				</BlueprintDocContext>
			</BuilderSessionProvider>,
		);

		expect(captured).not.toBeNull();
		const runtime = (captured as unknown as EngineController).store.getState();
		expect(Object.keys(runtime).length).toBeGreaterThan(0);
	});

	it("re-arms the XPath runtime after Strict Mode effect replay", async () => {
		const docStore = createBlueprintDocStore();
		docStore.getState().load(DOC);
		docStore.getState().startTracking();

		const Wrapper = ({ children }: { children: ReactNode }) => (
			<StrictMode>
				<BuilderSessionProvider>
					<BlueprintDocContext value={docStore}>
						<BuilderFormEngineProvider>{children}</BuilderFormEngineProvider>
					</BlueprintDocContext>
				</BuilderSessionProvider>
			</StrictMode>
		);
		const { result } = renderHook(() => useFormEngine(FORM_UUID), {
			wrapper: Wrapper,
		});

		await waitFor(() => expect(result.current.entryKey).toBeDefined());
		await act(async () => {
			await expect(
				result.current.onValueChangeAsync(FIELD_UUID, "strict replay value"),
			).resolves.toBe(true);
		});
		expect(result.current.store.getState()[FIELD_UUID]?.value).toBe(
			"strict replay value",
		);
		expect(result.current.entryStore.getState().fault).toBeUndefined();
	});

	it("binds a warm preview identity before child effects run", () => {
		const docStore = createBlueprintDocStore();
		docStore.getState().load(DOC);
		docStore.getState().startTracking();
		const setIdentity = vi.spyOn(
			EngineController.prototype,
			"setPreviewIdentity",
		);
		let callsSeenByChild = -1;

		function TestHarness() {
			useBuilderFormEngine();
			useEffect(() => {
				callsSeenByChild = setIdentity.mock.calls.length;
			}, []);
			return null;
		}

		render(
			<BuilderSessionProvider>
				<BlueprintDocContext value={docStore}>
					<BuilderFormEngineProvider>
						<TestHarness />
					</BuilderFormEngineProvider>
				</BlueprintDocContext>
			</BuilderSessionProvider>,
		);

		expect(setIdentity.mock.calls[0]?.[0]).toMatchObject({
			actorUserId: "warm-member",
			ownerId: "warm-member",
		});
		// The initializer call is visible to the child; the provider's follow-up
		// effect runs after the child's effect and may make the second call.
		expect(callsSeenByChild).toBe(1);
		setIdentity.mockRestore();
	});

	it("refuses to activate a form while the selected persona is unavailable", () => {
		const docStore = createBlueprintDocStore();
		docStore.getState().load(DOC);
		docStore.getState().startTracking();
		const sessionStore: BuilderSessionStoreApi = createBuilderSessionStore();
		sessionStore.getState().setPreviewPersonaUuid("removed-persona");
		const Wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={sessionStore}>
				<BlueprintDocContext value={docStore}>
					<BuilderFormEngineProvider>{children}</BuilderFormEngineProvider>
				</BlueprintDocContext>
			</BuilderSessionContext>
		);
		const { result } = renderHook(() => useBuilderFormEngine(), {
			wrapper: Wrapper,
		});

		act(() => result.current.activateForm(FORM_UUID));

		expect(result.current.store.getState()).toEqual({});
	});

	it("preserves one entry through a real same-Project refresh and rotates it only after confirmed boundaries", async () => {
		const docStore = createBlueprintDocStore();
		docStore.getState().load(DOC);
		docStore.getState().startTracking();
		const sessionStore = createBuilderSessionStore({
			appId: DOC.appId,
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const Wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={sessionStore}>
				<BlueprintDocContext value={docStore}>
					<BuilderFormEngineProvider>{children}</BuilderFormEngineProvider>
				</BlueprintDocContext>
			</BuilderSessionContext>
		);
		const { result } = renderHook(() => useFormEngine(FORM_UUID), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.entryKey).toBeDefined());
		await act(async () => {
			await result.current.onValueChangeAsync(FIELD_UUID, "source value");
		});
		const sourceEntryKey = result.current.entryKey;
		expect(sourceEntryKey).toBeDefined();
		expect(result.current.store.getState()[FIELD_UUID]?.value).toBe(
			"source value",
		);

		act(() => {
			sessionStore.getState().beginAccessRefresh();
			sessionStore.getState().resetProjectScope();
		});
		expect(result.current.entryKey).toBe(sourceEntryKey);
		expect(result.current.store.getState()[FIELD_UUID]?.value).toBe(
			"source value",
		);
		act(() => {
			sessionStore.getState().applyAccessSnapshot({
				projectId: "project-source",
				role: "editor",
				canEdit: true,
			});
		});
		expect(result.current.entryKey).toBe(sourceEntryKey);
		expect(result.current.store.getState()[FIELD_UUID]?.value).toBe(
			"source value",
		);

		act(() => {
			sessionStore.getState().beginAccessRefresh();
			sessionStore.getState().resetProjectScope();
			sessionStore.getState().applyAccessSnapshot({
				projectId: "project-destination",
				role: "editor",
				canEdit: true,
			});
		});
		await waitFor(() => {
			expect(result.current.entryKey).toBeDefined();
			expect(result.current.entryKey).not.toBe(sourceEntryKey);
		});
		expect(result.current.store.getState()[FIELD_UUID]?.value).toBe("");

		const projectEntryKey = result.current.entryKey;
		act(() => sessionStore.getState().setAppId("same-project-next-app"));
		await waitFor(() => {
			expect(result.current.entryKey).toBeDefined();
			expect(result.current.entryKey).not.toBe(projectEntryKey);
		});
		expect(result.current.store.getState()[FIELD_UUID]?.value).toBe("");

		act(() => sessionStore.getState().revokeAccess());
		await waitFor(() => expect(result.current.entryKey).toBeUndefined());
		expect(result.current.store.getState()).toEqual({});
	});
});
