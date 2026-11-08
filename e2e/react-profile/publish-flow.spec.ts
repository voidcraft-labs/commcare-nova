import { readFileSync } from "node:fs";
import { expect, test } from "../lib/fixtures";
import { requireScenarioSeed } from "../lib/scenarioSeeds";
import {
	cleanupReactProfile,
	exportReactProfile,
	profilerCommand,
} from "./profiler";

for (const preview of [false, true]) {
	test(`profiles first Publish opening in ${preview ? "preview" : "builder"}`, async ({
		page,
	}) => {
		const manifest = JSON.parse(readFileSync("e2e/.auth/seed.json", "utf8"));
		const seed = requireScenarioSeed<{ initialRoute: string }>(
			manifest.reactProfileScenarios,
			test.info(),
		);
		await page.goto(seed.initialRoute);
		await expect(
			page.locator('[data-builder-resource="lookup-catalog"]'),
		).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
		await expect(page.locator("[data-form-header]")).toBeVisible({
			timeout: 30_000,
		});
		if (preview) {
			await page
				.getByRole("button", { name: "Registration", exact: true })
				.click();
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await expect(
				page.locator('[data-preview-engine-state="ready"]'),
			).toBeVisible({ timeout: 30_000 });
		}
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						document
							.getAnimations()
							.filter(
								(animation) =>
									Number.isFinite(
										animation.effect?.getComputedTiming().endTime ?? Infinity,
									) &&
									(animation.playState === "running" || animation.pending),
							).length,
				),
			)
			.toBe(0);
		const publish = page.getByRole("button", { name: "Publish", exact: true });
		await expect(publish).toBeVisible();
		await page.screenshot({
			path: `react-profiles/publish-${preview}-before.png`,
		});
		profilerCommand(["wait", "--connected", "--timeout=30"]);
		profilerCommand(["profile", "start", `publish ${preview}`]);
		// Keyboard activation avoids warming the chunk with a pointer hover.
		await publish.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("dialog", { name: "Publish app" })).toBeVisible(
			{ timeout: 30_000 },
		);
		await expect(
			page.getByRole("heading", { name: "Choose a destination", exact: true }),
		).toBeVisible({ timeout: 30_000 });
		profilerCommand(["profile", "stop"]);
		exportReactProfile();
		await page.screenshot({
			path: `react-profiles/publish-${preview}-open.png`,
		});
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog", { name: "Publish app" })).toHaveCount(
			0,
		);
		await page.screenshot({
			path: `react-profiles/publish-${preview}-closed.png`,
		});
	});
}

test.afterEach(() => cleanupReactProfile());
