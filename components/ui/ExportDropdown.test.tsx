// @vitest-environment happy-dom

import tablerDownload from "@iconify-icons/tabler/download";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExportDropdown } from "./ExportDropdown";

vi.mock("@/components/shadcn/tooltip", () => ({
	SimpleTooltip: ({ children }: { children: ReactNode }) => children,
}));

function renderMenu(commcareConfigured: boolean, canUploadToHq = true) {
	const onCommCareUpload = vi.fn();
	const onDownload = vi.fn();
	render(
		<ExportDropdown
			commcareConfigured={commcareConfigured}
			canUploadToHq={canUploadToHq}
			onCommCareUpload={onCommCareUpload}
			options={[
				{
					label: "Mobile",
					description: "CCZ",
					icon: tablerDownload,
					onClick: onDownload,
				},
			]}
		/>,
	);
	return { onCommCareUpload, onDownload };
}

describe("ExportDropdown", () => {
	it("uses shared menu controls with roomy actions and closes after selection", () => {
		const { onCommCareUpload } = renderMenu(true);
		const trigger = screen.getByRole("button", { name: "Export" });
		expect(trigger.className).toContain("size-11");

		fireEvent.click(trigger);
		const menu = screen.getByRole("menu", { name: "Export" });
		expect(menu.getAttribute("data-slot")).toBe("dropdown-menu-content");
		const upload = screen.getByRole("menuitem", { name: /Upload app/ });
		expect(upload.className).toContain("min-h-14");

		fireEvent.click(upload);
		expect(onCommCareUpload).toHaveBeenCalledOnce();
		expect(screen.queryByRole("menu", { name: "Export" })).toBeNull();
	});

	it("offers one clear Settings action when direct upload is unavailable", async () => {
		renderMenu(false);
		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		const setup = await screen.findByRole("menuitem", {
			name: /Connect CommCare HQ/,
		});
		expect(setup.tagName).toBe("A");
		expect(setup.getAttribute("href")).toBe("/settings");
		expect(setup.className).toContain("min-h-14");
	});

	it("keeps downloads but omits every HQ write action for a viewer", () => {
		const { onCommCareUpload, onDownload } = renderMenu(true, false);
		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		expect(screen.queryByText("CommCare HQ")).toBeNull();
		expect(screen.queryByRole("menuitem", { name: /Upload app/ })).toBeNull();
		const download = screen.getByRole("menuitem", { name: /Mobile/ });
		fireEvent.click(download);
		expect(onDownload).toHaveBeenCalledOnce();
		expect(onCommCareUpload).not.toHaveBeenCalled();
	});
});
