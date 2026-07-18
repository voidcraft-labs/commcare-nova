// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SlotCardHeader } from "@/components/builder/shared/SlotCardHeader";

describe("SlotCardHeader", () => {
	it("keeps the disclosure interactive without nesting a heading in a button", () => {
		render(
			<SlotCardHeader
				title="Starting value"
				description="Choose what appears before someone enters an answer"
				collapse={{
					isOpen: false,
					onToggle: vi.fn(),
					expandLabel: "Open starting value",
					collapseLabel: "Close starting value",
					controlsId: "starting-value",
				}}
			/>,
		);

		const heading = screen.getByRole("heading", { name: "Starting value" });
		const toggle = screen.getByRole("button", {
			name: "Open starting value",
		});
		expect(heading.tagName).toBe("H3");
		expect(heading.contains(toggle)).toBe(true);
		expect(toggle.querySelector("h3")).toBeNull();
	});
});
