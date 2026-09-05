// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import type { Uuid } from "@/lib/doc/types";

const access = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => access.canEdit,
}));

vi.mock(
	"@/components/builder/detail/moduleSettings/ModuleCaseTypeSection",
	() => ({ ModuleCaseTypeSection: () => <div>Case type section</div> }),
);
vi.mock(
	"@/components/builder/detail/moduleSettings/ModuleAppearanceSection",
	() => ({ ModuleAppearanceSection: () => <div>Appearance section</div> }),
);
vi.mock("@/components/builder/detail/moduleSettings/ModuleNameSection", () => ({
	ModuleNameSection: () => <div>Name section</div>,
}));
vi.mock(
	"@/components/builder/detail/moduleSettings/MenuPlacementSection",
	() => ({ MenuPlacementSection: () => <div>Menu placement section</div> }),
);
vi.mock("@/components/builder/app-setup/EntryPointSettingsShortcut", () => ({
	EntryPointSettingsShortcut: ({ target }: { target: { kind: string } }) => (
		<div>{target.kind} deep link section</div>
	),
}));

vi.mock("@/components/builder/conditions/DisplayConditionSection", () => ({
	DisplayConditionSection: () => <div>Display condition section</div>,
}));

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

afterEach(() => {
	vi.unstubAllGlobals();
	access.canEdit = true;
});

describe("ModuleSettingsButton", () => {
	it("opens a viewport-aware shadcn panel with comfortable header controls", async () => {
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		render(<ModuleSettingsButton moduleUuid={"module-1" as Uuid} />);

		const trigger = screen.getByRole("button", { name: "Module settings" });
		expect(trigger.getAttribute("data-slot")).toBe("popover-trigger");
		expect(trigger.className).toContain("size-11");
		fireEvent.click(trigger);

		const content = await waitFor(() => {
			const popup = document.querySelector('[data-slot="popover-content"]');
			expect(popup).not.toBeNull();
			return popup;
		});
		expect(content?.className).toContain("var(--available-height)");
		expect(content?.className).toContain("overflow-hidden");
		const title = screen.getByText("Module settings");
		// The retired console chrome was uppercase on WIDE tracking. Outfit's
		// own snug display tracking is the opposite of that and is expected.
		expect(title.className).not.toContain("uppercase");
		expect(title.className).not.toMatch(/tracking-(wide|wider|widest|etched)/);

		expect(screen.getByText("module deep link section")).toBeDefined();
		expect(screen.getByText("case-list deep link section")).toBeDefined();

		const close = screen.getByRole("button", {
			name: "Close module settings",
		});
		expect(close.getAttribute("data-slot")).toBe("button");
		expect(close.className).toContain("size-11");
		fireEvent.click(close);
		await waitFor(() =>
			expect(
				document.querySelector('[data-slot="popover-content"]'),
			).toBeNull(),
		);
	});

	it("does not expose module settings to a viewer", () => {
		access.canEdit = false;
		render(<ModuleSettingsButton moduleUuid={"module-1" as Uuid} />);
		expect(
			screen.queryByRole("button", { name: "Module settings" }),
		).toBeNull();
	});
});
