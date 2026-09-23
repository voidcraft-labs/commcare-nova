import { resolve } from "node:path";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import { selectedRow } from "../../lib/preview-selected-entry-boundary";
import type {} from "../../lib/preview-selected-entry-client";

test("Selected record arrives before one-time query rows are initialized", async ({
	page,
}) => {
	const peer = await selectedEntryPeer();
	let release: () => void = () => {};
	let selected = new Promise<void>((resolve) => {
		release = resolve;
	});
	let replies = 0;
	await page.route(`${peer.origin}/selected-record`, async (route) => {
		await selected;
		await route.fulfill({
			json: { kind: "row", row: selectedRow, ancestors: [] },
		});
		replies++;
	});
	try {
		await Promise.all([
			page.waitForRequest(`${peer.origin}/selected-record`),
			page.goto(peer.origin),
		]);
		await expect(
			page.getByRole("button", { name: "Submit", exact: true }),
		).toBeDisabled();
		release();
		const note = page.getByRole("textbox", { name: /Inspection note/ });
		await expect(note).toHaveCount(1);
		await expect(note).toHaveValue("selected-room");
		await expect(page.getByRole("textbox", { name: /Room name/ })).toHaveValue(
			"Store room",
		);
		await note.fill("Checked the shelves");
		await expect(note).toHaveValue("Checked the shelves");
		selected = new Promise<void>((resolve) => {
			release = resolve;
		});
		await Promise.all([
			page.waitForRequest(`${peer.origin}/selected-record`),
			page.getByRole("button", { name: "Refresh record", exact: true }).click(),
		]);
		await expect(note).toHaveValue("Checked the shelves");
		release();
		await expect.poll(() => replies).toBe(2);
		await expect(note).toHaveValue("Checked the shelves");

		await expect(
			page.getByRole("button", { name: "Submit", exact: true }),
		).toBeEnabled();
	} finally {
		release();
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.selectedEntryAudit?.dispose());
		} finally {
			await page.close();
			await peer.close();
		}
	}
});

async function selectedEntryPeer() {
	const boundary = resolve("e2e/lib/preview-selected-entry-boundary.ts");
	return componentPeer("e2e/lib/preview-selected-entry-client.tsx", [], {
		"@/lib/preview/engine/caseDataBinding": boundary,
		"@/lib/preview/engine/lookupDataBinding": boundary,
		"@/lib/preview/entryPointLaunchAction": boundary,
		"@/lib/auth/hooks/useAuth": boundary,
		"@/lib/lookup/actions": boundary,
	});
}

for (const entry of ["blank", "empty"]) {
	test(`No pending form initialization for ${entry} record selection`, async ({
		page,
	}) => {
		const peer = await selectedEntryPeer();
		try {
			await page.goto(`${peer.origin}/?entry=${entry}`);
			await expect(
				page.getByRole("heading", { name: "No record selected" }),
			).toBeVisible();
			await expect(
				page.getByText("This form is getting ready.", { exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByRole("textbox", { name: /Inspection note/ }),
			).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: "Submit", exact: true }),
			).toHaveCount(0);
			await page
				.getByRole("button", { name: "Go to Results", exact: true })
				.click();
			await expect(page).toHaveURL(/\/results$/);
		} finally {
			try {
				if (!page.isClosed())
					await page.evaluate(() => window.selectedEntryAudit?.dispose());
			} finally {
				await page.close();
				await peer.close();
			}
		}
	});
}
