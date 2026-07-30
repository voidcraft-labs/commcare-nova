// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CasePropertyRenamePreflightResult } from "@/lib/preview/engine/casePropertyRenamePreflightTypes";

const mocks = vi.hoisted(() => ({
	action: vi.fn(),
	rendered: {
		appId: "app-1" as string | undefined,
		accessPhase: "authorized" as
			| "authorized"
			| "refreshing"
			| "reconnecting"
			| "upgradeRequired"
			| "revoked",
		scopeEpoch: 1,
	},
	current: {
		appId: "app-1" as string | undefined,
		accessPhase: "authorized" as
			| "authorized"
			| "refreshing"
			| "reconnecting"
			| "upgradeRequired"
			| "revoked",
		scopeEpoch: 1,
		canEdit: false,
	},
}));

vi.mock("@/lib/preview/engine/casePropertyRenamePreflight", () => ({
	preflightCasePropertyRenamesAction: mocks.action,
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => mocks.rendered.appId,
	useAccessPhase: () => mocks.rendered.accessPhase,
	useProjectScopeEpoch: () => mocks.rendered.scopeEpoch,
}));
vi.mock("@/lib/session/provider", () => ({
	useOptionalBuilderSessionApi: () => ({
		getState: () => mocks.current,
	}),
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
		byRename: [
			{
				...RENAMES[0],
				rowsWithSource: 2,
				parkedValuesWithSource: 1,
			},
		],
	},
};

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(mocks.rendered, {
		appId: "app-1",
		accessPhase: "authorized",
		scopeEpoch: 1,
	});
	Object.assign(mocks.current, {
		appId: "app-1",
		accessPhase: "authorized",
		scopeEpoch: 1,
		canEdit: false,
	});
});

describe("useCasePropertyRenamePreflight", () => {
	it("allows an authorized viewer to inspect impact", async () => {
		mocks.action.mockResolvedValue(OK);
		const { result } = renderHook(() => useCasePropertyRenamePreflight());

		let settled: CasePropertyRenamePreflightResult | undefined;
		await act(async () => {
			settled = await result.current.preflight(RENAMES);
		});

		expect(mocks.current.canEdit).toBe(false);
		expect(mocks.action).toHaveBeenCalledWith({
			appId: "app-1",
			renames: RENAMES,
		});
		expect(settled).toEqual(OK);
		expect(result.current.state).toEqual(OK);
	});

	it("drops an in-flight result after the Project scope epoch changes", async () => {
		const pending = deferred<CasePropertyRenamePreflightResult>();
		mocks.action.mockReturnValue(pending.promise);
		const { result, rerender } = renderHook(() =>
			useCasePropertyRenamePreflight(),
		);

		let settlePromise:
			| Promise<CasePropertyRenamePreflightResult | undefined>
			| undefined;
		act(() => {
			settlePromise = result.current.preflight(RENAMES);
		});
		expect(result.current.state).toEqual({ kind: "checking" });

		Object.assign(mocks.rendered, {
			appId: "app-2",
			scopeEpoch: 2,
		});
		Object.assign(mocks.current, {
			appId: "app-2",
			scopeEpoch: 2,
		});
		rerender();
		expect(result.current.state).toEqual({ kind: "idle" });

		pending.resolve(OK);
		let settled: CasePropertyRenamePreflightResult | undefined;
		await act(async () => {
			settled = await settlePromise;
		});
		expect(settled).toBeUndefined();
		expect(result.current.state).toEqual({ kind: "idle" });
	});

	it("lets the newest request win within one scope", async () => {
		const first = deferred<CasePropertyRenamePreflightResult>();
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
		mocks.action
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(conflict);
		const { result } = renderHook(() => useCasePropertyRenamePreflight());

		let firstPromise:
			| Promise<CasePropertyRenamePreflightResult | undefined>
			| undefined;
		act(() => {
			firstPromise = result.current.preflight(RENAMES);
		});
		await act(async () => {
			await result.current.preflight(RENAMES);
		});
		expect(result.current.state).toEqual(conflict);

		first.resolve(OK);
		let firstResult: CasePropertyRenamePreflightResult | undefined;
		await act(async () => {
			firstResult = await firstPromise;
		});
		expect(firstResult).toBeUndefined();
		expect(result.current.state).toEqual(conflict);
	});

	it("does not issue a request while access is refreshing", async () => {
		mocks.rendered.accessPhase = "refreshing";
		mocks.current.accessPhase = "refreshing";
		const { result } = renderHook(() => useCasePropertyRenamePreflight());

		let settled: CasePropertyRenamePreflightResult | undefined;
		await act(async () => {
			settled = await result.current.preflight(RENAMES);
		});

		expect(settled).toBeUndefined();
		expect(result.current.state).toEqual({ kind: "idle" });
		expect(mocks.action).not.toHaveBeenCalled();
	});
});
