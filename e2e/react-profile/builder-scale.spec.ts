import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../lib/fixtures";
import { startCpuProfile, stopCpuProfile } from "./cpuProfile";

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
									(animation.playState === "running" || animation.pending),
							).length,
				),
			{ timeout: 15_000 },
		)
		.toBe(0);
}

async function expectBuilderResourcesSettled(page: Page) {
	await expect(
		page.locator('[data-builder-resource="lookup-catalog"]'),
	).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
	await expect(
		page.locator('[data-builder-resource="lookup-preview"]'),
	).toHaveAttribute("data-state", /^(?:data|idle)$/u, { timeout: 30_000 });
	await expect(
		page.locator('[data-builder-resource="case-database"]'),
	).toHaveAttribute("data-state", /^(?:ready|idle)$/u, { timeout: 30_000 });
	await expect(page.locator('[data-preview-engine-ready="true"]')).toBeVisible({
		timeout: 30_000,
	});
}

async function expectPreviewEngineReady(page: Page) {
	await expect(page.locator('[data-preview-engine-state="ready"]')).toBeVisible(
		{ timeout: 30_000 },
	);
}

test("profiles a cross-form hidden-field selection in a large Builder", async ({
	page,
}) => {
	const seed = fixture();
	await page.goto(seed.initialRoute);
	await expect(page.locator("[data-form-header]")).toBeVisible({
		timeout: 30_000,
	});
	await page
		.getByRole("button", { name: "Expand Adaptive question bank" })
		.click();
	await page.getByRole("button", { name: "Expand Profile section 4" }).click();
	const target = page.getByRole("button", {
		name: "profile_target_hidden",
		exact: true,
	});
	await expect(target).toBeVisible({ timeout: 30_000 });
	await expectAnimationsSettled(page);
	await expectBuilderResourcesSettled(page);

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

test("profiles expanding a summarized large form", async ({ page }) => {
	const seed = fixture();
	await page.goto(seed.initialRoute);
	await expect(page.locator("[data-form-header]")).toBeVisible({
		timeout: 30_000,
	});
	await expectAnimationsSettled(page);
	await expectBuilderResourcesSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large summarized form expansion"]);
	await page
		.getByRole("button", { name: "Expand Adaptive question bank" })
		.click();
	await page.getByRole("button", { name: "Expand Profile section 4" }).click();
	await expect(
		page.getByRole("button", {
			name: "profile_target_hidden",
			exact: true,
		}),
	).toBeVisible();
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});

test("profiles a same-form hidden-field selection in a large Builder", async ({
	page,
}) => {
	const seed = fixture();
	await page.goto(seed.targetRoute);
	const target = page.getByRole("button", {
		name: "profile_hidden_3_0",
		exact: true,
	});
	await page.getByRole("button", { name: "Expand Question group 4" }).click();
	await expect(target).toBeVisible({ timeout: 30_000 });
	await expectAnimationsSettled(page);
	await expectBuilderResourcesSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large same-form hidden selection"]);
	await target.click();
	await expect(target).toHaveAttribute("aria-current", "page");
	await expect(page).not.toHaveURL(new RegExp(`${seed.targetFieldUuid}$`));
	await expect(page.locator("[data-field-inspector]")).toBeVisible();
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});

test("profiles editing a field ID in a large Builder", async ({ page }) => {
	const seed = fixture();
	await page.goto(seed.targetRoute);
	const inspector = page.locator(
		`[data-field-inspector="${seed.targetFieldUuid}"]`,
	);
	await expect(inspector).toBeVisible({ timeout: 30_000 });
	await expectAnimationsSettled(page);
	await expectBuilderResourcesSettled(page);
	const idInput = inspector.locator('[data-field-id="id"] input');
	await expect(idInput).toHaveValue("profile_target_hidden");

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large field ID edit"]);
	const started = await page.evaluate(() => performance.now());
	await idInput.fill("profile_target_hidden_fast");
	await idInput.blur();
	await expect(
		page.getByRole("button", {
			name: "profile_target_hidden_fast",
			exact: true,
		}),
	).toBeVisible();
	const wallMs = await page.evaluate(
		(editStarted) => performance.now() - editStarted,
		started,
	);
	console.log(JSON.stringify({ metric: "field-id-edit-wall-ms", wallMs }));
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
	await expectBuilderResourcesSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large form Preview activation"]);
	const started = await page.evaluate(() => performance.now());
	await preview.click();
	await expect(
		page.getByRole("button", { name: "Back to edit", exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await expect(page.locator("[data-form-header]")).toBeVisible({
		timeout: 30_000,
	});
	await expectPreviewEngineReady(page);
	const wallMs = await page.evaluate(
		(activationStarted) => performance.now() - activationStarted,
		started,
	);
	console.log(JSON.stringify({ metric: "preview-activation-wall-ms", wallMs }));
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});

test("profiles answering a question in a large Preview form", async ({
	page,
}) => {
	const seed = fixture();
	await page.goto(seed.targetRoute);
	await expectBuilderResourcesSettled(page);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Back to edit", exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await expectPreviewEngineReady(page);
	const answer = page.getByRole("textbox", {
		name: /Profile text 4\.1$/,
	});
	await expect(answer).toBeVisible({ timeout: 30_000 });
	await expectAnimationsSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large Preview answer"]);
	const started = await page.evaluate(() => performance.now());
	await answer.fill("Responsive preview answer");
	await expect(answer).toHaveValue("Responsive preview answer");
	const wallMs = await page.evaluate(
		(answerStarted) => performance.now() - answerStarted,
		started,
	);
	console.log(JSON.stringify({ metric: "preview-answer-wall-ms", wallMs }));
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});

test("profiles returning from a large Preview form to edit", async ({
	page,
}) => {
	const seed = fixture();
	await page.goto(seed.targetRoute);
	await expectBuilderResourcesSettled(page);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const back = page.getByRole("button", { name: "Back to edit", exact: true });
	await expect(back).toBeVisible({ timeout: 30_000 });
	await expectPreviewEngineReady(page);
	await expectAnimationsSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large Preview return to edit"]);
	const started = await page.evaluate(() => performance.now());
	await back.click();
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await expect(
		page.locator(`[data-field-inspector="${seed.targetFieldUuid}"]`),
	).toBeVisible({ timeout: 30_000 });
	const wallMs = await page.evaluate(
		(returnStarted) => performance.now() - returnStarted,
		started,
	);
	console.log(JSON.stringify({ metric: "preview-return-wall-ms", wallMs }));
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});

test("profiles opening and searching the large Saves to catalog", async ({
	page,
}) => {
	const seed = fixture();
	await page.goto(seed.targetRoute);
	const inspector = page.locator(
		`[data-field-inspector="${seed.targetFieldUuid}"]`,
	);
	await expect(inspector).toBeVisible({ timeout: 30_000 });
	const trigger = inspector.locator(
		'[data-field-id="caseWrite"] [data-slot="combobox-trigger"]',
	);
	await expect(trigger).toBeVisible({ timeout: 30_000 });
	await expectAnimationsSettled(page);
	await expectBuilderResourcesSettled(page);

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large Saves to catalog"]);
	const openStarted = await page.evaluate(() => performance.now());
	await trigger.click();
	const search = page.getByRole("combobox", {
		name: "Search case information",
	});
	await expect(search).toBeVisible();
	const openMs = await page.evaluate(
		(started) => performance.now() - started,
		openStarted,
	);
	const searchStarted = await page.evaluate(() => performance.now());
	await search.fill("profile_property_50");
	await expect(
		page.getByRole("option", { name: /profile property 50/i }),
	).toBeVisible();
	const searchMs = await page.evaluate(
		(started) => performance.now() - started,
		searchStarted,
	);
	console.log(
		JSON.stringify({
			metric: "saves-to-interaction-wall-ms",
			openMs,
			searchMs,
		}),
	);
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});

test("profiles committing a large Saves to selection", async ({ page }) => {
	const seed = fixture();
	await page.goto(seed.targetRoute);
	const inspector = page.locator(
		`[data-field-inspector="${seed.targetFieldUuid}"]`,
	);
	await expect(inspector).toBeVisible({ timeout: 30_000 });
	const trigger = inspector.locator(
		'[data-field-id="caseWrite"] [data-slot="combobox-trigger"]',
	);
	await trigger.click();
	const search = page.getByRole("combobox", {
		name: "Search case information",
	});
	await search.fill("profile_property_50");
	const option = page.getByRole("option", { name: /profile property 50/i });
	await expect(option).toBeVisible();
	await expectAnimationsSettled(page);
	const advisoryStillEvaluating = await page
		.getByText("Checking availability", { exact: true })
		.isVisible();

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	profilerCommand(["profile", "start", "large Saves to selection commit"]);
	const selectionCpu =
		process.env.NOVA_PROFILE_INTERACTION_CPU === "1"
			? await startCpuProfile(page)
			: null;
	const started = await page.evaluate(() => performance.now());
	await option.click();
	await expect(trigger).toHaveAttribute(
		"aria-label",
		/Saves to: Profile property 50, #profile_participant\/profile_property_50/i,
	);
	const wallMs = await page.evaluate(
		(selectionStarted) => performance.now() - selectionStarted,
		started,
	);
	const cpuTopSelfTime = selectionCpu ? await stopCpuProfile(selectionCpu) : [];
	console.log(
		JSON.stringify({
			metric: "saves-to-selection-wall-ms",
			wallMs,
			advisoryStillEvaluating,
			cpuTopSelfTime,
		}),
	);
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	profilerCommand(["profile", "export", outputPath()]);
});
