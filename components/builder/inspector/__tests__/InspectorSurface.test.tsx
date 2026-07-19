// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InspectorSurface } from "@/components/builder/inspector/InspectorSurface";
import { InspectorProvider, useInspectorContext } from "@/lib/ui/inspector";

function RailTarget() {
	const { setPortalEl } = useInspectorContext();
	return <div data-testid="rail-target" ref={setPortalEl} />;
}

describe("InspectorSurface", () => {
	it("bounds long authored names within the shared secondary-header band", async () => {
		const kicker =
			"Search information used by a particularly detailed follow-up workflow";
		const title =
			"A complete authored label that should remain readable in the properties rail";

		render(
			<InspectorProvider>
				<RailTarget />
				<InspectorSurface kicker={kicker} title={title} onClose={() => {}}>
					<section>
						<h3>Formatting</h3>
						<div>Properties</div>
					</section>
				</InspectorSurface>
			</InspectorProvider>,
		);

		const titleElement = await screen.findByText(title);
		const inspector = screen.getByRole("complementary", { name: title });
		const kickerElement = screen.getByText(kicker);
		const header = titleElement.closest(
			'[data-builder-secondary-header="inspector"]',
		);

		expect(titleElement.className).toContain("truncate");
		expect(titleElement.tagName).toBe("H2");
		expect(inspector.getAttribute("aria-labelledby")).toBe(titleElement.id);
		expect(
			screen.getByRole("heading", { level: 3, name: "Formatting" }),
		).toBeTruthy();
		expect(kickerElement.className).toContain("truncate");
		expect(titleElement.getAttribute("title")).toBeNull();
		expect(kickerElement.getAttribute("title")).toBeNull();
		const identity = document.querySelector<HTMLElement>(
			"[data-inspector-identity]",
		);
		expect(identity).not.toBeNull();
		expect(identity?.tabIndex).toBe(-1);
		expect(identity?.className).toContain("min-h-11");
		expect(
			screen.queryByRole("button", { name: /Show full selection name/i }),
		).toBeNull();
		expect(header?.className.split(" ")).toContain("h-16");
		expect(header?.className).not.toContain("min-h-16");
		expect(header?.className).not.toContain("py-3");
		const close = screen.getByRole("button", { name: "Close properties" });
		expect(close.className).toContain("size-11");
		expect(close.getAttribute("aria-keyshortcuts")).toBe("Escape");
	});
});
