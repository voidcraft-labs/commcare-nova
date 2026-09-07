// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CasePropertyRenamePreflightResult } from "@/lib/preview/engine/casePropertyRenamePreflightTypes";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const { action } = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("@/lib/preview/engine/casePropertyRenamePreflight", () => ({
	preflightCasePropertyRenamesAction: action,
}));

import { useCasePropertyRenamePreflight } from "../useCasePropertyRenamePreflight";

const RENAMES = [
	{ caseType: "patient", from: "old_name", to: "new_name" },
] as const;
const OK: CasePropertyRenamePreflightResult = {
	kind: "ok",
	mutationSeq: 4,
	report: {
		renamedRows: 2,
		renamedParkedValues: 1,
		byRename: [{ ...RENAMES[0], rowsWithSource: 2, parkedValuesWithSource: 1 }],
	},
};
function deferred<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}
function harness() {
	const session = createBuilderSessionStore({
		appId: "app-1",
		projectId: "project-1",
		role: "viewer",
		canEdit: false,
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BuilderSessionContext value={session}>{children}</BuilderSessionContext>
	);
	return {
		session,
		...renderHook(() => useCasePropertyRenamePreflight(), { wrapper }),
	};
}
beforeEach(() => {
	vi.resetAllMocks();
});

describe("rename preflight request lifetime with the real session store", () => {
	it.each(["scope", "revocation", "app", "unmount"] as const)(
		"discards the result after %s",
		async (boundary) => {
			const gate = deferred<CasePropertyRenamePreflightResult>();
			action.mockReturnValue(gate.promise);
			const h = harness();
			let request: ReturnType<typeof h.result.current.preflight> | undefined;
			try {
				act(() => {
					request = h.result.current.preflight(RENAMES);
				});
				expect(h.result.current.state).toEqual({ kind: "checking" });
				act(() => {
					if (boundary === "scope") h.session.getState().beginAccessRefresh();
					else if (boundary === "revocation")
						h.session.getState().revokeAccess();
					else if (boundary === "app") h.session.getState().setAppId("app-2");
					else h.unmount();
				});
				await act(async () => {
					gate.resolve(OK);
					expect(await request).toBeUndefined();
				});
				if (boundary !== "unmount")
					expect(h.result.current.state).toEqual({ kind: "idle" });
			} finally {
				await act(async () => {
					gate.resolve(OK);
					await request;
				});
			}
		},
	);
	it("keeps the newest response when the older request settles last", async () => {
		const gate = deferred<CasePropertyRenamePreflightResult>();
		const conflict: CasePropertyRenamePreflightResult = {
			kind: "conflict",
			mutationSeq: 5,
			conflicts: [
				{
					caseType: "patient",
					property: "new_name",
					carrier: "case-row",
					count: 1,
				},
			],
		};
		action.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(conflict);
		const h = harness();
		let request: ReturnType<typeof h.result.current.preflight> | undefined;
		try {
			act(() => {
				request = h.result.current.preflight(RENAMES);
			});
			await act(async () => {
				expect(await h.result.current.preflight(RENAMES)).toEqual(conflict);
			});
			await act(async () => {
				gate.resolve(OK);
				expect(await request).toBeUndefined();
			});
			expect(h.result.current.state).toEqual(conflict);
		} finally {
			await act(async () => {
				gate.resolve(OK);
				await request;
			});
		}
	});
	it("does not send a request during an access refresh", async () => {
		const h = harness();
		act(() => h.session.getState().beginAccessRefresh());
		await act(async () => {
			expect(await h.result.current.preflight(RENAMES)).toBeUndefined();
		});
		expect(action).not.toHaveBeenCalled();
		expect(h.result.current.state).toEqual({ kind: "idle" });
	});
});
