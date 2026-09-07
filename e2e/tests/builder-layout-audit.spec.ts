import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "../lib/fixtures";

let appId: string;
test.beforeAll(() => {
	const seed: unknown = JSON.parse(
		readFileSync(join(process.cwd(), "e2e/.auth/seed.json"), "utf8"),
	);
	if (
		typeof seed !== "object" ||
		seed === null ||
		!("openAppId" in seed) ||
		typeof seed.openAppId !== "string"
	)
		throw new Error("Missing seeded layout app");
	appId = seed.openAppId;
});
async function width(element: Locator) {
	return element.evaluate((node) => node.getBoundingClientRect().width);
}
async function insideViewport(element: Locator, viewportWidth: number) {
	await expect(element).toBeVisible();
	await expect
		.poll(() =>
			element.evaluate((node, availableWidth) => {
				const rect = node.getBoundingClientRect();
				return {
					inside: rect.left >= -1 && rect.right <= availableWidth + 1,
					overflow: node.scrollWidth - node.clientWidth,
				};
			}, viewportWidth),
		)
		.toEqual({ overflow: 0, inside: true });
	const box = await element.boundingBox();
	if (!box) throw new Error("Missing visible drawer geometry");
	expect(box.x).toBeGreaterThanOrEqual(-1);
	expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);
}

test("native Builder flanks preserve the actual composer across Preview, responsive drawers, and focus handoffs", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/build/${appId}`);
	const structureCollapse = page.getByRole("button", {
		name: "Collapse structure sidebar",
		exact: true,
	});
	const structureExpand = page.getByRole("button", {
		name: "Expand structure sidebar",
		exact: true,
	});
	const chatCollapse = page.getByRole("button", {
		name: "Collapse chat sidebar",
		exact: true,
	});
	const chatExpand = page.getByRole("button", {
		name: "Expand chat sidebar",
		exact: true,
	});
	await expect(structureCollapse).toBeVisible({ timeout: 20_000 });
	await expect(chatCollapse).toBeVisible();
	const composer = page.getByPlaceholder("What would you like to change?");
	await composer.fill("Keep this request while I explore the app");
	const originalComposer = await composer.elementHandle();
	if (!originalComposer) throw new Error("Missing real composer");
	await expect(page.getByRole("main")).toHaveCount(1);
	await expect
		.poll(() => width(page.locator('[data-builder-flank="structure"]')))
		.toBe(360);
	await expect
		.poll(() => width(page.locator("[data-builder-chat-panel]")))
		.toBe(360);
	await structureCollapse.click();
	await expect(structureExpand).toBeFocused();
	await structureExpand.click();
	await expect(structureCollapse).toBeFocused();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await chatCollapse.click();
	await expect(chatExpand).toBeFocused();
	await expect
		.poll(() =>
			page.locator("[data-builder-chat-panel]").evaluate((node) => {
				const row = document.querySelector("[data-builder-layout]");
				if (!row) throw new Error("Missing actual Builder row");
				const panel = node.getBoundingClientRect(),
					bounds = row.getBoundingClientRect();
				return panel.left >= bounds.right - 1;
			}),
		)
		.toBe(true);
	await chatExpand.click();
	await expect(chatCollapse).toBeFocused();
	await expect(composer).toHaveValue(
		"Keep this request while I explore the app",
	);
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Back to edit", exact: true }),
	).toBeVisible();
	await expect
		.poll(() => width(page.locator('[data-builder-flank="structure-spacer"]')))
		.toBe(0);
	await expect
		.poll(() => width(page.locator('[data-builder-flank="chat-spacer"]')))
		.toBe(0);
	expect(
		await originalComposer.evaluate((element) => element.isConnected),
	).toBe(true);
	await page.getByRole("button", { name: "Back to edit", exact: true }).click();
	await expect(composer).toHaveValue(
		"Keep this request while I explore the app",
	);
	expect(
		await composer.evaluate(
			(element, original) => element === original,
			originalComposer,
		),
	).toBe(true);

	await page.setViewportSize({ width: 1024, height: 768 });
	await expect
		.poll(() => width(page.locator('[data-builder-flank="structure"]')))
		.toBe(300);
	await expect
		.poll(() => width(page.locator("[data-builder-chat-panel]")))
		.toBe(300);
	for (const viewportWidth of [800, 390]) {
		await page.setViewportSize({ width: viewportWidth, height: 780 });
		const appTrigger =
			viewportWidth === 390
				? page.getByRole("button", { name: "Open app structure", exact: true })
				: structureExpand;
		const chatTrigger =
			viewportWidth === 390
				? page.getByRole("button", { name: "Open chat", exact: true })
				: chatExpand;
		if (viewportWidth === 800) {
			await expect
				.poll(() => width(page.locator('[data-builder-flank="structure"]')))
				.toBe(56);
			await expect
				.poll(() => width(page.locator('[data-builder-flank="chat"]')))
				.toBe(56);
		} else {
			await expect(
				page.locator('[data-builder-flank="structure"]'),
			).toHaveCount(0);
			await expect(page.locator('[data-builder-flank="chat"]')).toHaveCount(0);
			await expect(
				page.getByRole("navigation", { name: "Builder panels" }),
			).toBeVisible();
		}
		// A chat sidebar that was open on desktop becomes the active modal
		// when crossing into the compact layout. Dismiss that retained owner.
		const retainedChat = page.getByRole("dialog", {
			name: "Chat",
			exact: true,
		});
		if (await retainedChat.isVisible()) {
			await page.keyboard.press("Escape");
			await expect(retainedChat).toBeHidden();
		}
		await appTrigger.click();
		const structure = page.getByRole("dialog", {
			name: "App structure",
			exact: true,
		});
		await insideViewport(structure, viewportWidth);
		for (let tab = 0; tab < 5; tab += 1) {
			await page.keyboard.press("Tab");
			expect(
				await structure.evaluate((element) =>
					element.contains(document.activeElement),
				),
			).toBe(true);
		}
		await page.keyboard.press("Escape");
		await expect(structure).toBeHidden();
		await expect(appTrigger).toBeFocused();
		await chatTrigger.click();
		const chat = page.getByRole("dialog", { name: "Chat", exact: true });
		await insideViewport(chat, viewportWidth);
		await expect(composer).toHaveValue(
			"Keep this request while I explore the app",
		);
		expect(
			await composer.evaluate(
				(element, original) => element === original,
				originalComposer,
			),
		).toBe(true);
		await page.keyboard.press("Escape");
		await expect(chat).toBeHidden();
		await expect(chatTrigger).toBeFocused();
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(composer).toHaveValue(
		"Keep this request while I explore the app",
	);
	expect(
		await composer.evaluate(
			(element, original) => element === original,
			originalComposer,
		),
	).toBe(true);
});

test("native AppTree field selection primes the real canvas scroll before URL selection and returns to an already mounted field", async ({
	page,
}) => {
	const seed: { caseWorkspace: { routes: { tileForm: string } } } = JSON.parse(
		readFileSync(join(process.cwd(), "e2e/.auth/seed.json"), "utf8"),
	);
	await page.setViewportSize({ width: 1440, height: 440 });
	await page.goto(seed.caseWorkspace.routes.tileForm);
	const tree = page.getByRole("list", { name: "App structure", exact: true });
	const last = tree.getByRole("button", { name: "Next dose", exact: true });
	await expect(last).toBeVisible({ timeout: 20_000 });
	// Edit mode has an inner virtualized scroller inside PreviewShell.
	const canvas = page.locator(
		"[data-preview-scroll-container] [data-preview-scroll-container]",
	);
	await expect(canvas).toHaveCount(1);
	const cards = canvas.locator("[data-field-uuid]");
	const lastCard = cards.filter({ hasText: "Next dose" });
	await expect(lastCard).toHaveCount(1);
	await canvas.evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect
		.poll(() =>
			lastCard.evaluate((element) => {
				const container = element.closest("[data-preview-scroll-container]");
				if (!container) throw new Error("Missing actual canvas container");
				return (
					element.getBoundingClientRect().top >=
					container.getBoundingClientRect().bottom
				);
			}),
		)
		.toBe(true);
	const uuid = await lastCard.getAttribute("data-field-uuid");
	if (!uuid) throw new Error("Missing actual field identity");
	await last.click();
	await expect(last).toHaveAttribute("aria-current", "page");
	await expect(page).toHaveURL(new RegExp(`/${uuid}$`));
	await expect
		.poll(() => canvas.evaluate((element) => element.scrollTop))
		.toBeGreaterThan(0);
	await expect
		.poll(() =>
			lastCard.evaluate((element) => {
				const container = element.closest("[data-preview-scroll-container]");
				if (!container) throw new Error("Missing actual canvas container");
				const field = element.getBoundingClientRect(),
					bounds = container.getBoundingClientRect();
				return field.top >= bounds.top && field.top < bounds.bottom;
			}),
		)
		.toBe(true);
	const lastOffset = await canvas.evaluate((element) => element.scrollTop);
	const first = tree.getByRole("button", { name: "Visit note", exact: true });
	await first.click();
	await expect(first).toHaveAttribute("aria-current", "page");
	await expect
		.poll(() => canvas.evaluate((element) => element.scrollTop))
		.toBeLessThan(lastOffset);
	await expect(cards.filter({ hasText: "Visit note" })).toBeInViewport();
});
