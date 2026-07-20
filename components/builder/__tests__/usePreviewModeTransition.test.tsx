// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewModeTransition } from "@/components/builder/usePreviewModeTransition";
import type { Location } from "@/lib/routing/types";

const state = vi.hoisted(() => ({
	location: { kind: "home" } as Location,
	replace: vi.fn(),
}));

vi.mock("@/lib/routing/hooks", () => ({
	useLocation: () => state.location,
	useNavigate: () => ({ replace: state.replace }),
}));

describe("usePreviewModeTransition", () => {
	beforeEach(() => {
		state.location = { kind: "home" };
		state.replace.mockReset();
	});

	it.each([
		{
			name: "Search",
			location: {
				kind: "search-config",
				moduleUuid: "module-1",
			} as Location,
		},
		{
			name: "Results",
			location: { kind: "cases", moduleUuid: "module-1" } as Location,
		},
		{
			name: "Details",
			location: {
				kind: "detail-config",
				moduleUuid: "module-1",
			} as Location,
		},
	])(
		"preserves the $name authoring tab when Preview has not moved surfaces",
		({ location }) => {
			state.location = location;
			const setPreviewing = vi.fn();
			const { result } = renderHook(() =>
				usePreviewModeTransition(setPreviewing),
			);

			act(() => result.current(false));

			expect(state.replace).not.toHaveBeenCalled();
			expect(setPreviewing).toHaveBeenCalledWith(false);
		},
	);

	it("maps an open running case record to Details authoring on exit", () => {
		state.location = {
			kind: "cases",
			moduleUuid: "module-1",
			caseId: "case-1",
		} as Location;
		const setPreviewing = vi.fn();
		const { result } = renderHook(() =>
			usePreviewModeTransition(setPreviewing),
		);

		act(() => result.current(false));

		expect(state.replace).toHaveBeenCalledWith({
			kind: "detail-config",
			moduleUuid: "module-1",
		});
		expect(setPreviewing).toHaveBeenCalledWith(false);
	});

	it("does not rewrite a record URL while entering Preview", () => {
		state.location = {
			kind: "cases",
			moduleUuid: "module-1",
			caseId: "case-1",
		} as Location;
		const setPreviewing = vi.fn();
		const { result } = renderHook(() =>
			usePreviewModeTransition(setPreviewing),
		);

		act(() => result.current(true));

		expect(state.replace).not.toHaveBeenCalled();
		expect(setPreviewing).toHaveBeenCalledWith(true);
	});
});
