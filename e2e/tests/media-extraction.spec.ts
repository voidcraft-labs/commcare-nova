import { expect, test } from "../lib/fixtures";

test("a failed document retries through the file manager and keeps its completed metadata on reopen", async ({
	page,
}) => {
	const assetId = "019a0000-0000-7000-8000-000000000001";
	let extract = {
		status: "failed",
		version: 1,
		truncated: false,
		charCount: 0,
		title: "",
	};
	let requests = 0;
	const completed = Promise.withResolvers<void>();
	await page.route("**/api/media/library?*", (route) =>
		route.fulfill({
			json: {
				assets: [
					{
						id: assetId,
						contentHash: "a".repeat(64),
						mimeType: "application/pdf",
						kind: "pdf",
						extension: ".pdf",
						sizeBytes: 1234,
						originalFilename: "Protocol.pdf",
						status: "ready",
						createdAt: "2026-09-05T00:00:00Z",
						extract,
					},
				],
				nextCursor: null,
			},
		}),
	);
	await page.route(`**/api/media/${assetId}/extract`, async (route) => {
		expect(route.request().method()).toBe("POST");
		requests += 1;
		await completed.promise;
		extract = {
			status: "ready",
			version: 1,
			truncated: false,
			charCount: 12,
			title: "Household visit protocol",
		};
		await route.fulfill({
			contentType: "application/x-ndjson",
			body: `${JSON.stringify({ type: "done", extract })}\n`,
		});
	});
	try {
		await page.goto("/");
		await page.getByRole("button", { name: "Account menu" }).click();
		await page.getByRole("button", { name: "Files", exact: true }).click();
		const files = page.getByRole("dialog", { name: "Your files" });
		const retry = files.getByRole("button", { name: "Retry", exact: true });
		await expect(retry).toBeVisible();
		expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		expect(requests).toBe(0);
		await retry.click();
		await expect(files.getByText("Reading", { exact: true })).toBeVisible();
		completed.resolve();
		await expect(files.getByText("Ready", { exact: true })).toBeVisible();
		await expect(
			files.getByText("Household visit protocol", { exact: true }),
		).toBeVisible();
		const info = files.getByRole("button", {
			name: "What does Nova read from a document?",
		});
		expect((await info.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		await info.click();
		await expect(
			page.getByRole("heading", { name: "What Nova reads", exact: true }),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await expect(files).not.toBeVisible();
		await page.getByRole("button", { name: "Account menu" }).click();
		await page.getByRole("button", { name: "Files", exact: true }).click();
		await expect(files.getByText("Ready", { exact: true })).toBeVisible();
		expect(requests).toBe(1);
	} finally {
		completed.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});
