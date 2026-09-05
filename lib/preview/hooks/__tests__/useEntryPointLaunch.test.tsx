// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Location } from "@/lib/routing/types";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import type {
	EntryPointLaunchResult,
	EntryPointPreviewLaunch,
} from "../../entryPointLaunchTypes";

const { action, push, replace, barrier, snapshot } = vi.hoisted(() => ({
	action: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	barrier: vi.fn(),
	snapshot: vi.fn(),
}));
let location: Location;
vi.mock("../../entryPointLaunchAction", () => ({
	launchEntryPointAction: action,
}));
vi.mock("@/lib/routing/hooks", () => ({
	useLocation: () => location,
	useNavigate: () => ({ push, replace }),
}));
vi.mock("@/lib/collab/context", () => ({
	useReconcilerContext: () => ({
		reconciler: { waitForHumanSaveBarrier: barrier, getSnapshot: snapshot },
	}),
}));

import {
	useEntryPointLaunch,
	useEntryPointLaunchLifecycle,
} from "../useEntryPointLaunch";

const E = testUuid("endpoint"),
	M = testUuid("module"),
	F = testUuid("form");
const launch: EntryPointPreviewLaunch = {
	entryPointUuid: E,
	expectedSeq: 4,
	location: { kind: "form", moduleUuid: M, formUuid: F },
	menuSelections: {},
	formTarget: { formUuid: F, cases: [{ caseId: "exact" }] },
	ignoreDisplayConditions: true,
};
beforeEach(() => {
	vi.resetAllMocks();
	location = launch.location;
	barrier.mockResolvedValue({ kind: "saved" });
	snapshot.mockReturnValue({ baseSeq: 4 });
	action.mockResolvedValue({ kind: "ready", launch });
});
function harness() {
	const doc = createBlueprintDocStore();
	const session = createBuilderSessionStore({
		appId: "app",
		projectId: "project",
		role: "editor",
		canEdit: true,
	});
	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext value={doc}>
				<BuilderSessionContext value={session}>
					{children}
				</BuilderSessionContext>
			</BlueprintDocContext>
		);
	}
	return { doc, session, wrapper: Wrapper };
}
describe("entry point launch lifecycle", () => {
	it("expires the bypass on navigation and preserves the ordinary selected cases", () => {
		const h = harness();
		h.session.getState().installEntryPointLaunch(launch);
		const view = renderHook(() => useEntryPointLaunchLifecycle(), {
			wrapper: h.wrapper,
		});
		expect(h.session.getState().previewEntryPointLaunch).toBe(launch);
		location = { kind: "home" };
		view.rerender();
		expect(h.session.getState().previewEntryPointLaunch).toBeUndefined();
		expect(h.session.getState().previewCaseTarget).toBe(launch.formTarget);
		expect(replace).not.toHaveBeenCalled();
	});
	it("retires all running state on a document edit and returns to setup", () => {
		const h = harness();
		h.session.getState().installEntryPointLaunch(launch);
		renderHook(() => useEntryPointLaunchLifecycle(), { wrapper: h.wrapper });
		act(() => h.doc.setState({ appName: "Edited" }));
		expect(h.session.getState().previewing).toBe(false);
		expect(h.session.getState().previewCaseTarget).toBeUndefined();
		expect(h.session.getState().previewEntryPointLaunch).toBeUndefined();
		expect(replace).toHaveBeenCalledWith({
			kind: "app-setup",
			section: "deep-links",
		});
	});
	it("returns to setup when a persona change would otherwise revive an ordinary first-case fallback", () => {
		const h = harness();
		h.session.getState().installEntryPointLaunch(launch);
		renderHook(() => useEntryPointLaunchLifecycle(), { wrapper: h.wrapper });
		act(() =>
			h.session.getState().setPreviewPersonaUuid(testUuid("other-persona")),
		);
		expect(h.session.getState().previewing).toBe(false);
		expect(h.session.getState().previewCaseTarget).toBeUndefined();
		expect(replace).toHaveBeenCalledWith({
			kind: "app-setup",
			section: "deep-links",
		});
	});
	it("unsubscribes its document listener on unmount", () => {
		const h = harness();
		h.session.getState().installEntryPointLaunch(launch);
		const view = renderHook(() => useEntryPointLaunchLifecycle(), {
			wrapper: h.wrapper,
		});
		view.unmount();
		h.doc.setState({ appName: "Edited after unmount" });
		expect(replace).not.toHaveBeenCalled();
	});
});
describe("entry point launch responses", () => {
	it("installs a successful launch only after the save barrier and server admission", async () => {
		const h = harness();
		const view = renderHook(() => useEntryPointLaunch(), {
			wrapper: h.wrapper,
		});
		await act(async () => {
			expect(await view.result.current(E, [])).toEqual({
				kind: "ready",
				launch,
			});
		});
		expect(action).toHaveBeenCalledWith({
			appId: "app",
			entryPointUuid: E,
			selections: [],
			personaUuid: undefined,
			expectedSeq: 4,
		});
		expect(h.session.getState().previewCaseTarget).toBe(launch.formTarget);
		expect(push).toHaveBeenCalledWith(launch.location);
	});
	for (const boundary of ["document", "persona", "scope"] as const)
		it(`discards a launch response after a ${boundary} change`, async () => {
			const h = harness();
			const view = renderHook(() => useEntryPointLaunch(), {
				wrapper: h.wrapper,
			});
			let resolve!: (result: EntryPointLaunchResult) => void;
			action.mockImplementation(
				() =>
					new Promise<EntryPointLaunchResult>((done) => {
						resolve = done;
					}),
			);
			let pending: Promise<EntryPointLaunchResult> | undefined;
			await act(async () => {
				pending = view.result.current(E, []);
				await Promise.resolve();
			});
			act(() => {
				if (boundary === "document")
					h.doc.setState({ appName: "New revision" });
				else if (boundary === "persona")
					h.session.getState().setPreviewPersonaUuid(testUuid("other-persona"));
				else h.session.getState().beginAccessRefresh();
			});
			await act(async () => {
				resolve({ kind: "ready", launch });
				expect(await pending).toMatchObject({ kind: "refused" });
			});
			expect(push).not.toHaveBeenCalled();
			expect(h.session.getState().previewEntryPointLaunch).toBeUndefined();
		});
});
