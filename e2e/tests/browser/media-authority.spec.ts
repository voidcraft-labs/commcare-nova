import type { Page } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/media-authority-client";

const imageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=",
	"base64",
);
const asset = {
	id: "019a0000-0000-7000-8000-000000000081",
	contentHash: "a".repeat(64),
	mimeType: "image/png",
	kind: "image",
	extension: ".png",
	sizeBytes: imageBytes.length,
	originalFilename: "workflow.png",
	status: "ready",
	createdAt: "2026-10-09T00:00:00Z",
};
const document = {
	...asset,
	id: "019a0000-0000-7000-8000-000000000082",
	mimeType: "application/pdf",
	kind: "pdf",
	extension: ".pdf",
	originalFilename: "protocol.pdf",
	extract: { status: "failed", version: 1, truncated: false, charCount: 0 },
};

async function mediaPeer(page: Page) {
	const peer = await componentPeer("e2e/lib/media-authority-client.tsx");
	try {
		await page.route("**/api/user/usage", (route) =>
			route.fulfill({
				json: {
					period: "2026-10",
					allowance: 1000,
					consumed: 0,
					bonus: 0,
					balance: 1000,
					lifetimeConsumed: 0,
				},
			}),
		);
		await page.route("**/api/media/library?*", (route) => {
			const kinds = new URL(route.request().url()).searchParams.getAll("kind");
			return route.fulfill({
				json: {
					assets: [asset, document].filter((row) => kinds.includes(row.kind)),
					nextCursor: null,
				},
			});
		});
		await page.route(`**/api/media/${asset.id}*`, (route) =>
			route.fulfill({ contentType: "image/png", body: imageBytes }),
		);
		await page.goto(peer.origin);
		await expect(
			page.getByRole("button", { name: "Project files" }),
		).toBeVisible();
	} catch (error) {
		await peer.close();
		throw error;
	}
	return async () => {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.mediaAuthorityAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	};
}

test("an unfinished editor can manage Project files and select for chat while app selection stays locked", async ({
	page,
}) => {
	const close = await mediaPeer(page);
	let extractions = 0;
	let deletions = 0;
	await page.route(`**/api/media/${document.id}`, (route) => {
		expect(route.request().method()).toBe("DELETE");
		deletions += 1;
		return route.fulfill({ status: 204 });
	});
	await page.route(`**/api/media/${document.id}/extract`, (route) => {
		extractions += 1;
		return route.fulfill({
			body: `${JSON.stringify({ type: "done", extract: { ...document.extract, status: "ready" } })}\n`,
		});
	});
	try {
		await page.evaluate(() => window.mediaAuthorityAudit.lock());
		await page.getByRole("button", { name: "Project files" }).click();
		const files = page.getByRole("dialog", { name: "Your files" });
		await expect(
			files.getByRole("tab", { name: "Upload", exact: true }),
		).toBeVisible();
		await expect(
			files.getByRole("button", { name: "Delete workflow.png" }),
		).toBeVisible();
		await files.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(files.getByText("Ready", { exact: true })).toBeVisible();
		expect(extractions).toBe(1);
		await files
			.getByRole("button", { name: "Preview protocol.pdf", exact: true })
			.hover();
		await files
			.getByRole("button", { name: "Delete protocol.pdf", exact: true })
			.click();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Delete", exact: true })
			.click();
		await expect(
			files.getByRole("button", { name: "Preview protocol.pdf", exact: true }),
		).toHaveCount(0);
		expect(deletions).toBe(1);
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await files.getByRole("button", { name: "Close", exact: true }).click();
		await expect(files).toHaveCount(0);

		await page.getByRole("button", { name: "App image", exact: true }).click();
		const appPicker = page.getByRole("dialog", { name: "Attach image" });
		await expect(
			appPicker.getByRole("tab", { name: "Upload", exact: true }),
		).toBeVisible();
		await appPicker.getByRole("tab", { name: "Library", exact: true }).click();
		await expect(
			appPicker.getByRole("button", { name: "Choose workflow.png" }),
		).toHaveCount(0);
		await expect(
			appPicker.getByRole("button", {
				name: "Preview workflow.png",
				exact: true,
			}),
		).toBeVisible();
		await page.keyboard.press("Escape");

		await page
			.getByRole("button", { name: "Attach a file", exact: true })
			.click();
		const chatPicker = page.getByRole("dialog", { name: "Attach media" });
		await chatPicker.getByRole("tab", { name: "Library", exact: true }).click();
		await chatPicker
			.getByRole("button", { name: "Choose workflow.png", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Send", exact: true }),
		).toBeDisabled();
		await page.getByRole("textbox").fill("Here it is!");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.mediaAuthorityAudit.messages()))
			.toEqual([
				{
					text: "Here it is!",
					attachments: [
						{
							assetId: asset.id,
							kind: "image",
							filename: asset.originalFilename,
							mimeType: asset.mimeType,
						},
					],
				},
			]);
		expect(
			await page.evaluate(() => window.mediaAuthorityAudit.selections()),
		).toEqual([]);

		// A supplied standalone permission cannot elevate a builder viewer.
		await page.evaluate(() => window.mediaAuthorityAudit.access(false));
		await page.getByRole("button", { name: "Project files" }).click();
		await expect(
			files.getByRole("tab", { name: "Upload", exact: true }),
		).toHaveCount(0);
		await expect(
			files.getByRole("button", { name: /Delete|Retry/ }),
		).toHaveCount(0);
		await expect(
			files.getByRole("button", { name: "Preview workflow.png", exact: true }),
		).toBeVisible();
		expect(extractions).toBe(1);
	} finally {
		await close();
	}
});

for (const startsLocked of [false, true]) {
	test(`an inline upload stays in the library across ${startsLocked ? "unlock" : "lock"}`, async ({
		page,
	}) => {
		const close = await mediaPeer(page);
		const confirm = Promise.withResolvers<void>();
		let initiated = false;
		await page.route("**/api/media/upload", async (route) => {
			initiated = true;
			await confirm.promise;
			await route.fulfill({
				json: { assetId: asset.id, deduplicated: true, asset },
			});
		});
		try {
			if (startsLocked)
				await page.evaluate(() => window.mediaAuthorityAudit.lock());
			await page
				.getByRole("button", { name: "App image", exact: true })
				.click();
			const picker = page.getByRole("dialog", { name: "Attach image" });
			await picker.locator('input[type="file"]').setInputFiles({
				name: asset.originalFilename,
				mimeType: asset.mimeType,
				buffer: imageBytes,
			});
			await expect.poll(() => initiated).toBe(true);
			await page.evaluate(
				(locked) =>
					locked
						? window.mediaAuthorityAudit.finish()
						: window.mediaAuthorityAudit.lock(),
				startsLocked,
			);
			await expect(
				picker.getByRole("button", { name: "Uploading", exact: true }),
			).toBeDisabled();
			confirm.resolve();
			await expect(
				picker.getByRole("tab", { name: "Library", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await expect(
				picker.getByRole("button", {
					name: startsLocked ? "Choose workflow.png" : "Preview workflow.png",
					exact: true,
				}),
			).toBeVisible();
			expect(
				await page.evaluate(() => window.mediaAuthorityAudit.selections()),
			).toEqual([]);
			await page.evaluate(() => window.mediaAuthorityAudit.finish());
			await expect(
				picker.getByRole("button", {
					name: "Choose workflow.png",
					exact: true,
				}),
			).toBeVisible();
			expect(
				await page.evaluate(() => window.mediaAuthorityAudit.selections()),
			).toEqual([]);
		} finally {
			confirm.resolve();
			await page.unrouteAll({ behavior: "wait" });
			await close();
		}
	});
}

test("Project access changes retire an upload and reject its late completion", async ({
	page,
}) => {
	const close = await mediaPeer(page);
	const confirm = Promise.withResolvers<void>();
	let initiated = false;
	await page.route("**/api/media/upload", async (route) => {
		initiated = true;
		await confirm.promise;
		await route.fulfill({
			json: { assetId: asset.id, deduplicated: true, asset },
		});
	});
	try {
		await page.evaluate(() => window.mediaAuthorityAudit.lock());
		await page
			.getByRole("button", { name: "Attach a file", exact: true })
			.click();
		const picker = page.getByRole("dialog", { name: "Attach media" });
		await picker.locator('input[type="file"]').setInputFiles({
			name: asset.originalFilename,
			mimeType: asset.mimeType,
			buffer: imageBytes,
		});
		await expect.poll(() => initiated).toBe(true);
		await page.evaluate(() => window.mediaAuthorityAudit.refresh());
		await expect(picker).toHaveCount(0);
		await page.evaluate(() => window.mediaAuthorityAudit.reconnecting());
		await expect(picker).toHaveCount(0);
		confirm.resolve();
		await page.evaluate(() =>
			window.mediaAuthorityAudit.access(true, "destination-project"),
		);
		await expect(
			page.getByRole("button", { name: "Remove workflow.png" }),
		).toHaveCount(0);
		expect(
			await page.evaluate(() => window.mediaAuthorityAudit.messages()),
		).toEqual([]);
		await page.getByRole("button", { name: "Project files" }).click();
		const files = page.getByRole("dialog", { name: "Your files" });
		await expect(
			files.getByRole("tab", { name: "Upload", exact: true }),
		).toBeVisible();
		await page.evaluate(() => window.mediaAuthorityAudit.revoke());
		await expect(files).toHaveCount(0);
	} finally {
		confirm.resolve();
		await page.unrouteAll({ behavior: "wait" });
		await close();
	}
});
