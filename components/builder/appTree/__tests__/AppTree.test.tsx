// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppTree } from "@/components/builder/appTree/AppTree";
import { BuilderPhase } from "@/lib/session/builderTypes";

const session = vi.hoisted(() => ({ phase: "ready" }));
const route = vi.hoisted(() => ({
	fieldUuid: undefined as string | undefined,
	formUuid: undefined as string | undefined,
}));
const preload = vi.hoisted(() => ({
	fieldInspector: vi.fn(() => Promise.resolve({})),
	xpathEditor: vi.fn(() => Promise.resolve({})),
}));
const MODULE_UUID = "00000000-0000-4000-8000-000000000001";

vi.mock("@/lib/session/hooks", () => ({
	useBuilderPhase: () => session.phase,
}));

vi.mock("@/lib/doc/hooks/useModuleIds", () => ({
	useModuleMenuHierarchy: () => ({
		rootModuleUuids: [MODULE_UUID],
		childModuleUuidsByRoot: { [MODULE_UUID]: [] },
	}),
}));

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: () => undefined,
}));

vi.mock("@/lib/doc/hooks/useOrderedFields", () => ({
	useLargeFormInitialCollapsedUuids: () => new Set(),
}));

vi.mock("@/lib/doc/hooks/useAncestors", () => ({
	useAncestors: () => [],
}));

vi.mock("@/lib/routing/hooks", () => ({
	useSelectedFieldUuid: () => route.fieldUuid,
	useSelectedFormUuid: () => route.formUuid,
	useSelectedModuleUuid: () => undefined,
}));

vi.mock("@/components/builder/inspector/lazyInspectorBodies", () => ({
	loadFieldInspectorBody: preload.fieldInspector,
	loadXPathEditor: preload.xpathEditor,
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
					matchMap: new Map(),
					forceExpand: new Set(),
					visibleFormUuids: new Set(),
					visibleModuleUuids: new Set(),
				}
			: null,
}));

vi.mock("@/components/builder/appTree/useAppTreeSelection", () => ({
	useAppTreeSelection: () => vi.fn(),
}));

vi.mock("@/components/builder/appTree/ModuleCard", () => ({
	ModuleCard: ({
		moduleUuid,
		onPlacementCommitted,
	}: {
		moduleUuid: string;
		onPlacementCommitted: (uuid: string, parentUuid?: string | null) => void;
	}) => (
		<li>
			<button type="button" data-module-actions={moduleUuid}>
				Module actions
			</button>
			<button type="button" onClick={() => onPlacementCommitted(moduleUuid)}>
				Complete placement
			</button>
			<button
				type="button"
				onClick={() =>
					onPlacementCommitted(
						"00000000-0000-4000-8000-000000000099",
						moduleUuid,
					)
				}
			>
				Complete hidden placement
			</button>
		</li>
	),
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
		route.fieldUuid = undefined;
		route.formUuid = undefined;
		preload.fieldInspector.mockClear();
		preload.xpathEditor.mockClear();
	});

	it("starts both field-editor chunks for an explicit field route", () => {
		route.formUuid = "00000000-0000-4000-8000-000000000002";
		route.fieldUuid = "00000000-0000-4000-8000-000000000003";

		render(<AppTree />);

		expect(preload.fieldInspector).toHaveBeenCalledOnce();
		expect(preload.xpathEditor).toHaveBeenCalledOnce();
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

	it("returns focus to the moved module's action after topology renders", () => {
		render(<AppTree />);
		fireEvent.click(screen.getByRole("button", { name: "Complete placement" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Module actions" }),
		);
	});

	it("falls back to the destination menu when a moved row is not mounted", () => {
		render(<AppTree />);
		fireEvent.click(
			screen.getByRole("button", { name: "Complete hidden placement" }),
		);
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Module actions" }),
		);
	});
});
