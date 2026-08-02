// @vitest-environment happy-dom

import tablerDownload from "@iconify-icons/tabler/download";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { PublishMenu } from "./PublishMenu";

afterEach(async () => {
	await settleBaseUiTransitions();
});

function renderMenu(commcareConfigured: boolean, canUploadToHq = true) {
	const onCommCareUpload = vi.fn();
	const onDownload = vi.fn();
	render(
		<PublishMenu
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

describe("PublishMenu", () => {
	it("uses shared menu controls with roomy actions and closes after selection", () => {
		const { onCommCareUpload } = renderMenu(true);
		// The trigger NAMES the action. It used to be an unlabeled glyph, which
		// made the end of the whole build the one header control you had to
		// hover to identify.
		const trigger = screen.getByRole("button", { name: "Publish" });
		expect(trigger.textContent).toContain("Publish");

		fireEvent.click(trigger);
		const menu = screen.getByRole("menu", { name: "Publish" });
		expect(menu.getAttribute("data-slot")).toBe("dropdown-menu-content");
		const upload = screen.getByRole("menuitem", { name: /Upload app/ });
		expect(upload.className).toContain("min-h-14");

		fireEvent.click(upload);
		expect(onCommCareUpload).toHaveBeenCalledOnce();
		expect(screen.queryByRole("menu", { name: "Publish" })).toBeNull();
	});

	it("offers one clear Settings action when direct upload is unavailable", async () => {
		renderMenu(false);
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		const setup = await screen.findByRole("menuitem", {
			name: /Connect CommCare HQ/,
		});
		expect(setup.tagName).toBe("A");
		expect(setup.getAttribute("href")).toBe("/settings");
		expect(setup.className).toContain("min-h-14");
	});

	it("keeps downloads but omits every HQ write action for a viewer", () => {
		const { onCommCareUpload, onDownload } = renderMenu(true, false);
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		expect(screen.queryByText("CommCare HQ")).toBeNull();
		expect(screen.queryByRole("menuitem", { name: /Upload app/ })).toBeNull();
		const download = screen.getByRole("menuitem", { name: /Mobile/ });
		fireEvent.click(download);
		expect(onDownload).toHaveBeenCalledOnce();
		expect(onCommCareUpload).not.toHaveBeenCalled();
	});
});
