// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Location } from "@/lib/routing/types";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { applyControllerEdit } from "../../engine/__tests__/fixtures/controllerDoc";
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
	const fixture = buildDoc({
		appId: "app",
		appName: "Links",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "module",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "form",
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes" })],
					},
				],
			},
		],
	});
	fixture.forms[F].entryPoint = {
		uuid: E,
		id: "visit",
		ignoreDisplayConditions: true,
	};
	doc.getState().load(assertAdmittedPreviewDoc(fixture));
	doc.getState().startTracking();
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
		act(() =>
			applyControllerEdit(h.doc, [{ kind: "setAppName", name: "Edited" }]),
		);
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
		applyControllerEdit(h.doc, [
			{ kind: "setAppName", name: "Edited after unmount" },
		]);
		expect(replace).not.toHaveBeenCalled();
	});
});
describe("entry point launch responses", () => {
	it("installs an admitted action response into the real session and navigates", async () => {
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
	it("waits for the save barrier before sending the admitted revision", async () => {
		const h = harness();
		const gate = Promise.withResolvers<{ kind: "saved" }>();
		barrier.mockReturnValue(gate.promise);
		const view = renderHook(() => useEntryPointLaunch(), {
			wrapper: h.wrapper,
		});
		let pending: Promise<EntryPointLaunchResult> | undefined;
		try {
			act(() => {
				pending = view.result.current(E, []);
			});
			expect(action).not.toHaveBeenCalled();
			expect(push).not.toHaveBeenCalled();
			await act(async () => {
				gate.resolve({ kind: "saved" });
				expect(await pending).toEqual({ kind: "ready", launch });
			});
			expect(action).toHaveBeenCalledWith(
				expect.objectContaining({ expectedSeq: 4 }),
			);
		} finally {
			await act(async () => {
				gate.resolve({ kind: "saved" });
				await pending;
			});
		}
	});
	it.each([
		"document",
		"persona",
		"scope",
		"unmount",
		"saved revision",
	] as const)(
		"discards a launch response after a %s change",
		async (boundary) => {
			const h = harness();
			const gate = Promise.withResolvers<EntryPointLaunchResult>();
			const started = Promise.withResolvers<void>();
			action.mockImplementation(() => {
				started.resolve();
				return gate.promise;
			});
			const view = renderHook(() => useEntryPointLaunch(), {
				wrapper: h.wrapper,
			});
			let pending: Promise<EntryPointLaunchResult> | undefined;
			try {
				await act(async () => {
					pending = view.result.current(E, []);
					await started.promise;
				});
				act(() => {
					if (boundary === "document")
						applyControllerEdit(h.doc, [
							{ kind: "setAppName", name: "New revision" },
						]);
					else if (boundary === "persona")
						h.session
							.getState()
							.setPreviewPersonaUuid(testUuid("other-persona"));
					else if (boundary === "scope")
						h.session.getState().beginAccessRefresh();
					else if (boundary === "saved revision")
						snapshot.mockReturnValue({ baseSeq: 5 });
					else view.unmount();
				});
				await act(async () => {
					gate.resolve({ kind: "ready", launch });
					expect(await pending).toMatchObject({ kind: "refused" });
				});
				expect(push).not.toHaveBeenCalled();
				expect(h.session.getState().previewEntryPointLaunch).toBeUndefined();
			} finally {
				await act(async () => {
					gate.resolve({ kind: "ready", launch });
					await pending;
				});
			}
		},
	);
});
