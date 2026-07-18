// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuilderPageNavigation } from "@/components/builder/BreadcrumbStrip";

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

afterEach(() => vi.unstubAllGlobals());

describe("BuilderPageNavigation", () => {
	it("combines contextual Back and breadcrumbs in one labeled landmark", () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		const onBack = vi.fn();
		render(
			<BuilderPageNavigation
				hasData
				canGoBack
				onBack={onBack}
				parts={[
					{ key: "home", label: "Home", onClick: vi.fn() },
					{ key: "results", label: "Results", onClick: vi.fn() },
				]}
			/>,
		);

		const navigation = screen.getByRole("navigation", {
			name: "Page navigation",
		});
		expect(
			navigation.querySelector('[aria-current="location"]')?.textContent,
		).toBe("Results");
		expect(screen.queryByRole("button", { name: "Go to parent" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Go back" }));
		expect(onBack).toHaveBeenCalledOnce();
	});

	it("lets the fixed workspace tabs own the current leaf at 320px", () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		render(
			<BuilderPageNavigation
				hasData
				canGoBack
				onBack={vi.fn()}
				compactWorkspaceBreadcrumb
				parts={[
					{ key: "home", label: "Home", onClick: vi.fn() },
					{ key: "module", label: "Patients", onClick: vi.fn() },
					{ key: "details", label: "Details", onClick: vi.fn() },
				]}
			/>,
		);

		const navigation = screen.getByRole("navigation", {
			name: "Page navigation",
		});
		expect(navigation.querySelector('[aria-current="location"]')).toBeNull();
		expect(screen.queryByText("Details")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Show breadcrumb path" }),
		).toBeDefined();
		expect(screen.getByRole("button", { name: "Go back" })).toBeDefined();
	});
});
