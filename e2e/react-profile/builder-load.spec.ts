import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../lib/fixtures";
import { startCpuProfile, stopCpuProfile } from "./cpuProfile";

interface SeedManifest {
	reactProfile?: {
		appId: string;
		initialRoute: string;
		targetRoute: string;
		targetFieldUuid: string;
	};
}

interface BuilderLoadMarks {
	appTree: number | null;
	home: number | null;
	form: number | null;
	inspectorHeader: number | null;
	inspectorLoading: number | null;
	inspector: number | null;
	fieldIdentity: number | null;
	xpathEditor: number | null;
	chat: number | null;
	engine: number | null;
	longTasks: Array<{ startTime: number; duration: number }>;
	longAnimationFrames: Array<{
		startTime: number;
		duration: number;
		blockingDuration: number;
		scripts: Array<{
			duration: number;
			invoker: string;
			sourceURL: string;
		}>;
	}>;
	events: Array<{
		name: string;
		startTime: number;
		duration: number;
		processingStart: number;
		processingEnd: number;
		interactionId: number;
	}>;
}

declare global {
	interface Window {
		__novaBuilderLoadMarks?: BuilderLoadMarks;
	}
}

function fixture() {
	const seed = JSON.parse(
		readFileSync(path.join(process.cwd(), "e2e", ".auth", "seed.json"), "utf8"),
	) as SeedManifest;
	if (!seed.reactProfile) {
		throw new Error("The React profile seed is missing from the manifest.");
	}
	return seed.reactProfile;
}

async function installLoadObserver(page: Page) {
	await page.addInitScript(() => {
		const marks: BuilderLoadMarks = {
			appTree: null,
			home: null,
			form: null,
			inspectorHeader: null,
			inspectorLoading: null,
			inspector: null,
			fieldIdentity: null,
			xpathEditor: null,
			chat: null,
			engine: null,
			longTasks: [],
			longAnimationFrames: [],
			events: [],
		};
		window.__novaBuilderLoadMarks = marks;
		const sample = () => {
			if (
				marks.appTree === null &&
				document.querySelector('ul[aria-label="App structure"]')
			) {
				marks.appTree = performance.now();
			}
			if (
				marks.home === null &&
				document.querySelector('[aria-label="Application name"]')
			) {
				marks.home = performance.now();
			}
			if (marks.form === null && document.querySelector("[data-form-header]")) {
				marks.form = performance.now();
			}
			if (
				marks.inspectorHeader === null &&
				document.querySelector('[data-builder-secondary-header="inspector"]')
			) {
				marks.inspectorHeader = performance.now();
			}
			if (
				marks.inspectorLoading === null &&
				document
					.querySelector('[role="status"]')
					?.textContent?.includes("Opening properties")
			) {
				marks.inspectorLoading = performance.now();
			}
			if (
				marks.inspector === null &&
				document.querySelector("[data-field-inspector]")
			) {
				marks.inspector = performance.now();
			}
			if (
				marks.fieldIdentity === null &&
				document.querySelector('[data-field-id="id"]')
			) {
				marks.fieldIdentity = performance.now();
			}
			if (
				marks.xpathEditor === null &&
				document.querySelector('[data-field-id="default_value"]')
			) {
				marks.xpathEditor = performance.now();
			}
			if (
				marks.engine === null &&
				document.querySelector('[data-preview-engine-ready="true"]')
			) {
				marks.engine = performance.now();
			}
			if (
				marks.chat === null &&
				document.querySelector('[data-builder-secondary-header="chat"]')
			) {
				marks.chat = performance.now();
			}
		};
		new MutationObserver(sample).observe(document, {
			attributes: true,
			childList: true,
			subtree: true,
		});
		new PerformanceObserver((entries) => {
			for (const entry of entries.getEntries()) {
				marks.longTasks.push({
					startTime: entry.startTime,
					duration: entry.duration,
				});
			}
		}).observe({ type: "longtask", buffered: true });
		try {
			new PerformanceObserver((entries) => {
				for (const rawEntry of entries.getEntries()) {
					const entry = rawEntry as PerformanceEntry & {
						blockingDuration: number;
						scripts: Array<{
							duration: number;
							invoker: string;
							sourceURL: string;
						}>;
					};
					marks.longAnimationFrames.push({
						startTime: entry.startTime,
						duration: entry.duration,
						blockingDuration: entry.blockingDuration,
						scripts: entry.scripts.map((script) => ({
							duration: script.duration,
							invoker: script.invoker,
							sourceURL: script.sourceURL,
						})),
					});
				}
			}).observe({ type: "long-animation-frame", buffered: true });
		} catch {
			// Older Chromium builds still provide the long-task totals above.
		}
		try {
			new PerformanceObserver((entries) => {
				for (const rawEntry of entries.getEntries()) {
					const entry = rawEntry as PerformanceEntry & {
						processingStart: number;
						processingEnd: number;
						interactionId: number;
					};
					marks.events.push({
						name: entry.name,
						startTime: entry.startTime,
						duration: entry.duration,
						processingStart: entry.processingStart,
						processingEnd: entry.processingEnd,
						interactionId: entry.interactionId,
					});
				}
			}).observe({
				type: "event",
				durationThreshold: 16,
			} as PerformanceObserverInit);
		} catch {
			// Event Timing is supplemental; wall and long-task timings still work.
		}
	});
}

async function beginInteractionWindow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const marks = window.__novaBuilderLoadMarks;
		if (!marks) throw new Error("Builder load observer was not installed.");
		marks.longTasks.length = 0;
		marks.longAnimationFrames.length = 0;
		marks.events.length = 0;
		return performance.now();
	});
}

async function resetVisibleMarks(
	page: Page,
	markNames: ReadonlyArray<
		| "form"
		| "inspectorHeader"
		| "inspectorLoading"
		| "inspector"
		| "fieldIdentity"
	>,
) {
	await page.evaluate((names) => {
		const marks = window.__novaBuilderLoadMarks;
		if (!marks) throw new Error("Builder load observer was not installed.");
		for (const name of names) marks[name] = null;
	}, markNames);
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

async function logInteractionMetrics(
	page: Page,
	metric: string,
	startedAt: number,
	cpuTopSelfTime: Awaited<ReturnType<typeof stopCpuProfile>> = [],
) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	const metrics = await page.evaluate(
		({ metric, startedAt, cpuTopSelfTime }) => {
			const marks = window.__novaBuilderLoadMarks;
			if (!marks) throw new Error("Builder load observer was not installed.");
			const resources = performance
				.getEntriesByType("resource")
				.filter(
					(entry): entry is PerformanceResourceTiming =>
						entry instanceof PerformanceResourceTiming &&
						entry.startTime >= startedAt,
				)
				.map((entry) => ({
					name: new URL(entry.name).pathname,
					initiatorType: entry.initiatorType,
					durationMs: entry.duration,
					transferBytes: entry.transferSize,
					decodedBytes: entry.decodedBodySize,
				}));
			const events = marks.events.filter(
				(event) => event.startTime >= startedAt,
			);
			const interactionEvents = events.filter(
				(event) => event.interactionId !== 0,
			);
			const measuredEvents =
				interactionEvents.length > 0 ? interactionEvents : events;
			const longTasks = marks.longTasks.filter(
				(task) => task.startTime >= startedAt,
			);
			const longAnimationFrames = marks.longAnimationFrames.filter(
				(frame) => frame.startTime >= startedAt,
			);
			return {
				metric,
				wallMs: performance.now() - startedAt,
				visibleAfterStartMs: Object.fromEntries(
					(
						[
							"form",
							"inspectorHeader",
							"inspectorLoading",
							"inspector",
							"fieldIdentity",
						] as const
					).map((name) => [
						name,
						typeof marks[name] === "number" && marks[name] >= startedAt
							? marks[name] - startedAt
							: null,
					]),
				),
				maxEventDurationMs: Math.max(
					0,
					...measuredEvents.map((event) => event.duration),
				),
				maxEventProcessingMs: Math.max(
					0,
					...measuredEvents.map(
						(event) => event.processingEnd - event.processingStart,
					),
				),
				maxLongTaskMs: Math.max(0, ...longTasks.map((task) => task.duration)),
				longAnimationFrames,
				eventCount: events.length,
				interactionEventCount: interactionEvents.length,
				resources,
				cpuTopSelfTime,
			};
		},
		{ metric, startedAt, cpuTopSelfTime },
	);
	console.log(JSON.stringify(metrics));
}

async function logLoadMetrics(
	page: Page,
	metric: string,
	usableMarks: ReadonlyArray<keyof BuilderLoadMarks>,
	cpuTopSelfTime: Awaited<ReturnType<typeof stopCpuProfile>>,
) {
	const metrics = await page.evaluate(
		({ metric, usableMarks, cpuTopSelfTime }) => {
			const navigation = performance.getEntriesByType(
				"navigation",
			)[0] as PerformanceNavigationTiming;
			const marks = window.__novaBuilderLoadMarks;
			if (!marks) throw new Error("Builder load observer was not installed.");
			const resources = performance
				.getEntriesByType("resource")
				.filter(
					(entry): entry is PerformanceResourceTiming =>
						entry instanceof PerformanceResourceTiming,
				);
			const scripts = resources.filter(
				(entry) => entry.initiatorType === "script",
			);
			const xpathWorkerResources = resources.filter((entry) =>
				new URL(entry.name).pathname.startsWith("/xpath-worker/"),
			);
			const uniqueScripts = new Map<string, PerformanceResourceTiming>();
			for (const script of scripts) {
				const pathname = new URL(script.name).pathname;
				const current = uniqueScripts.get(pathname);
				if (
					current === undefined ||
					script.transferSize > current.transferSize
				) {
					uniqueScripts.set(pathname, script);
				}
			}
			const usableAt = Math.max(
				...usableMarks.map((name) => {
					const mark = marks[name];
					return typeof mark === "number" ? mark : 0;
				}),
			);
			const blockingBeforeUsable = marks.longTasks.filter(
				(task) =>
					task.startTime >= navigation.responseEnd && task.startTime < usableAt,
			);
			const longAnimationFramesBeforeUsable = marks.longAnimationFrames.filter(
				(frame) => frame.startTime < usableAt,
			);
			return {
				metric,
				serverAndNetworkMs: navigation.responseStart,
				documentDownloadMs: navigation.responseEnd - navigation.responseStart,
				documentTransferBytes: navigation.transferSize,
				documentDecodedBytes: navigation.decodedBodySize,
				domContentLoadedMs: navigation.domContentLoadedEventEnd,
				loadEventMs: navigation.loadEventEnd,
				firstContentfulPaintMs:
					performance.getEntriesByName("first-contentful-paint")[0]
						?.startTime ?? null,
				appTreeVisibleMs: marks.appTree,
				homeVisibleMs: marks.home,
				formVisibleMs: marks.form,
				inspectorHeaderVisibleMs: marks.inspectorHeader,
				inspectorLoadingVisibleMs: marks.inspectorLoading,
				inspectorVisibleMs: marks.inspector,
				fieldIdentityVisibleMs: marks.fieldIdentity,
				xpathEditorVisibleMs: marks.xpathEditor,
				chatVisibleMs: marks.chat,
				builderUsableMs: usableAt,
				previewEngineReadyMs: marks.engine,
				renderedTreeFieldCount:
					document.querySelectorAll("[data-tree-field]").length,
				clientAfterResponseMs: usableAt - navigation.responseEnd,
				longTaskCountBeforeUsable: blockingBeforeUsable.length,
				longTaskMsBeforeUsable: blockingBeforeUsable.reduce(
					(total, task) => total + task.duration,
					0,
				),
				maxLongTaskMsBeforeUsable: Math.max(
					0,
					...blockingBeforeUsable.map((task) => task.duration),
				),
				longAnimationFramesBeforeUsable,
				scriptRequestCount: scripts.length,
				scriptTransferBytes: scripts.reduce(
					(total, script) => total + script.transferSize,
					0,
				),
				scriptDecodedBytes: scripts.reduce(
					(total, script) => total + script.decodedBodySize,
					0,
				),
				uniqueScriptCount: uniqueScripts.size,
				uniqueScriptTransferBytes: [...uniqueScripts.values()].reduce(
					(total, script) => total + script.transferSize,
					0,
				),
				uniqueScriptDecodedBytes: [...uniqueScripts.values()].reduce(
					(total, script) => total + script.decodedBodySize,
					0,
				),
				xpathWorkerResources: xpathWorkerResources.map((resource) => ({
					name: new URL(resource.name).pathname,
					initiatorType: resource.initiatorType,
					startTimeMs: resource.startTime,
					transferBytes: resource.transferSize,
					decodedBytes: resource.decodedBodySize,
					durationMs: resource.duration,
				})),
				largestScripts: [...uniqueScripts.values()]
					.map((script) => ({
						name: new URL(script.name).pathname,
						transferBytes: script.transferSize,
						decodedBytes: script.decodedBodySize,
						durationMs: script.duration,
					}))
					.sort((left, right) => right.decodedBytes - left.decodedBytes)
					.slice(0, 12),
				cpuTopSelfTime,
			};
		},
		{ metric, usableMarks, cpuTopSelfTime },
	);
	console.log(JSON.stringify(metrics));
}

/**
 * Production-load characterization. Run against an already-built standalone
 * server with this file selected explicitly; it needs no React DevTools
 * connection. The observer starts before application JavaScript and separates
 * server/document delivery from the client work required to show a usable
 * Builder and finish its background Preview initialization.
 */
test("measures a production-shaped Builder home load", async ({ page }) => {
	const seed = fixture();
	await installLoadObserver(page);
	const cpu =
		process.env.NOVA_PROFILE_LOAD_CPU === "1"
			? await startCpuProfile(page)
			: null;
	await page.goto(`/build/${seed.appId}`, { waitUntil: "commit" });
	await expect(page.getByRole("list", { name: "App structure" })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByLabel("Application name")).toBeVisible({
		timeout: 30_000,
	});
	await expect(
		page.locator('[data-builder-secondary-header="chat"]'),
	).toBeVisible({
		timeout: 30_000,
	});
	const cpuTopSelfTime = cpu ? await stopCpuProfile(cpu) : [];
	await logLoadMetrics(
		page,
		"builder-home-load",
		["appTree", "home", "chat"],
		cpuTopSelfTime,
	);
});

test("measures a production-shaped Builder deep-field load", async ({
	page,
}) => {
	const seed = fixture();
	await installLoadObserver(page);
	const cpu =
		process.env.NOVA_PROFILE_LOAD_CPU === "1"
			? await startCpuProfile(page)
			: null;

	await page.goto(seed.targetRoute, { waitUntil: "commit" });
	await expect(
		page.locator(`[data-field-inspector="${seed.targetFieldUuid}"]`),
	).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[data-field-id="id"]')).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator('[data-field-id="default_value"]')).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator('[data-preview-engine-ready="true"]')).toBeVisible({
		timeout: 30_000,
	});
	const cpuTopSelfTime = cpu ? await stopCpuProfile(cpu) : [];

	await logLoadMetrics(
		page,
		"builder-deep-field-load",
		["form", "fieldIdentity", "xpathEditor"],
		cpuTopSelfTime,
	);
});

test("measures the production-shaped cross-form hidden-field path", async ({
	page,
}) => {
	const seed = fixture();
	await installLoadObserver(page);
	await page.goto(seed.initialRoute);
	await expect(page.locator("[data-form-header]")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator('[data-preview-engine-ready="true"]')).toBeVisible({
		timeout: 30_000,
	});
	await expectAnimationsSettled(page);

	let startedAt = await beginInteractionWindow(page);
	await page
		.getByRole("button", { name: "Expand Adaptive question bank" })
		.click();
	await page.getByRole("button", { name: "Expand Profile section 4" }).click();
	const target = page.getByRole("button", {
		name: "profile_target_hidden",
		exact: true,
	});
	await expect(target).toBeVisible({ timeout: 30_000 });
	await logInteractionMetrics(page, "large-tree-reveal", startedAt);
	await expectAnimationsSettled(page);

	await resetVisibleMarks(page, [
		"form",
		"inspectorHeader",
		"inspectorLoading",
		"inspector",
		"fieldIdentity",
	]);
	startedAt = await beginInteractionWindow(page);
	await target.click();
	await expect(page).toHaveURL(new RegExp(`${seed.targetFieldUuid}$`));
	await expect(
		page.locator(`[data-field-inspector="${seed.targetFieldUuid}"]`),
	).toBeVisible({ timeout: 30_000 });
	await logInteractionMetrics(page, "cross-form-hidden-selection", startedAt);
});

test("measures a production-shaped ordinary field edit", async ({ page }) => {
	const seed = fixture();
	await installLoadObserver(page);
	await page.goto(seed.targetRoute);
	const inspector = page.locator(
		`[data-field-inspector="${seed.targetFieldUuid}"]`,
	);
	await expect(inspector).toBeVisible({ timeout: 30_000 });
	const input = inspector.locator('[data-field-id="id"] input');
	await expect(input).toBeVisible({ timeout: 30_000 });
	const currentId = await input.inputValue();
	const nextId = currentId.endsWith("_fast")
		? "profile_target_hidden_quick"
		: "profile_target_hidden_fast";
	await input.fill(nextId);

	const startedAt = await beginInteractionWindow(page);
	const cpu =
		process.env.NOVA_PROFILE_INTERACTION_CPU === "1"
			? await startCpuProfile(page)
			: null;
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("button", {
			name: nextId,
			exact: true,
		}),
	).toBeVisible();
	const cpuTopSelfTime = cpu ? await stopCpuProfile(cpu) : [];
	await logInteractionMetrics(
		page,
		"field-id-first-commit",
		startedAt,
		cpuTopSelfTime,
	);

	const steadyId = nextId.endsWith("_fast")
		? "profile_target_hidden_quick"
		: "profile_target_hidden_fast";
	await input.fill(steadyId);
	const steadyStartedAt = await beginInteractionWindow(page);
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("button", {
			name: steadyId,
			exact: true,
		}),
	).toBeVisible();
	await logInteractionMetrics(page, "field-id-steady-commit", steadyStartedAt);
});

test("measures production-shaped Builder and Preview interactions", async ({
	page,
}) => {
	const seed = fixture();
	await installLoadObserver(page);
	await page.goto(seed.targetRoute);
	const inspector = page.locator(
		`[data-field-inspector="${seed.targetFieldUuid}"]`,
	);
	await expect(inspector).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[data-field-id="default_value"]')).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator('[data-preview-engine-ready="true"]')).toBeVisible({
		timeout: 30_000,
	});

	let startedAt = await beginInteractionWindow(page);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const back = page.getByRole("button", { name: "Back to edit", exact: true });
	await expect(back).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[data-preview-engine-state="ready"]')).toBeVisible(
		{
			timeout: 30_000,
		},
	);
	await logInteractionMetrics(page, "preview-activation", startedAt);

	startedAt = await beginInteractionWindow(page);
	await back.click();
	await expect(inspector).toBeVisible({ timeout: 30_000 });
	await logInteractionMetrics(page, "preview-return-to-edit", startedAt);

	const trigger = inspector.locator(
		'[data-field-id="caseWrite"] [data-slot="combobox-trigger"]',
	);
	startedAt = await beginInteractionWindow(page);
	await trigger.click();
	const search = page.getByRole("combobox", {
		name: "Search case information",
	});
	await expect(search).toBeVisible();
	await logInteractionMetrics(page, "saves-to-open", startedAt);

	startedAt = await beginInteractionWindow(page);
	await search.fill("profile_property_50");
	const option = page.getByRole("option", { name: /profile property 50/i });
	await expect(option).toBeVisible();
	await logInteractionMetrics(page, "saves-to-search", startedAt);

	startedAt = await beginInteractionWindow(page);
	const selectionCpu =
		process.env.NOVA_PROFILE_INTERACTION_CPU === "1"
			? await startCpuProfile(page)
			: null;
	await option.click();
	await expect(trigger).toHaveAttribute(
		"aria-label",
		/Saves to: Profile property 50, #profile_participant\/profile_property_50/i,
	);
	const selectionCpuTopSelfTime = selectionCpu
		? await stopCpuProfile(selectionCpu)
		: [];
	await logInteractionMetrics(
		page,
		"saves-to-selection",
		startedAt,
		selectionCpuTopSelfTime,
	);
});
