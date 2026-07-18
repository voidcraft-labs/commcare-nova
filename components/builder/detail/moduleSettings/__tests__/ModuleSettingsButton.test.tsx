// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import type { Uuid } from "@/lib/doc/types";

vi.mock(
	"@/components/builder/detail/moduleSettings/ModuleCaseTypeSection",
	() => ({ ModuleCaseTypeSection: () => <div>Case type section</div> }),
);
vi.mock(
	"@/components/builder/detail/moduleSettings/ModuleAppearanceSection",
	() => ({ ModuleAppearanceSection: () => <div>Appearance section</div> }),
);

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

afterEach(() => vi.unstubAllGlobals());

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
		expect(title.className).not.toContain("uppercase");
		expect(title.className).not.toContain("tracking-");

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
});
