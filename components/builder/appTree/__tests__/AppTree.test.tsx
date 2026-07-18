// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppTree } from "@/components/builder/appTree/AppTree";
import { BuilderPhase } from "@/lib/session/builderTypes";

const session = vi.hoisted(() => ({ phase: "ready" }));

vi.mock("@/lib/session/hooks", () => ({
	useBuilderPhase: () => session.phase,
}));

vi.mock("@/lib/doc/hooks/useModuleIds", () => ({
	useModuleIds: () => ["00000000-0000-4000-8000-000000000001"],
}));

vi.mock("@/lib/doc/hooks/useSearchFilter", () => ({
	useSearchFilter: (query: string) =>
		query
			? {
					fieldIdMatches: new Map(),
					fieldTextMatches: new Map(),
					formNameMatches: new Map(),
					moduleNameMatches: new Map(),
					visibleFieldUuids: new Set(),
					visibleFormIds: new Set(),
					visibleModuleIndices: new Set(),
				}
			: null,
}));

vi.mock("@/components/builder/appTree/useAppTreeSelection", () => ({
	useAppTreeSelection: () => vi.fn(),
}));

vi.mock("@/components/builder/appTree/ModuleCard", () => ({
	ModuleCard: () => <div>Module row</div>,
}));

vi.mock("@/components/builder/appTree/insertion/AddModulePopover", () => ({
	AddModulePopover: () => null,
}));

vi.mock("@/lib/ui/hooks/useInsertionZone", () => ({
	InsertionIntentProvider: ({ children }: { children: ReactNode }) => children,
}));

describe("AppTree search", () => {
	beforeEach(() => {
		session.phase = BuilderPhase.Ready;
	});

	it("uses a friendly, full-size shadcn search control", () => {
		render(<AppTree />);
		expect(screen.getByRole("list", { name: "App structure" })).toBeDefined();

		const input = screen.getByRole("textbox", { name: "Find in app" });
		expect(input.getAttribute("placeholder")).toBe("Find in app");
		expect(input.getAttribute("data-slot")).toBe("input");
		expect(input.className).toContain("h-11");

		fireEvent.change(input, { target: { value: "missing" } });
		const clear = screen.getByRole("button", { name: "Clear search" });
		expect(clear.getAttribute("data-slot")).toBe("button");
		expect(clear.className).toContain("size-11");
		fireEvent.click(clear);
		expect((input as HTMLInputElement).value).toBe("");
	});

	it("explains an empty search in the context of the app", () => {
		render(<AppTree />);
		fireEvent.change(screen.getByRole("textbox", { name: "Find in app" }), {
			target: { value: "missing" },
		});
		expect(screen.getByText("No matches in your app")).toBeDefined();
	});

	it("keeps the search visible but disabled while app structure is changing", () => {
		session.phase = BuilderPhase.Generating;
		render(<AppTree />);
		const input = screen.getByRole("textbox", { name: "Find in app" });
		expect((input as HTMLInputElement).disabled).toBe(true);
	});
});
