// @vitest-environment happy-dom
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BreadcrumbPart,
	CollapsibleBreadcrumb,
} from "@/components/builder/SubheaderToolbar";

let notifyResize: (() => void) | undefined;

class ResizeObserverStub {
	private readonly callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		notifyResize = () => this.callback([], this as unknown as ResizeObserver);
	}

	observe() {}
	unobserve() {}
	disconnect() {}
}

afterEach(() => {
	vi.unstubAllGlobals();
	notifyResize = undefined;
});

function parts(): BreadcrumbPart[] {
	return [
		{ key: "home", label: "Home", onClick: vi.fn() },
		{ key: "module", label: "Patients", onClick: vi.fn() },
		{ key: "screen", label: "Search", onClick: vi.fn() },
	];
}

describe("CollapsibleBreadcrumb", () => {
	it("keeps the current location visible and moves ancestors into a path menu on overflow", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		render(<CollapsibleBreadcrumb parts={parts()} />);

		const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
		const wrapper = nav.parentElement;
		const mirror = wrapper?.lastElementChild as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		expect(mirror).not.toBeNull();
		Object.defineProperty(wrapper, "clientWidth", {
			configurable: true,
			value: 120,
		});
		Object.defineProperty(mirror, "scrollWidth", {
			configurable: true,
			value: 260,
		});

		act(() => notifyResize?.());

		const current = nav.querySelector('[aria-current="location"]');
		expect(current?.tagName).toBe("SPAN");
		expect(current?.textContent).toBe("Search");
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
		const pathTrigger = screen.getByRole("button", {
			name: "Show breadcrumb path",
		});
		fireEvent.click(pathTrigger);
		expect(await screen.findByRole("button", { name: "Home" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Patients" })).toBeDefined();

		// Close the floating menu and let Base UI restore focus before the
		// leak detector tears the test down.
		fireEvent.click(pathTrigger);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Home" })).toBeNull(),
		);
	});
});
