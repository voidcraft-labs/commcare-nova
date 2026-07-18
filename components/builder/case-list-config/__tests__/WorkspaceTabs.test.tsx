// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "@/components/builder/case-list-config/CaseListConfigWorkspace";

const session = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => null,
	useCanEdit: () => session.canEdit,
}));

vi.mock("@/components/shadcn/tooltip", () => ({
	SimpleTooltip: ({
		content,
		children,
	}: {
		readonly content: string;
		readonly children: ReactNode;
	}) => <span data-tooltip-content={content}>{children}</span>,
}));

describe("WorkspaceTabs", () => {
	beforeEach(() => {
		session.canEdit = true;
	});

	it("keeps the fixed workspace screens inside a labeled navigation landmark", () => {
		const onSelectTab = vi.fn();
		render(
			<WorkspaceTabs
				tab="list"
				errorAreas={{ search: false, list: false, detail: false }}
				onSelectTab={onSelectTab}
			/>,
		);

		const navigation = screen.getByRole("navigation", {
			name: "Case workspace screens",
		});
		expect(
			navigation.closest("[data-case-workspace-tabs]")?.className,
		).toContain("shrink-0");
		expect(
			navigation
				.closest("[data-case-workspace-tabs]")
				?.getAttribute("data-compact-height"),
		).toBeNull();
		expect(
			screen
				.getByRole("button", { name: "Results" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(screen.getByRole("button", { name: "Search" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Details" })).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Details" }));
		expect(onSelectTab).toHaveBeenCalledWith("detail");
	});

	it("keeps settings in the existing tab row while yielding height to the canvas", () => {
		render(
			<WorkspaceTabs
				tab="list"
				errorAreas={{ search: false, list: false, detail: false }}
				onSelectTab={() => {}}
				compactHeight
				moduleSettings={
					<button type="button" className="size-11">
						Module settings
					</button>
				}
			/>,
		);

		const tabs = document.querySelector<HTMLElement>(
			"[data-case-workspace-tabs]",
		);
		expect(tabs?.getAttribute("data-compact-height")).toBe("true");
		expect(tabs?.className).toContain("py-1");
		expect(tabs?.className).not.toContain("py-2.5");
		expect(document.querySelector("[data-case-list-module-header]")).toBeNull();
		expect(screen.queryByRole("textbox", { name: "Module name" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Module settings" }),
		).toBeDefined();
		expect(
			screen.getByRole("navigation", { name: "Case workspace screens" })
				.className,
		).toContain("flex-1");
	});

	it("describes a problem without telling viewers they can fix it", () => {
		session.canEdit = false;
		render(
			<WorkspaceTabs
				tab="search"
				errorAreas={{ search: false, list: true, detail: false }}
				onSelectTab={() => {}}
			/>,
		);

		const results = screen.getByRole("button", {
			name: "Results, needs attention",
		});
		expect(
			results
				.closest("[data-tooltip-content]")
				?.getAttribute("data-tooltip-content"),
		).toBe("Results needs attention");
	});
});
