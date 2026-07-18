// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CaseListModuleHeader,
	WorkspaceTabs,
} from "@/components/builder/case-list-config/CaseListConfigWorkspace";
import { asUuid } from "@/lib/domain";

const session = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => null,
	useCanEdit: () => session.canEdit,
}));

vi.mock(
	"@/components/builder/detail/moduleSettings/ModuleSettingsButton",
	() => ({
		ModuleSettingsButton: () => (
			<button type="button" className="size-11">
				Module settings
			</button>
		),
	}),
);

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

	it("keeps settings and frozen tabs while yielding height to the canvas", () => {
		render(
			<WorkspaceTabs
				tab="list"
				errorAreas={{ search: false, list: false, detail: false }}
				onSelectTab={() => {}}
				compactHeight
				header={
					<CaseListModuleHeader
						moduleUuid={asUuid("00000000-0000-4000-8000-000000000001")}
						name="Patients"
						onSave={() => ({ ok: true })}
						compact
					/>
				}
			/>,
		);

		const tabs = document.querySelector<HTMLElement>(
			"[data-case-workspace-tabs]",
		);
		expect(tabs?.getAttribute("data-compact-height")).toBe("true");
		expect(tabs?.className).toContain("py-1");
		expect(tabs?.className).not.toContain("py-2.5");
		const compactHeader = document.querySelector<HTMLElement>(
			'[data-case-list-module-header="compact"]',
		);
		expect(compactHeader?.className).toContain("absolute");
		expect(screen.queryByRole("textbox", { name: "Module name" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Module settings" }),
		).toBeDefined();
		expect(
			screen.getByRole("navigation", { name: "Case workspace screens" })
				.className,
		).toContain("pr-12");
	});

	it("contains a long bare-module name without crowding its settings action", () => {
		const longName =
			"Community health follow-up and medication administration for returning clients";
		render(
			<CaseListModuleHeader
				moduleUuid={asUuid("00000000-0000-4000-8000-000000000001")}
				name={longName}
				onSave={() => ({ ok: true })}
			/>,
		);

		const header = document.querySelector("[data-case-list-module-header]");
		expect(header?.className).toContain("min-w-0");
		expect(header?.className).toContain("items-start");
		const title = screen.getByRole("textbox", { name: "Module name" });
		expect((title as HTMLTextAreaElement).value).toBe(longName);
		expect(title.className).toContain("max-w-full");
		expect(title.className).toContain("min-h-11");
		expect(title.className).toContain("whitespace-pre-wrap");
		expect(
			screen.getByRole("button", { name: "Module settings" }).parentElement
				?.className,
		).toContain("shrink-0");
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
