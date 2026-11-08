import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { removableRoutes } from "../../lib/routes";

test.use({ actionTimeout: 10_000 });

for (const preview of [false, true]) {
	test(`cold Publish preserves ${preview ? "Preview answers and layout" : "Builder draft and layout"} while its code loads`, {
		tag: "@seed:react-profile",
	}, async ({ scenario, page }) => {
		const { reactProfile: seed } = seedFor(scenario, "react-profile");
		await page.setViewportSize({ width: 1440, height: 900 });
		await openBuilder(page, seed.initialRoute);
		const composer = page.getByPlaceholder("What would you like to change?");
		await composer.fill("Keep my conversation draft");
		if (preview) {
			await page
				.getByRole("button", { name: "Registration", exact: true })
				.click();
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await expect(
				page.locator('[data-preview-engine-state="ready"]'),
			).toBeVisible();
			await page
				.getByRole("textbox", { name: /Profile text 1\.1/ })
				.fill("Keep my preview answer");
		}
		const canvas = page.locator("[data-builder-canvas]");
		const structure = page.locator('[data-builder-flank="structure"]');
		await expect
			.poll(() =>
				structure.evaluate((node) => {
					const bounds = node.getBoundingClientRect();
					return Math.round(bounds.right);
				}),
			)
			.toBe(preview ? 0 : 360);
		const originalCanvas = await canvas.elementHandle();
		if (!originalCanvas) throw new Error("Missing Builder canvas");
		const before = await canvas.boundingBox();
		const routes = removableRoutes(page);
		const release = Promise.withResolvers<void>();
		let bodyHeld = false;
		await routes.route("**/_next/static/chunks/*.js", async (route) => {
			const response = await route.fetch();
			const body = await response.text();
			// Identify the lazy body by its rendered copy, independent of chunk hashes.
			if (body.includes("Choose a destination")) {
				bodyHeld = true;
				await release.promise;
			}
			await route.fulfill({ response, body });
		});
		const publish = page.getByRole("button", { name: "Publish", exact: true });
		const dialog = page.getByRole("dialog", {
			name: "Publish app",
			exact: true,
		});
		try {
			await publish.click();
			await expect.poll(() => bodyHeld).toBe(true);
			await expect(dialog).toBeVisible();
			await expect(dialog.getByRole("status")).toHaveText("Opening publishing");
			await expect(
				dialog.getByRole("heading", { name: "Publish app", exact: true }),
			).toBeFocused();
			await expect(canvas).toBeVisible();
			expect(await canvas.boundingBox()).toEqual(before);
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(publish).toBeFocused();
			release.resolve();
			await routes.removeAll();
			await publish.click();
			await expect(
				dialog.getByRole("heading", {
					name: "Choose a destination",
					exact: true,
				}),
			).toBeVisible();
			await test.info().attach("publish-open", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(canvas).toBeVisible();
			expect(
				await canvas.evaluate(
					(node, original) => node === original,
					originalCanvas,
				),
			).toBe(true);
			expect(await canvas.boundingBox()).toEqual(before);
			if (preview) {
				await expect(
					page.getByRole("textbox", { name: /Profile text 1\.1/ }),
				).toHaveValue("Keep my preview answer");
				await expect
					.poll(() =>
						structure.evaluate((node) =>
							Math.round(node.getBoundingClientRect().right),
						),
					)
					.toBe(0);
				await page
					.getByRole("button", { name: "Back to edit", exact: true })
					.click();
			}
			await expect(composer).toHaveValue("Keep my conversation draft");
			await test.info().attach("publish-closed", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
		} finally {
			release.resolve();
			await routes.removeAll();
			await originalCanvas.dispose();
		}
	});
}

test("Publish checks and downloads the saved document after a pending edit", {
	tag: "@seed:react-profile",
}, async ({ scenario, page }) => {
	const { reactProfile: seed } = seedFor(scenario, "react-profile");
	await openBuilder(page, seed.targetRoute);
	const id = page.locator(
		`[data-field-inspector="${seed.targetFieldUuid}"] [data-field-id="id"] input`,
	);
	await expect(id).toHaveValue("profile_target_hidden");
	const release = Promise.withResolvers<void>();
	const routes = removableRoutes(page);
	let saving = false;
	let checks = 0;
	let downloads = 0;
	await routes.route(`**/api/apps/${seed.appId}`, async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		saving = true;
		await release.promise;
		await route.continue();
	});
	await routes.route(
		"**/api/commcare/project-space-compatibility",
		async (route) => {
			checks++;
			await route.continue();
		},
	);
	await routes.route("**/api/compile/json", async (route) => {
		downloads++;
		await route.fulfill({ body: "zip", contentType: "application/zip" });
	});
	try {
		await id.fill("saved_before_publish");
		await id.blur();
		await expect.poll(() => saving).toBe(true);
		await page.getByRole("button", { name: "Publish", exact: true }).click();
		await page
			.getByRole("combobox", { name: "Publish option", exact: true })
			.click();
		await page
			.getByRole("option", { name: "CommCare HQ app file", exact: true })
			.click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: "Download ZIP", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Preparing", exact: true }),
		).toBeDisabled();
		expect({ checks, downloads }).toEqual({ checks: 0, downloads: 0 });
		const download = page.waitForEvent("download");
		release.resolve();
		await download;
		await expect(
			page.getByText("CommCare HQ app file downloaded", { exact: true }),
		).toBeVisible();
		expect({ checks, downloads }).toEqual({ checks: 1, downloads: 1 });
	} finally {
		release.resolve();
		await routes.removeAll();
	}
});

test("Publish recovers a failed production chunk within its dialog", {
	tag: "@seed:react-profile",
}, async ({ scenario, page }) => {
	const { reactProfile: seed } = seedFor(scenario, "react-profile");
	await openBuilder(page, seed.initialRoute);
	const routes = removableRoutes(page);
	let failedRequests = 0;
	let allowLoad = false;
	await routes.route("**/_next/static/chunks/*.js", async (route) => {
		const response = await route.fetch();
		const body = await response.text();
		if (body.includes("Choose a destination") && !allowLoad) {
			failedRequests++;
			await route.abort("failed");
		} else await route.fulfill({ response, body });
	});
	try {
		await page.getByRole("button", { name: "Publish", exact: true }).click();
		const dialog = page.getByRole("dialog", {
			name: "Publish app",
			exact: true,
		});
		await expect(dialog.getByRole("alert")).toContainText(
			"Nova couldn't open publishing. You can try again.",
		);
		expect(failedRequests).toBeGreaterThan(0);
		await expect(page.locator("[data-builder-canvas]")).toBeVisible();
		allowLoad = true;
		await dialog
			.getByRole("button", { name: "Try again", exact: true })
			.click();
		await expect(
			dialog.getByRole("heading", {
				name: "Choose a destination",
				exact: true,
			}),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "Publish", exact: true }),
		).toBeFocused();
	} finally {
		await routes.removeAll();
	}
});
