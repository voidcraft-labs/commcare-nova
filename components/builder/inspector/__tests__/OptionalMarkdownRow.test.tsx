// @vitest-environment happy-dom

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OptionalMarkdownRow } from "../OptionalMarkdownRow";

async function renderRow(value = "Hello") {
	const onCommit = vi.fn();
	render(
		<OptionalMarkdownRow
			label="Subtitle"
			hint="Shown below the title"
			value={value}
			onCommit={onCommit}
		/>,
	);
	const toolbar = await screen.findByRole("toolbar", {
		name: "Subtitle formatting",
	});
	return { toolbar, onCommit };
}

function openMoreFormatting() {
	fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
}

describe("OptionalMarkdownRow", () => {
	it("keeps common formatting visible without a scrolling toolbar", async () => {
		const { toolbar } = await renderRow();
		const controls = within(toolbar);

		expect(toolbar.getAttribute("data-variant")).toBe("floating");
		expect(toolbar.className).toContain("overflow-hidden");
		expect(controls.getByRole("button", { name: "Bold" })).toBeDefined();
		expect(controls.getByRole("button", { name: "Italic" })).toBeDefined();
		expect(controls.getByRole("button", { name: "Link" })).toBeDefined();
		expect(
			controls.getByRole("button", { name: "More formatting" }),
		).toBeDefined();
		expect(screen.queryByText("Inline code")).toBeNull();

		for (const control of controls.getAllByRole("button")) {
			expect(control.className).toContain("min-h-11");
		}
	});

	it("keeps every less common formatting family behind one named menu", async () => {
		await renderRow();
		openMoreFormatting();

		for (const label of [
			"Headings",
			"Lists",
			"Inline code",
			"Code block",
			"Image",
			"Table",
			"Divider",
		]) {
			expect(await screen.findByText(label)).toBeDefined();
		}

		const headings = screen.getByRole("menuitem", { name: "Headings" });
		fireEvent.click(headings);
		const headingOne = (await screen.findByText("Heading 1")).closest(
			'[data-slot="dropdown-menu-checkbox-item"]',
		);
		expect(headingOne?.className).toContain("rounded-lg");
		const submenu = headingOne?.closest(
			'[data-slot="dropdown-menu-sub-content"]',
		);
		expect(submenu?.className).toContain("p-1");
		expect(
			submenu
				?.closest('[data-slot="dropdown-menu-positioner"]')
				?.getAttribute("style"),
		).toContain("--available-width");
		expect(screen.getByText("Heading 2")).toBeDefined();
		expect(screen.getByText("Heading 3")).toBeDefined();
	});

	it("inserts an accessible image from the disclosed action", async () => {
		await renderRow();
		openMoreFormatting();
		fireEvent.click(await screen.findByRole("menuitem", { name: "Image" }));

		expect(
			await screen.findByRole("heading", { name: "Insert image" }),
		).toBeDefined();
		const url = screen.getByLabelText("Image address");
		const alt = screen.getByLabelText("Image description");
		expect(url.className).toContain("min-h-11");
		expect(alt.className).toContain("min-h-11");

		fireEvent.change(url, {
			target: { value: "https://example.com/client.png" },
		});
		fireEvent.change(alt, { target: { value: "Client profile" } });
		fireEvent.click(screen.getByRole("button", { name: "Insert" }));

		await waitFor(() => {
			expect(
				screen.queryByRole("heading", { name: "Insert image" }),
			).toBeNull();
		});
		const image = document.querySelector<HTMLImageElement>(
			'img[src="https://example.com/client.png"]',
		);
		expect(image?.alt).toBe("Client profile");
	});

	it("preserves the table size choice behind the disclosed action", async () => {
		await renderRow();
		openMoreFormatting();
		fireEvent.click(await screen.findByRole("menuitem", { name: "Table" }));

		expect(
			await screen.findByRole("heading", { name: "Insert table" }),
		).toBeDefined();
		fireEvent.change(screen.getByLabelText("Rows"), {
			target: { value: "2" },
		});
		fireEvent.change(screen.getByLabelText("Columns"), {
			target: { value: "2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Insert" }));

		await waitFor(() => {
			expect(
				screen.queryByRole("heading", { name: "Insert table" }),
			).toBeNull();
		});
		const table = document.querySelector("table");
		expect(table?.querySelectorAll("tr")).toHaveLength(2);
		expect(table?.querySelectorAll("th, td")).toHaveLength(4);
		/* TipTap restores the editor selection on the next animation frame after
		 * inserting a block. Let that documented focus handoff finish before the
		 * leak detector tears down this test. */
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
});
