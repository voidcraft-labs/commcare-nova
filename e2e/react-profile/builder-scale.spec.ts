import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../lib/fixtures";

interface ReactProfileSeed {
	appId: string;
	moduleUuid: string;
	initialFormUuid: string;
	initialRoute: string;
	targetFormUuid: string;
	targetFieldUuid: string;
	targetRoute: string;
}

interface SeedManifest {
	reactProfile?: ReactProfileSeed;
}

function fixture(): ReactProfileSeed {
	const seed = JSON.parse(
		readFileSync(path.join(process.cwd(), "e2e", ".auth", "seed.json"), "utf8"),
	) as SeedManifest;
	if (!seed.reactProfile) {
		throw new Error("The React profile seed is missing from the manifest.");
	}
	return seed.reactProfile;
}

function profilerCommand(args: string[]): string {
	const stateDir = process.env.NOVA_REACT_PROFILE_STATE_DIR;
	if (!stateDir) throw new Error("NOVA_REACT_PROFILE_STATE_DIR is missing.");
	return execFileSync(
		path.join(process.cwd(), "node_modules", ".bin", "agent-react-devtools"),
		[...args, `--state-dir=${stateDir}`],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
	);
}

function outputPath(): string {
	const output = process.env.NOVA_REACT_PROFILE_OUTPUT;
	if (!output) throw new Error("NOVA_REACT_PROFILE_OUTPUT is missing.");
	return output;
}

async function expectAnimationsSettled(page: Page) {
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						document
							.getAnimations()
							.filter(
								(animation) =>
									Number.isFinite(
										animation.effect?.getComputedTiming().endTime ?? Infinity,
									) &&
									(animation.playState === "running" ||
										animation.playState === "pending"),
							).length,
				),
			{ timeout: 15_000 },
		)
		.toBe(0);
}

test("profiles a cross-form hidden-field selection in a large Builder", async ({
	page,
}) => {
	const seed = fixture();
	await page.goto(seed.initialRoute);
	await expect(page.locator("[data-form-header]")).toBeVisible({
		timeout: 30_000,
	});
	const target = page.getByRole("button", {
		name: "profile_target_hidden",
		exact: true,
	});
	await expect(target).toBeVisible({ timeout: 30_000 });
	await expectAnimationsSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large cross-form hidden selection"]);
	await target.click();
	await expect(page).toHaveURL(new RegExp(`${seed.targetFieldUuid}$`));
	await expect(
		page.locator(`[data-field-inspector="${seed.targetFieldUuid}"]`),
	).toBeVisible();
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});

test("profiles Preview activation for a large logic-dense form", async ({
	page,
}) => {
	const seed = fixture();
	await page.goto(seed.targetRoute);
	const preview = page.getByRole("button", { name: "Preview", exact: true });
	await expect(preview).toBeVisible({ timeout: 30_000 });
	await expectAnimationsSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large form Preview activation"]);
	await preview.click();
	await expect(
		page.getByRole("button", { name: "Back to edit", exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await expect(page.locator("[data-form-header]")).toBeVisible({
		timeout: 30_000,
	});
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});
