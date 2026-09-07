import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { Pool } from "pg";
import { expect, test } from "../lib/fixtures";

const imageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=",
	"base64",
);
// A real mono PCM WAV lets Chromium decode and retire native playback.
const audioBytes = Buffer.alloc(44 + 16000);
audioBytes.write("RIFF", 0);
audioBytes.writeUInt32LE(audioBytes.length - 8, 4);
audioBytes.write("WAVEfmt ", 8);
audioBytes.writeUInt32LE(16, 16);
audioBytes.writeUInt16LE(1, 20);
audioBytes.writeUInt16LE(1, 22);
audioBytes.writeUInt32LE(8000, 24);
audioBytes.writeUInt32LE(16000, 28);
audioBytes.writeUInt16LE(2, 32);
audioBytes.writeUInt16LE(16, 34);
audioBytes.write("data", 36);
audioBytes.writeUInt32LE(16000, 40);
const audioId = "019a0000-0000-7000-8000-000000000022";
const assetId = "019a0000-0000-7000-8000-000000000020";
const asset = {
	id: assetId,
	contentHash: "a".repeat(64),
	mimeType: "image/png",
	kind: "image",
	extension: ".png",
	sizeBytes: imageBytes.length,
	originalFilename: "client-photo.png",
	status: "ready",
	createdAt: "2026-09-05T00:00:00Z",
};
async function expectTouchTarget(control: Locator) {
	await expect
		.poll(async () => Math.round((await control.boundingBox())?.height ?? 0))
		.toBeGreaterThanOrEqual(44);
}
async function openFiles(page: Page) {
	await page.getByRole("button", { name: "Account menu" }).click();
	await page.getByRole("button", { name: "Files", exact: true }).click();
	return page.getByRole("dialog", { name: "Your files" });
}
async function imageRoute(page: Page) {
	await page.route(`**/api/media/${assetId}*`, (route) =>
		route.fulfill({ contentType: "image/png", body: imageBytes }),
	);
}
function seed(): { openAppId: string; viewerUserId: string } {
	return JSON.parse(readFileSync("e2e/.auth/seed.json", "utf8"));
}

test.describe("touch file manager", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
	test("uploads from the empty-state action, waits for confirmation, previews, and deletes only after confirmation", async ({
		page,
	}) => {
		let assets: (typeof asset)[] = [];
		const calls: string[] = [];
		const confirm = Promise.withResolvers<void>();
		await page.route("**/api/media/library?*", (route) =>
			route.fulfill({ json: { assets, nextCursor: null } }),
		);
		await page.route("**/api/media/upload", (route) => {
			calls.push("initiate");
			expect(route.request().postDataJSON()).toMatchObject({
				filename: asset.originalFilename,
				mimeType: "image/png",
				sizeBytes: imageBytes.length,
			});
			return route.fulfill({
				json: {
					assetId,
					deduplicated: false,
					uploadUrl: `${new URL(route.request().url()).origin}/test-upload-bytes`,
					uploadContentType: "image/png",
				},
			});
		});
		await page.route("**/test-upload-bytes", (route) => {
			calls.push("bytes");
			expect(route.request().postDataBuffer()).toEqual(imageBytes);
			return route.fulfill({ status: 200 });
		});
		await page.route(
			`**/api/media/upload/${assetId}/confirm`,
			async (route) => {
				calls.push("confirm");
				await confirm.promise;
				assets = [asset];
				return route.fulfill({ json: { ok: true, asset } });
			},
		);
		await page.route(`**/api/media/${assetId}*`, (route) => {
			if (route.request().method() === "DELETE") {
				calls.push("delete");
				assets = [];
				return route.fulfill({ status: 204 });
			}
			return route.fulfill({ contentType: "image/png", body: imageBytes });
		});
		const profileName =
			"A deliberately long account name that must remain readable";
		const profileEmail =
			"a-deliberately-long-address-without-breaks@example.dimagi.com";
		await page.route("**/api/auth/get-session", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			return route.fulfill({
				response,
				json: {
					...body,
					user: { ...body.user, name: profileName, email: profileEmail },
				},
			});
		});

		try {
			await page.goto("/");

			const accountTrigger = page.getByRole("button", { name: "Account menu" });
			await accountTrigger.tap();
			const account = page.getByRole("dialog", {
				name: "Account",
				exact: true,
			});
			for (const value of [profileName, profileEmail]) {
				const text = account.getByText(value, { exact: true });
				await expect(text).toBeVisible();
				expect(
					await text.evaluate(
						(element) => element.scrollWidth <= element.clientWidth,
					),
				).toBe(true);
			}
			for (const control of [
				accountTrigger,
				account.getByRole("button", { name: "Files", exact: true }),
				account.getByRole("link", { name: "Settings", exact: true }),
				account.getByRole("button", { name: "Sign out", exact: true }),
			])
				await expectTouchTarget(control);
			await account.getByRole("button", { name: "Files", exact: true }).tap();
			const files = page.getByRole("dialog", { name: "Your files" });
			await expect(
				files.getByText("No files yet", { exact: true }),
			).toBeVisible();
			await files
				.getByRole("button", { name: "Upload file", exact: true })
				.tap();
			const chooser = page.waitForEvent("filechooser");
			await files
				.getByRole("button", { name: "Choose file", exact: true })
				.tap();
			await (await chooser).setFiles({
				name: asset.originalFilename,
				mimeType: "image/png",
				buffer: imageBytes,
			});
			await expect(
				files.getByRole("button", { name: "Uploading", exact: true }),
			).toBeDisabled();
			await expect.poll(() => calls).toEqual(["initiate", "bytes", "confirm"]);
			expect(assets).toEqual([]);
			confirm.resolve();
			const preview = files.getByRole("button", {
				name: `Preview ${asset.originalFilename}`,
				exact: true,
			});
			await expect(preview).toBeVisible();
			await preview.tap();
			await expect(
				page.getByRole("dialog", { name: asset.originalFilename, exact: true }),
			).toBeVisible();
			await page.keyboard.press("Escape");
			const remove = files.getByRole("button", {
				name: `Delete ${asset.originalFilename}`,
				exact: true,
			});
			await expect(remove).toHaveCSS("opacity", "1");
			await expectTouchTarget(remove);
			await remove.tap();
			const confirmation = page.getByRole("alertdialog", {
				name: "This file will be deleted",
			});
			await confirmation
				.getByRole("button", { name: "Cancel", exact: true })
				.tap();
			await expect(confirmation).not.toBeVisible();
			expect(calls).not.toContain("delete");
			await remove.tap();
			await confirmation
				.getByRole("button", { name: "Delete", exact: true })
				.tap();
			await expect(
				files.getByText("No files yet", { exact: true }),
			).toBeVisible();
			expect(calls).toEqual(["initiate", "bytes", "confirm", "delete"]);
			assets = [asset];
			await page.goto("/build/new");
			await page
				.getByRole("button", { name: "Attach a file", exact: true })
				.tap();
			const picker = page.getByRole("dialog", {
				name: "Attach media",
				exact: true,
			});
			await picker.getByRole("tab", { name: "Library", exact: true }).tap();
			const previewAction = picker.getByRole("button", {
				name: `Preview ${asset.originalFilename}`,
				exact: true,
			});
			await expect(previewAction).toHaveCSS("opacity", "1");
			await expectTouchTarget(previewAction);
			await previewAction.tap();
			await expect(
				page.getByRole("dialog", { name: asset.originalFilename, exact: true }),
			).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(
				picker.getByRole("button", {
					name: `Choose ${asset.originalFilename}`,
					exact: true,
				}),
			).toBeVisible();
		} finally {
			confirm.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
	});
});

test("search and pagination use server results; full document names disclose on keyboard focus and icons remain legible", async ({
	page,
}) => {
	const filename =
		"community-maternal-and-child-health-referral-plan-for-every-district.docx";
	const title =
		"Community maternal and child health referral plan for every district";
	const document = {
		...asset,
		kind: "docx",
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		extension: ".docx",
		originalFilename: filename,
		extract: {
			status: "ready",
			version: 1,
			truncated: false,
			charCount: 300,
			title,
		},
	};
	const searches: string[] = [];
	let refuse = true;
	await page.route("**/api/media/library?*", (route) => {
		const query = new URL(route.request().url()).searchParams;
		const search = query.get("q") ?? "";
		searches.push(search);
		if (refuse) {
			refuse = false;
			return route.fulfill({
				status: 403,
				json: { error: "Your files aren't available" },
			});
		}
		return route.fulfill({
			json: search
				? {
						assets: query.has("cursor")
							? [
									{
										...asset,
										id: "019a0000-0000-7000-8000-000000000021",
										originalFilename: "older-client-plan.png",
									},
								]
							: [document],
						nextCursor: query.has("cursor") ? null : "matched-next",
					}
				: { assets: [], nextCursor: null },
		});
	});
	await page.route(
		"**/api/media/019a0000-0000-7000-8000-000000000021",
		(route) => route.fulfill({ contentType: "image/png", body: imageBytes }),
	);
	let extractReads = 0;
	await page.route(`**/api/media/${assetId}/extract`, (route) => {
		extractReads += 1;
		return extractReads === 1
			? route.fulfill({
					status: 403,
					json: { error: "What Nova reads isn't available" },
				})
			: route.fulfill({
					body: "Recovered information",
					contentType: "text/plain",
				});
	});

	await page.goto("/");
	const files = await openFiles(page);
	await expect(
		files.getByText("Your files aren't available", { exact: true }),
	).toBeVisible();
	await files.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(files.getByText("No files yet", { exact: true })).toBeVisible();
	await files
		.getByRole("searchbox", { name: "Search files" })
		.fill(" client plan ");
	const preview = files.getByRole("button", {
		name: `Preview ${title}, file ${filename}`,
		exact: true,
	});
	await expect(preview).toBeVisible();
	await page.keyboard.press("Tab");
	await expect(preview).toBeFocused();
	const tooltip = page.getByRole("tooltip");
	await expect(tooltip.getByText(filename, { exact: true })).toBeVisible();
	await expect(tooltip.getByText(title, { exact: true })).toBeVisible();
	await files.getByRole("button", { name: "Load more", exact: true }).click();
	await expect(
		files.getByRole("button", {
			name: "Preview older-client-plan.png",
			exact: true,
		}),
	).toBeVisible();
	await expect(preview).toBeVisible();
	expect(searches.slice(-2)).toEqual(["client plan", "client plan"]);
	await preview.click();
	const documentPreview = page.getByRole("dialog", {
		name: title,
		exact: true,
	});
	await expect(
		documentPreview.getByText("What Nova reads couldn't be loaded", {
			exact: true,
		}),
	).toBeVisible();
	await documentPreview
		.getByRole("button", { name: "Retry", exact: true })
		.click();
	await expect(
		documentPreview.getByText("Recovered information", { exact: true }),
	).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	for (const value of [title, filename]) {
		const text = documentPreview.getByText(value, { exact: true });
		await expect(text).toBeVisible();
		expect(
			await text.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
	}
	const close = documentPreview.getByRole("button", {
		name: "Close",
		exact: true,
	});
	const info = documentPreview.getByRole("button", {
		name: "What does Nova read from a document?",
	});
	for (const control of [close, info]) await expectTouchTarget(control);
	await info.click();
	await expect(
		page.getByRole("heading", { name: "What Nova reads", exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await documentPreview
		.getByRole("tab", { name: "Document", exact: true })
		.click();
	const download = documentPreview.getByRole("button", {
		name: "Download original",
		exact: true,
	});
	await expectTouchTarget(download);
	const downloaded = page.waitForEvent("download");
	await download.click();
	const original = await downloaded;
	expect(original.suggestedFilename()).toBe(filename);
	// Chromium's download request bypasses Playwright routing. Check the native
	// download intent here; storage bytes are owned by the server contract tests.
	expect(new URL(original.url()).pathname).toBe(`/api/media/${assetId}`);
	expect(new URL(original.url()).searchParams.has("scope")).toBe(true);
	await original.cancel();
	await close.click();

	await files.getByRole("tab", { name: "Icons", exact: true }).click();
	await files.getByRole("searchbox", { name: "Search icons" }).fill("maternal");
	const icon = files.getByRole("button", { name: /Preview/ }).first();
	await expect(icon).toBeVisible();
	const label = icon.locator("..").locator("p");
	expect(
		await label.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true);
	await icon.click();
	await expect(page.getByRole("dialog").last()).toBeVisible();
	await page.keyboard.press("Escape");
});

test("a live editor-to-viewer change closes pending deletion and reopens the file manager with preview access", async ({
	page,
	context,
}) => {
	const fixture = seed();
	const pool = new Pool({ connectionString: process.env.NOVA_DB_LOCAL_URL });
	const member = await pool.query<{ id: string; role: string }>(
		'SELECT m.id, m.role FROM auth_member m JOIN apps a ON a.project_id = m."organizationId" WHERE a.id = $1 AND m."userId" = $2',
		[fixture.openAppId, fixture.viewerUserId],
	);
	const membership = member.rows[0];
	if (!membership) {
		await pool.end();
		throw new Error("Missing seeded viewer membership");
	}

	let deletes = 0;
	const libraryAppIds: (string | null)[] = [];
	const audioAsset = {
		...asset,
		id: audioId,
		kind: "audio",
		mimeType: "audio/wav",
		extension: ".wav",
		originalFilename: "visit.wav",
		sizeBytes: audioBytes.length,
	};
	await page.route("**/api/media/library?*", (route) => {
		libraryAppIds.push(
			new URL(route.request().url()).searchParams.get("appId"),
		);
		return route.fulfill({
			json: { assets: [asset, audioAsset], nextCursor: null },
		});
	});
	await page.route(`**/api/media/${audioId}*`, (route) =>
		route.fulfill({ contentType: "audio/wav", body: audioBytes }),
	);
	await page.route(`**/api/media/${assetId}*`, (route) => {
		if (route.request().method() === "DELETE") {
			deletes += 1;
			return route.fulfill({ status: 204 });
		}
		return route.fulfill({ contentType: "image/png", body: imageBytes });
	});
	try {
		await pool.query("UPDATE auth_member SET role = 'editor' WHERE id = $1", [
			membership.id,
		]);
		const viewer = JSON.parse(
			readFileSync("e2e/.auth/state-viewer.json", "utf8"),
		) as { cookies: Parameters<typeof context.addCookies>[0] };
		await context.addCookies(viewer.cookies);
		await page.goto(`/build/${fixture.openAppId}`);
		const files = await openFiles(page);
		const pixels = files.getByRole("img", {
			name: asset.originalFilename,
			exact: true,
		});
		await expect
			.poll(() =>
				pixels.evaluate(
					(element) => (element as HTMLImageElement).naturalWidth,
				),
			)
			.toBe(1);
		const sourceImage = await pixels.elementHandle();
		if (!sourceImage) throw new Error("Image has no node");
		const sourceUrl = await sourceImage.getAttribute("src");

		await files
			.getByRole("button", {
				name: `Preview ${asset.originalFilename}`,
				exact: true,
			})
			.hover();

		await files
			.getByRole("button", {
				name: `Delete ${asset.originalFilename}`,
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("alertdialog", { name: "This file will be deleted" }),
		).toBeVisible();
		await pool.query("UPDATE auth_member SET role = 'viewer' WHERE id = $1", [
			membership.id,
		]);
		await expect(
			page.getByRole("alertdialog", { name: "This file will be deleted" }),
		).toHaveCount(0, { timeout: 20_000 });
		await expect(files).toHaveCount(0);

		expect(await sourceImage.getAttribute("src")).toBeNull();
		const readonly = await openFiles(page);
		await expect(
			readonly.getByRole("button", {
				name: `Preview ${asset.originalFilename}`,
				exact: true,
			}),
		).toBeVisible();
		await expect(
			readonly.getByRole("tab", { name: "Upload", exact: true }),
		).toHaveCount(0);
		await expect(
			readonly.getByRole("button", {
				name: `Delete ${asset.originalFilename}`,
				exact: true,
			}),
		).toHaveCount(0);
		const renewedPixels = readonly.getByRole("img", {
			name: asset.originalFilename,
			exact: true,
		});
		await expect
			.poll(() =>
				renewedPixels.evaluate(
					(element) => (element as HTMLImageElement).naturalWidth,
				),
			)
			.toBe(1);
		expect(await renewedPixels.getAttribute("src")).not.toBe(sourceUrl);
		await readonly
			.getByRole("button", { name: "Preview visit.wav", exact: true })
			.click();
		const audio = page
			.getByRole("dialog", { name: "visit.wav", exact: true })
			.locator("audio");
		await audio.evaluate(async (element) => {
			if (!(element instanceof HTMLAudioElement))
				throw new Error("Expected native audio");
			element.loop = true;
			await element.play();
		});
		const sourceAudio = await audio.evaluateHandle((element) => {
			if (!(element instanceof HTMLAudioElement))
				throw new Error("Expected native audio");
			return element;
		});
		if (!sourceAudio) throw new Error("Audio has no node");
		expect(await sourceAudio.evaluate((element) => element.paused)).toBe(false);
		await pool.query("UPDATE auth_member SET role = 'editor' WHERE id = $1", [
			membership.id,
		]);
		await expect(
			page.getByRole("dialog", { name: "visit.wav", exact: true }),
		).toHaveCount(0, { timeout: 20_000 });
		await expect(readonly).toHaveCount(0);
		expect(
			await sourceAudio.evaluate((element) => ({
				src: element.getAttribute("src"),
				paused: element.paused,
				ready: element.readyState,
			})),
		).toEqual({ src: null, paused: true, ready: 0 });
		const writable = await openFiles(page);
		await expect(
			writable.getByRole("tab", { name: "Upload", exact: true }),
		).toBeVisible();
		expect(libraryAppIds.length).toBeGreaterThanOrEqual(3);
		expect(libraryAppIds.every((id) => id === fixture.openAppId)).toBe(true);
		await sourceImage.dispose();
		await sourceAudio.dispose();

		expect(deletes).toBe(0);
	} finally {
		try {
			await page.close();
		} finally {
			try {
				await pool.query("UPDATE auth_member SET role = $1 WHERE id = $2", [
					membership.role,
					membership.id,
				]);
			} finally {
				await pool.end();
			}
		}
	}
});

test("a staged app-logo upload exposes progress and cancels without attaching a pending file", async ({
	page,
}) => {
	const fixture = seed();
	const initiate = Promise.withResolvers<void>();
	let transfers = 0;
	await page.route("**/api/media/library?*", (route) =>
		route.fulfill({ json: { assets: [], nextCursor: null } }),
	);
	await page.route("**/api/media/upload", async (route) => {
		await initiate.promise;
		return route.fulfill({ json: { deduplicated: true, asset } });
	});
	await imageRoute(page);
	page.on("request", (request) => {
		if (request.method() === "PUT" || request.url().endsWith("/confirm"))
			transfers += 1;
	});
	try {
		await page.goto(`/build/${fixture.openAppId}`);
		await page
			.getByRole("button", { name: "App settings", exact: true })
			.click();
		const logo = page.getByRole("group", { name: "App logo", exact: true });
		await logo.getByRole("button", { name: "Attach", exact: true }).click();
		const picker = page.getByRole("dialog", {
			name: "Attach image",
			exact: true,
		});
		const chooser = page.waitForEvent("filechooser");
		await picker
			.getByRole("button", { name: "Choose file", exact: true })
			.click();
		await (await chooser).setFiles({
			name: asset.originalFilename,
			mimeType: "image/png",
			buffer: imageBytes,
		});
		await expect(picker).not.toBeVisible();
		await expect(
			logo.getByRole("progressbar", {
				name: `Uploading ${asset.originalFilename}`,
			}),
		).toHaveAttribute("aria-valuenow", "0");
		await logo
			.getByRole("button", {
				name: `Cancel upload of ${asset.originalFilename}`,
			})
			.click();
		initiate.resolve();
		await expect(
			logo.getByRole("button", { name: "Attach", exact: true }),
		).toBeVisible();
		await expect(logo.getByRole("progressbar")).toHaveCount(0);
		await page.reload();
		await page
			.getByRole("button", { name: "App settings", exact: true })
			.click();
		await expect(
			logo.getByRole("button", { name: "Attach", exact: true }),
		).toBeVisible();
		await page.unroute("**/api/media/upload");
		const message =
			"This file is too large. Choose an image smaller than 5 MB, then try again.";
		await page.route("**/api/media/upload", (route) =>
			route.fulfill({ status: 413, json: { error: message } }),
		);
		await logo.getByRole("button", { name: "Attach", exact: true }).click();
		const secondChooser = page.waitForEvent("filechooser");
		await picker
			.getByRole("button", { name: "Choose file", exact: true })
			.click();
		await (await secondChooser).setFiles({
			name: asset.originalFilename,
			mimeType: "image/png",
			buffer: imageBytes,
		});
		const alert = logo.getByRole("alert");
		await expect(alert.getByText(message, { exact: true })).toBeVisible();
		for (const value of [message, asset.originalFilename])
			expect(
				await alert
					.getByText(value, { exact: true })
					.evaluate((element) => element.scrollWidth <= element.clientWidth),
			).toBe(true);
		const dismiss = alert.getByRole("button", {
			name: `Dismiss failed upload of ${asset.originalFilename}`,
		});
		await expectTouchTarget(dismiss);
		await dismiss.click();
		await expect(alert).toHaveCount(0);
		await expect(
			logo.getByRole("button", { name: "Attach", exact: true }),
		).toBeVisible();

		await page
			.getByRole("button", { name: "Close app settings", exact: true })
			.click();
		for (const width of [800, 390]) {
			await page.setViewportSize({ width, height: 844 });
			const controls = [
				page.getByRole("button", { name: "Preview", exact: true }),
				page.getByRole("button", { name: "Publish", exact: true }),
				page.getByRole("button", { name: "Edit history", exact: true }),
				page.getByRole("button", { name: "Account menu", exact: true }),
			];
			for (const control of controls) {
				await expect(control).toBeVisible();
				await expect(control).toHaveCount(1);
				await expectTouchTarget(control);
				await control.click({ trial: true });
			}
			await expect
				.poll(() =>
					page
						.locator("body")
						.evaluate((element) => element.scrollWidth - element.clientWidth),
				)
				.toBeLessThanOrEqual(1);
		}

		expect(transfers).toBe(0);
	} finally {
		initiate.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});
