// @vitest-environment happy-dom

/**
 * Tests for `useAppTreeSelection` — the dispatcher the AppTree row
 * components invoke when the user clicks a tree item.
 *
 * Two responsibilities must hold:
 *
 *   1. Every target kind routes to the correct `useNavigate` method.
 *   2. Question targets set a pending scroll request BEFORE navigating,
 *      so the target row's `useFulfillPendingScroll` has a request
 *      waiting when its `isSelected` flips true.
 *
 * The routing module + the scroll registry are both mocked so the hook
 * can be tested in isolation from the full builder provider stack.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppTreeSelection } from "@/components/builder/appTree/useAppTreeSelection";
import { asUuid } from "@/lib/doc/types";

/**
 * The navigate mock captures every dispatch so assertions can verify
 * both the chosen method and the exact arguments forwarded.
 */
const navigateMock = {
	goHome: vi.fn(),
	openModule: vi.fn(),
	openForm: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	up: vi.fn(),
};

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => navigateMock,
}));

/**
 * The scroll-registry mock captures `setPending` so tests can assert
 * question selections prime a scroll request before navigation.
 */
const setPendingMock = vi.fn();

vi.mock("@/components/builder/contexts/ScrollRegistryContext", () => ({
	useScrollIntoView: () => ({
		setPending: setPendingMock,
		scrollTo: vi.fn(),
	}),
}));

describe("useAppTreeSelection", () => {
	beforeEach(() => {
		navigateMock.goHome.mockClear();
		navigateMock.openModule.mockClear();
		navigateMock.openForm.mockClear();
		setPendingMock.mockClear();
	});

	it("dispatches `clear` → navigate.goHome", () => {
		const { result } = renderHook(() => useAppTreeSelection());
		act(() => result.current({ kind: "clear" }));
		expect(navigateMock.goHome).toHaveBeenCalledOnce();
		expect(setPendingMock).not.toHaveBeenCalled();
	});

	it("dispatches `module` → navigate.openModule with the uuid", () => {
		const { result } = renderHook(() => useAppTreeSelection());
		const moduleUuid = asUuid("mod-1");
		act(() => result.current({ kind: "module", moduleUuid }));
		expect(navigateMock.openModule).toHaveBeenCalledOnce();
		expect(navigateMock.openModule).toHaveBeenCalledWith(moduleUuid);
		expect(setPendingMock).not.toHaveBeenCalled();
	});

	it("dispatches `form` → navigate.openForm with module + form uuids", () => {
		const { result } = renderHook(() => useAppTreeSelection());
		const moduleUuid = asUuid("mod-1");
		const formUuid = asUuid("form-1");
		act(() => result.current({ kind: "form", moduleUuid, formUuid }));
		expect(navigateMock.openForm).toHaveBeenCalledOnce();
		expect(navigateMock.openForm).toHaveBeenCalledWith(moduleUuid, formUuid);
		expect(setPendingMock).not.toHaveBeenCalled();
	});

	it("dispatches `question` → setPending BEFORE navigate.openForm", () => {
		const { result } = renderHook(() => useAppTreeSelection());
		const moduleUuid = asUuid("mod-1");
		const formUuid = asUuid("form-1");
		const questionUuid = asUuid("q-1");

		act(() =>
			result.current({ kind: "question", moduleUuid, formUuid, questionUuid }),
		);

		expect(setPendingMock).toHaveBeenCalledOnce();
		expect(setPendingMock).toHaveBeenCalledWith(questionUuid, "instant", false);
		expect(navigateMock.openForm).toHaveBeenCalledOnce();
		expect(navigateMock.openForm).toHaveBeenCalledWith(
			moduleUuid,
			formUuid,
			questionUuid,
		);

		// Order matters: pending scroll must be primed first so the target
		// row's `useFulfillPendingScroll` sees the request when its
		// `isSelected` flips true. Mock call-order is a reliable proxy.
		const setPendingOrder = setPendingMock.mock.invocationCallOrder[0];
		const openFormOrder = navigateMock.openForm.mock.invocationCallOrder[0];
		expect(setPendingOrder).toBeLessThan(openFormOrder);
	});
});
