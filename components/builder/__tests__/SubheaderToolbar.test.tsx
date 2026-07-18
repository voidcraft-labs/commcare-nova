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

const resizeCallbacks = new Set<ResizeObserverCallback>();

function notifyResize() {
	for (const callback of resizeCallbacks) {
		callback([], {} as ResizeObserver);
	}
}

class ResizeObserverStub {
	private readonly callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		resizeCallbacks.add(callback);
	}

	observe() {}
	unobserve() {}
	disconnect() {
		resizeCallbacks.delete(this.callback);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	resizeCallbacks.clear();
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
		const breadcrumbParts = parts();
		render(<CollapsibleBreadcrumb parts={breadcrumbParts} />);

		const trail = document.querySelector<HTMLElement>(
			"[data-breadcrumb-trail]",
		);
		if (!trail) throw new Error("Breadcrumb trail did not render");
		const wrapper = trail.parentElement;
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

		act(() => notifyResize());

		const current = trail.querySelector('[aria-current="location"]');
		expect(current?.tagName).toBe("SPAN");
		expect(current?.textContent).toBe("Search");
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
		const pathTrigger = screen.getByRole("button", {
			name: "Show breadcrumb path",
		});
		expect(pathTrigger.getAttribute("data-slot")).toBe("popover-trigger");
		fireEvent.click(pathTrigger);
		const home = await screen.findByRole("button", { name: "Home" });
		const patients = screen.getByRole("button", { name: "Patients" });
		expect(home.getAttribute("data-slot")).toBe("button");
		expect(home.className).toContain("rounded-lg");
		expect(patients.className).toContain("rounded-lg");
		expect(
			document.querySelector('[data-slot="popover-content"]'),
		).not.toBeNull();

		fireEvent.click(home);
		expect(breadcrumbParts[0].onClick).toHaveBeenCalledTimes(1);
		// Selecting an ancestor dismisses the floating path menu and lets Base UI
		// restore focus before the leak detector tears the test down.
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Home" })).toBeNull(),
		);
	});

	it("uses shadcn buttons for expanded ancestor segments", () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		render(<CollapsibleBreadcrumb parts={parts()} />);

		const home = screen.getByRole("button", { name: "Home" });
		const patients = screen.getByRole("button", { name: "Patients" });
		expect(home.getAttribute("data-slot")).toBe("button");
		expect(patients.getAttribute("data-slot")).toBe("button");
		expect(home.className).toContain("min-h-11");
		expect(home.className).toContain("text-lg");
		expect(home.className).toContain("rounded-lg");
		expect(
			document
				.querySelector("[data-breadcrumb-trail]")
				?.querySelector('[aria-current="location"]')?.textContent,
		).toBe("Search");
		expect(
			document
				.querySelector("[data-breadcrumb-trail]")
				?.querySelector('[aria-current="location"]')
				?.getAttribute("tabindex"),
		).toBeNull();
	});

	it("keeps only a touch-safe ancestor path menu when handset workspace tabs name the current screen", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		const breadcrumbParts = parts();
		render(<CollapsibleBreadcrumb parts={breadcrumbParts} compactWorkspace />);

		/* At 320px, Search is already the selected workspace tab immediately
		 * below this bar. Repeating it here previously produced `Sear…` beside
		 * Case data; the compact trail now spends its width on one real action. */
		expect(
			document.querySelector(
				'[data-compact-workspace-breadcrumb] [aria-current="location"]',
			),
		).toBeNull();
		expect(screen.queryByText("Search")).toBeNull();
		const pathTrigger = screen.getByRole("button", {
			name: "Show breadcrumb path",
		});
		expect(pathTrigger.className).toContain("size-11");

		fireEvent.click(pathTrigger);
		const home = await screen.findByRole("button", { name: "Home" });
		const patients = screen.getByRole("button", { name: "Patients" });
		expect(home.className).toContain("min-h-11");
		expect(patients.className).toContain("min-h-11");
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();

		fireEvent.click(patients);
		expect(breadcrumbParts[1].onClick).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Home" })).toBeNull(),
		);
	});

	it("keeps the complete current location available from the fixed breadcrumb bar", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		const longCurrent =
			"Follow-up visits that need a complete authored name in every workspace";
		render(
			<CollapsibleBreadcrumb
				parts={[
					{ key: "home", label: "Home", onClick: vi.fn() },
					{ key: "screen", label: longCurrent, onClick: vi.fn() },
				]}
			/>,
		);

		const current = document.querySelector<HTMLElement>(
			'[data-breadcrumb-trail] [aria-current="location"]',
		);
		if (!current) throw new Error("Current breadcrumb did not render");
		Object.defineProperty(current, "clientWidth", {
			configurable: true,
			value: 180,
		});
		Object.defineProperty(current, "scrollWidth", {
			configurable: true,
			value: 520,
		});
		act(() => notifyResize());

		await waitFor(() =>
			expect(
				document
					.querySelector('[data-breadcrumb-trail] [aria-current="location"]')
					?.getAttribute("data-slot"),
			).toBe("tooltip-trigger"),
		);
		const clippedCurrent = document.querySelector<HTMLElement>(
			'[data-breadcrumb-trail] [aria-current="location"]',
		);
		expect(clippedCurrent?.getAttribute("aria-current")).toBe("location");
		expect(clippedCurrent?.getAttribute("tabindex")).toBe("0");
		expect(clippedCurrent?.textContent).toBe(longCurrent);
	});
});
