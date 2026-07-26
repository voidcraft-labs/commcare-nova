import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { CROSS_PROJECT_MOVE_DISCLOSURE } from "../../lib/projects/moveTargets";
import { CASE_WORKSPACE_SEED } from "../lib/caseWorkspaceSeed";
import { expect, test } from "../lib/fixtures";

/**
 * Authenticated smoke checks, driven by the seeded session cookie in
 * `e2e/.auth/state.json` (the `authed` Playwright project's storageState).
 *
 * Coverage mirrors the user-described "create → builder → delete" loop without
 * spending a cent on the LLM: the apps are minted by `e2e/seed.ts` through the
 * real no-LLM `createApp`, opened here in the builder, and one is soft-deleted
 * through the actual UI Server Action.
 */

interface SeedManifest {
	userId: string;
	userEmail: string;
	openAppName: string;
	deleteAppName: string;
	openAppId: string;
	deleteAppIds: string[];
	threadsAppId: string;
	threadUserText: string;
	threadAssistantText: string;
	olderThreadId: string;
	olderThreadUserText: string;
	olderThreadAssistantText: string;
	scrollAppId: string;
	scrollThreadUserText: string;
	scrollThreadAssistantText: string;
	scrollQuestionThreadUserText: string;
	scrollQuestionHeader: string;
	scrollQuestionOneText: string;
	scrollQuestionTwoText: string;
	scrollQuestionFinalOption: string;
	moveAppName: string;
	moveProjectName: string;
	moveAppIds: string[];
	moveDestinationProjectId: string;
	caseWorkspace: {
		routes: {
			search: string;
			results: string;
			details: string;
			condition: string;
			tileResults: string;
			projectData: string;
			selectField: string;
		};
	};
}

type SecondaryHeaderName =
	| "breadcrumb"
	| "structure"
	| "structure-rail"
	| "chat"
	| "chat-rail"
	| "inspector";

/**
 * The conversation's true scroll element. use-stick-to-bottom scrolls an
 * INNER div it creates under the `role="log"` root — the root itself is
 * `overflow-y-hidden` and never scrolls — so every scroll measurement must
 * resolve past the wrapper or it reads a vacuous 0. (Evaluate callbacks are
 * serialized, so the resolver is inlined in each helper below.)
 */
async function bottomGap(page: Page): Promise<number> {
	return page.getByRole("log").evaluate((el) => {
		let scroller: Element = el;
		for (const div of el.querySelectorAll("div")) {
			const overflowY = getComputedStyle(div).overflowY;
			if (overflowY === "auto" || overflowY === "scroll") {
				scroller = div;
				break;
			}
		}
		return Math.abs(
			scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
		);
	});
}

async function logScrollTop(page: Page): Promise<number> {
	return page.getByRole("log").evaluate((el) => {
		let scroller: Element = el;
		for (const div of el.querySelectorAll("div")) {
			const overflowY = getComputedStyle(div).overflowY;
			if (overflowY === "auto" || overflowY === "scroll") {
				scroller = div;
				break;
			}
		}
		return scroller.scrollTop;
	});
}

/**
 * Answer every POST /api/chat with a canned SSE reply AT THE NETWORK LAYER —
 * the request never reaches the server, so the scroll tests can never reach
 * the model (or spend anything). The chunk shapes mirror the transport
 * contract (`transportContract.integration.test.ts`): SSE `data:` lines
 * terminated by `[DONE]`, with the `x-workflow-run-id` reconnect header.
 * Each send gets a numbered reply so repeated sends stay uniquely assertable.
 */
async function stubChatSends(
	page: Page,
): Promise<{ reply: (n: number) => string }> {
	const replyText = (n: number) =>
		`Stubbed model reply ${n}: no tokens were harmed in this test.`;
	let sends = 0;
	await page.route("**/api/chat", async (route) => {
		if (route.request().method() !== "POST") {
			await route.fallback();
			return;
		}
		sends += 1;
		// The step envelope is load-bearing: an answered askQuestions round
		// CONTINUES the same assistant message, and `shouldAutoResend` looks at
		// the parts after the message's last step-start. Without `start-step`
		// the answered tool part stays in that window and every reply triggers
		// another resend — an infinite send loop against this stub.
		const chunks = [
			{ type: "start" },
			{ type: "start-step" },
			{ type: "text-start", id: "stub" },
			{ type: "text-delta", id: "stub", delta: replyText(sends) },
			{ type: "text-end", id: "stub" },
			{ type: "finish-step" },
			{ type: "finish" },
		];
		await route.fulfill({
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-workflow-run-id": `00000000-0000-4000-8000-00000000000${sends}`,
			},
			body: `${chunks
				.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
				.join("")}data: [DONE]\n\n`,
		});
	});
	return { reply: replyText };
}

/**
 * Record every scroll position the conversation log passes through, so a test
 * can distinguish a JUMP to the bottom (no samples strictly between the start
 * region and the pre-send bottom) from an animated trip through the
 * transcript (a dense trail of interior samples). Returns the pre-send
 * max scrollTop; read the samples back with `readScrollTrace`.
 */
async function armScrollTrace(page: Page): Promise<number> {
	return page.getByRole("log").evaluate((el) => {
		let scroller: Element = el;
		for (const div of el.querySelectorAll("div")) {
			const overflowY = getComputedStyle(div).overflowY;
			if (overflowY === "auto" || overflowY === "scroll") {
				scroller = div;
				break;
			}
		}
		const w = window as unknown as { __scrollTrace?: number[] };
		w.__scrollTrace = [];
		scroller.addEventListener("scroll", () => {
			w.__scrollTrace?.push(scroller.scrollTop);
		});
		return scroller.scrollHeight - scroller.clientHeight;
	});
}

async function readScrollTrace(page: Page): Promise<number[]> {
	return page.evaluate(
		() =>
			(window as unknown as { __scrollTrace?: number[] }).__scrollTrace ?? [],
	);
}

/**
 * Escape the conversation's bottom pin the way a person does — real wheel
 * input over the log. use-stick-to-bottom deliberately ignores programmatic
 * `scrollTop` writes (it re-pins right after them); only trusted user scroll
 * releases the lock, so the tests must scroll with the mouse.
 */
async function wheelScrollLog(page: Page, deltaY: number): Promise<void> {
	await page.getByRole("log").hover();
	await page.mouse.wheel(0, deltaY);
}

async function expectSecondaryHeadersAligned(
	page: Page,
	names: readonly SecondaryHeaderName[],
): Promise<void> {
	const bands = names.map((name) =>
		page.locator(`[data-builder-secondary-header="${name}"]`),
	);
	for (const band of bands) {
		await expect(band).toBeInViewport({ ratio: 0.9 });
	}

	// Sidebar transitions briefly produce intermediate geometry. Poll the real
	// rendered boxes so this catches a stable mismatch without racing animation.
	await expect
		.poll(async () => {
			const boxes = await Promise.all(bands.map((band) => band.boundingBox()));
			if (boxes.some((box) => box === null)) return Number.POSITIVE_INFINITY;
			const presentBoxes = boxes.filter((box) => box !== null);
			const heights = presentBoxes.map((box) => box.height);
			const bottoms = presentBoxes.map((box) => box.y + box.height);
			return Math.max(
				...heights.map((height) => Math.abs(height - 64)),
				Math.max(...bottoms) - Math.min(...bottoms),
			);
		})
		.toBeLessThanOrEqual(1);
}

async function expectCaseDataClearance(page: Page): Promise<void> {
	const header = page.locator('[data-builder-secondary-header="breadcrumb"]');
	const caseData = page.getByRole("button", { name: /^Case data for / });
	await expect(caseData).toBeInViewport({ ratio: 0.9 });

	const geometry = async () => {
		const [headerBox, buttonBox] = await Promise.all([
			header.boundingBox(),
			caseData.boundingBox(),
		]);
		if (headerBox === null || buttonBox === null) {
			return { smallestGap: 0, asymmetry: Number.POSITIVE_INFINITY };
		}
		const topGap = buttonBox.y - headerBox.y;
		const bottomGap =
			headerBox.y + headerBox.height - (buttonBox.y + buttonBox.height);
		return {
			smallestGap: Math.min(topGap, bottomGap),
			asymmetry: Math.abs(topGap - bottomGap),
		};
	};

	await expect
		.poll(async () => (await geometry()).smallestGap)
		.toBeGreaterThanOrEqual(8);
	await expect
		.poll(async () => (await geometry()).asymmetry)
		.toBeLessThanOrEqual(1);
}

// Loaded in beforeAll, NOT at module scope: Playwright imports every spec to
// discover tests even under `--project=public` (the seed-less prod probe), so a
// top-level read would crash collection when e2e/.auth/seed.json is absent.
let seed: SeedManifest;

test.describe("authenticated builder", () => {
	test.beforeAll(() => {
		seed = JSON.parse(
			readFileSync(
				path.join(process.cwd(), "e2e", ".auth", "seed.json"),
				"utf8",
			),
		);
	});

	test("home lists the seeded apps and opens one in the builder", async ({
		page,
	}) => {
		await page.goto("/");

		// Signed-in landing for a returning user: the app list, not the marketing
		// landing. (If the session cookie were rejected we'd see "Sign in with
		// Google" here instead — a silent-auth-break canary.)
		await expect(
			page.getByRole("heading", { name: "Your Apps", level: 1 }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: seed.openAppName, level: 3 }),
		).toBeVisible();

		// Admin/owner placement is a real sibling action, never nested in the
		// primary card link. Exercise its focus contract before navigating.
		const moveControl = page.getByRole("button", {
			name: `Move ${seed.openAppName} to another Project`,
		});
		await expect(moveControl).toBeVisible();
		const moveControlBox = await moveControl.boundingBox();
		expect(moveControlBox).not.toBeNull();
		expect(moveControlBox?.width ?? 0).toBeGreaterThanOrEqual(44);
		expect(moveControlBox?.height ?? 0).toBeGreaterThanOrEqual(44);
		await moveControl.click();
		await expect(
			page.getByRole("heading", { name: "Moving between Projects" }),
		).toBeFocused();
		await expect(page.getByText(CROSS_PROJECT_MOVE_DISCLOSURE)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(moveControl).toBeFocused();

		// The primary navigation link and card actions are accessible siblings.
		await page.getByRole("link", { name: `Open ${seed.openAppName}` }).click();
		await page.waitForURL(new RegExp(`/build/${seed.openAppId}`));

		// An empty app opens into the chat-first builder (the structural
		// canvas/sidebar only appears once it has content). Assert the builder
		// chrome (Account menu) AND the page content (the chat composer) mounted —
		// the latter proves we rendered the page, not the error boundary.
		await expect(
			page.getByRole("button", { name: "Account menu" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("button", { name: "Attach a file" }),
		).toBeVisible();
		// Authed, not bounced to the landing page.
		await expect(
			page.getByRole("button", { name: "Sign in with Google" }),
		).toHaveCount(0);
	});

	test("builder secondary headers stay aligned through sidebar and inspector states", async ({
		page,
	}) => {
		await page.goto(seed.caseWorkspace.routes.results);
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible({ timeout: 20_000 });

		await test.step("wide editor keeps every open header aligned", async () => {
			await expectSecondaryHeadersAligned(page, [
				"structure",
				"breadcrumb",
				"chat",
			]);
			await expectCaseDataClearance(page);
		});

		await test.step("compact editor preserves the open-sidebar header contract", async () => {
			await page.setViewportSize({ width: 1024, height: 768 });
			await expectSecondaryHeadersAligned(page, [
				"structure",
				"breadcrumb",
				"chat",
			]);
			await expectCaseDataClearance(page);
		});

		await test.step("collapsed rails use the same header band", async () => {
			await page
				.getByRole("button", { name: "Collapse structure sidebar" })
				.click();
			await page.getByRole("button", { name: "Collapse chat sidebar" }).click();
			await expect(
				page.getByRole("button", { name: "Expand structure sidebar" }),
			).toBeInViewport({ ratio: 0.9 });
			await expect(
				page.getByRole("button", { name: "Expand chat sidebar" }),
			).toBeInViewport({ ratio: 0.9 });
			await expectSecondaryHeadersAligned(page, [
				"structure-rail",
				"breadcrumb",
				"chat-rail",
			]);
			await expectCaseDataClearance(page);
		});

		await test.step("field inspector joins the shared header band", async () => {
			await page
				.getByRole("button", { name: "Expand structure sidebar" })
				.click();
			await page
				.getByRole("region", { name: "Information shown" })
				.getByRole("button", { name: "Patient ID", exact: true })
				.click();
			await expect(
				page.getByRole("button", { name: "Close properties", exact: true }),
			).toBeInViewport({ ratio: 0.9 });
			await expectSecondaryHeadersAligned(page, [
				"structure",
				"breadcrumb",
				"inspector",
			]);
			await expectCaseDataClearance(page);
		});
	});

	test("case workspace composes result filters, owns its scrolling, and keeps searchable menus interactive", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await page.goto(seed.caseWorkspace.routes.search);
		await expect(
			page.getByRole("heading", { name: "Search", level: 1 }),
		).toBeVisible({ timeout: 20_000 });

		const searchFields = page.getByRole("heading", {
			name: "Search fields",
			level: 2,
		});
		await expect(searchFields).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Cases available", level: 2 }),
		).toHaveCount(0);

		await page.goto(seed.caseWorkspace.routes.results);
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Collapse structure sidebar" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Collapse chat sidebar" }),
		).toBeVisible();

		// Results reads in the worker-facing order: what each row says, which
		// cases may appear, then how the matching rows are ordered.
		await expect(page.locator("[data-case-list-layout] h2")).toHaveText([
			"Information shown",
			"Cases available",
			"Default order",
		]);

		const casesAvailable = page.locator(
			'section[aria-labelledby="results-availability-heading"]',
		);
		const addCondition = casesAvailable.getByRole("button", {
			name: "Add condition",
		});
		const conditionVerbs = casesAvailable.getByRole("button", {
			name: "Condition is",
		});

		// Reproduce the old rejection path: a case-name search input already
		// exists, then an always-on rule also targets Case name. This valid
		// intersection must commit without a duplicate-property gate error.
		await addCondition.click();
		await page
			.getByRole("menuitem", { name: /^Compare case information/ })
			.click();
		await expect(conditionVerbs).toHaveCount(1);
		await casesAvailable
			.getByRole("button", { name: /^Case information: / })
			.click();
		await page.getByRole("menuitem", { name: /^Case name\b/i }).click();
		await expect(
			casesAvailable.getByRole("button", {
				name: "Case information: Case name",
			}),
		).toBeVisible();
		await expect(page.getByText(/filters on .* in both/i)).toHaveCount(0);

		// Adding another condition stays on the canvas and exposes composition
		// directly. Both peers remain visible while switching the root between
		// requiring every condition and allowing any condition.
		await addCondition.click();
		await page
			.getByRole("menuitem", { name: /^Compare case information/ })
			.click();
		await expect(conditionVerbs).toHaveCount(2);
		await expect(conditionVerbs.nth(0)).toBeVisible();
		await expect(conditionVerbs.nth(1)).toBeVisible();
		await expect(
			casesAvailable.getByRole("button", { name: "Delete condition" }),
		).toHaveCount(2);
		await expect(
			page.getByRole("button", { name: "Close properties", exact: true }),
		).toHaveCount(0);

		const allMatch = casesAvailable.getByRole("button", {
			name: "All conditions must match",
		});
		await allMatch.click();
		const anyMatchItem = page.getByRole("menuitemradio", {
			name: "Any condition can match",
		});
		await anyMatchItem.hover();
		const [connectorItemRadius, connectorItemBackground] =
			await anyMatchItem.evaluate((element) => {
				const style = getComputedStyle(element);
				return [
					Number.parseFloat(style.borderTopLeftRadius),
					style.backgroundColor,
				] as const;
			});
		expect(connectorItemRadius).toBeGreaterThanOrEqual(8);
		expect(connectorItemBackground).not.toBe("rgba(0, 0, 0, 0)");
		await anyMatchItem.click();
		const anyMatch = casesAvailable.getByRole("button", {
			name: "Any condition can match",
		});
		await expect(anyMatch).toBeVisible();
		await expect(conditionVerbs).toHaveCount(2);

		// The full predicate AST stays usable without nesting cards until they
		// become unreadably narrow. Each deeper group opens in the same roomy
		// workbench, and Back restores the exact summaries authored above it.
		const addAdvanced = casesAvailable.getByRole("button", {
			name: "Add condition",
		});
		await addAdvanced.click();
		await page
			.getByRole("menuitem", { name: /Require every condition/ })
			.click();
		await expect(
			casesAvailable.getByText("All conditions match", { exact: true }),
		).toBeVisible();
		await casesAvailable
			.getByRole("button", {
				name: /^Edit group where all conditions match/,
			})
			.last()
			.click();
		await expect(
			casesAvailable.getByRole("navigation", { name: "Condition location" }),
		).toBeVisible();
		await expect(
			casesAvailable.getByRole("heading", {
				name: "Editing all conditions",
				level: 3,
			}),
		).toBeVisible();

		await addAdvanced.click();
		await page.getByRole("menuitem", { name: /Require any condition/ }).click();
		await casesAvailable
			.getByRole("button", {
				name: /^Edit group where any condition can match/,
			})
			.last()
			.click();
		await expect(
			casesAvailable.getByRole("heading", {
				name: "Editing any condition",
				level: 3,
			}),
		).toBeVisible();

		await addAdvanced.click();
		await page.getByRole("menuitem", { name: /Exclude when/ }).click();
		await casesAvailable
			.getByRole("button", {
				name: /^Edit condition that excludes cases/,
			})
			.last()
			.click();
		await expect(
			casesAvailable.getByRole("heading", {
				name: "Editing exclude cases when",
				level: 3,
			}),
		).toBeVisible();

		const backOneLevel = casesAvailable.getByRole("button", {
			name: /^Back to /,
		});
		await backOneLevel.click();
		await expect(
			casesAvailable.getByRole("heading", {
				name: "Editing any condition",
				level: 3,
			}),
		).toBeVisible();
		await expect(
			casesAvailable.getByText("Exclude cases when", { exact: true }),
		).toBeVisible();
		await backOneLevel.click();
		await expect(
			casesAvailable.getByRole("heading", {
				name: "Editing all conditions",
				level: 3,
			}),
		).toBeVisible();
		await expect(
			casesAvailable.getByText("Any condition matches", { exact: true }),
		).toBeVisible();
		await backOneLevel.click();
		await expect(
			casesAvailable.getByRole("heading", {
				name: "Editing cases available",
				level: 3,
			}),
		).toBeVisible();
		await expect(
			casesAvailable.getByText("All conditions match", { exact: true }),
		).toBeVisible();
		await expect(anyMatch).toBeVisible();

		// The destructive hover target stays inset inside its row instead of
		// touching the rounded card edge. Its 44px target remains available even
		// though only the quiet inner icon receives the rose hover treatment.
		const removeCondition = casesAvailable
			.getByRole("button", { name: "Delete condition" })
			.first();
		await removeCondition.hover();
		await expect(
			page.getByRole("tooltip", { name: "Delete condition" }),
		).toBeVisible();
		const conditionCard = removeCondition.locator(
			"xpath=ancestor::*[@data-removal-card][1]",
		);
		const [removeBox, conditionCardBox] = await Promise.all([
			removeCondition.boundingBox(),
			conditionCard.boundingBox(),
		]);
		expect(removeBox).not.toBeNull();
		expect(conditionCardBox).not.toBeNull();
		if (removeBox === null || conditionCardBox === null) return;
		expect(removeBox.width).toBeGreaterThanOrEqual(44);
		expect(removeBox.height).toBeGreaterThanOrEqual(44);
		expect(removeBox.x - conditionCardBox.x).toBeGreaterThanOrEqual(8);
		expect(removeBox.y - conditionCardBox.y).toBeGreaterThanOrEqual(8);
		expect(
			conditionCardBox.x +
				conditionCardBox.width -
				(removeBox.x + removeBox.width),
		).toBeGreaterThanOrEqual(8);

		await page.setViewportSize({ width: 1280, height: 560 });

		// The workspace tab strip is a fixed sibling of the active body. A short
		// viewport therefore scrolls exactly one element: the tab's own body, not
		// the tab strip, PreviewShell, or the page. Each tab remembers its offset.
		const tabs = page.locator("[data-case-workspace-tabs]");
		const resultsScrollBody = page.locator(
			'[data-case-workspace-scroll-body="list"]',
		);
		const previewScrollContainer = page
			.locator("[data-preview-scroll-container]")
			.first();
		const tabsBeforeScroll = await tabs.boundingBox();
		expect(tabsBeforeScroll).not.toBeNull();
		if (tabsBeforeScroll === null) return;
		const resultsOffset = await resultsScrollBody.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
			return element.scrollTop;
		});
		expect(resultsOffset).toBeGreaterThan(0);
		await expect
			.poll(async () => (await tabs.boundingBox())?.y ?? Number.NaN)
			.toBeCloseTo(tabsBeforeScroll.y, 0);
		await expect
			.poll(() =>
				previewScrollContainer.evaluate((element) => element.scrollTop),
			)
			.toBe(0);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);

		await page.getByRole("button", { name: /^Search(?:,|$)/ }).click();
		await expect(
			page.getByRole("heading", { name: "Search", level: 1 }),
		).toBeVisible();
		const searchScrollBody = page.locator(
			'[data-case-workspace-scroll-body="search"]',
		);
		const searchOffset = await searchScrollBody.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
			return element.scrollTop;
		});
		expect(searchOffset).toBeGreaterThan(0);

		await page.getByRole("button", { name: /^Results(?:,|$)/ }).click();
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible();
		await expect
			.poll(() => resultsScrollBody.evaluate((element) => element.scrollTop))
			.toBeCloseTo(resultsOffset, 0);
		await expect(anyMatch).toBeVisible();
		await expect(conditionVerbs).toHaveCount(2);

		await page.getByRole("button", { name: /^Search(?:,|$)/ }).click();
		await expect(
			page.getByRole("heading", { name: "Search", level: 1 }),
		).toBeVisible();
		await expect
			.poll(() => searchScrollBody.evaluate((element) => element.scrollTop))
			.toBeCloseTo(searchOffset, 0);
		await page.getByRole("button", { name: /^Results(?:,|$)/ }).click();
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible();
		await resultsScrollBody.evaluate((element) => {
			element.scrollTop = 0;
		});

		await test.step("search conditions use one center workbench", async () => {
			await page.setViewportSize({ width: 1280, height: 720 });
			await page.getByRole("button", { name: /^Search(?:,|$)/ }).click();
			await expect(
				page.getByRole("heading", { name: "Search", level: 1 }),
			).toBeVisible();

			// A standard search field becomes a custom condition from its Match
			// picker. The rail keeps the field's ordinary settings; the recursive
			// condition itself opens full-width in the center, never in both places.
			const patientNameRow = searchScrollBody
				.getByText("Patient name", { exact: true })
				.locator("xpath=ancestor::button[1]");
			await patientNameRow.click();
			await expect(
				page.getByRole("button", { name: "Close properties", exact: true }),
			).toBeVisible();
			const customMatchPicker = page.getByRole("button", {
				name: /Search field 1 match: Similar spelling/,
			});
			const inputConditionOrigin = await searchScrollBody.evaluate(
				(element) => element.scrollTop,
			);
			await customMatchPicker.click();
			await page
				.getByRole("menuitemradio", { name: /Custom condition/ })
				.click();
			await expect(
				page.getByRole("heading", {
					name: "Match cases for Patient name",
					level: 1,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Close properties", exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: "Edit condition" }),
			).toHaveCount(0);
			await expect
				.poll(() => searchScrollBody.evaluate((element) => element.scrollTop))
				.toBe(0);

			await page
				.getByRole("button", { name: "Back to Search", exact: true })
				.click();
			await expect(
				page.getByRole("button", { name: "Close properties", exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: "Search field 1 match: Custom condition",
				}),
			).toBeVisible();
			await expect
				.poll(() => searchScrollBody.evaluate((element) => element.scrollTop))
				.toBeCloseTo(inputConditionOrigin, 0);

			// The Search button's condition follows the same ownership rule. Its
			// inspector only names and summarizes the setting; Add/Edit both open
			// the center workbench and Back restores the panel inspector.
			await page
				.getByRole("button", { name: "Close properties", exact: true })
				.click();
			await page.getByRole("button", { name: "Edit Search screen" }).click();
			const inspector = page
				.locator('[data-builder-secondary-header="inspector"]')
				.locator("..");
			await inspector.getByRole("button", { name: "More settings" }).click();
			const panelConditionOrigin = await searchScrollBody.evaluate(
				(element) => element.scrollTop,
			);
			await inspector.getByRole("button", { name: "Add condition" }).click();
			await expect(
				page.getByRole("heading", {
					name: "When Search is available",
					level: 1,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Close properties", exact: true }),
			).toHaveCount(0);
			await page
				.getByRole("button", { name: "Back to Search", exact: true })
				.click();
			await expect(
				page.getByRole("button", { name: "Close properties", exact: true }),
			).toBeVisible();
			await expect(
				inspector.getByRole("button", { name: "Edit condition" }),
			).toBeVisible();
			await expect
				.poll(() => searchScrollBody.evaluate((element) => element.scrollTop))
				.toBeCloseTo(panelConditionOrigin, 0);
			await inspector.getByRole("button", { name: "Edit condition" }).click();
			await expect(
				page.getByRole("heading", {
					name: "When Search is available",
					level: 1,
				}),
			).toBeVisible();
			await page
				.getByRole("button", { name: "Back to Search", exact: true })
				.click();
			await page
				.getByRole("button", { name: "Close properties", exact: true })
				.click();
		});

		await page.getByRole("button", { name: /^Results(?:,|$)/ }).click();
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible();
		await resultsScrollBody.evaluate((element) => {
			element.scrollTop = 0;
		});

		const addInformation = page.getByRole("combobox", {
			name: "Add information",
		});
		await addInformation.click();
		const menu = page.getByRole("dialog", { name: "Add information" });
		const informationSearch = menu.getByRole("combobox", {
			name: "Search case information",
		});
		const menuPositioner = menu.locator("..");
		await expect(menuPositioner).toHaveAttribute("data-side", "top");
		await expect(
			menu.getByRole("heading", { name: "Add information" }),
		).toBeVisible();
		const [openMenuBox, triggerBox] = await Promise.all([
			menu.boundingBox(),
			addInformation.boundingBox(),
		]);
		expect(openMenuBox).not.toBeNull();
		expect(triggerBox).not.toBeNull();
		if (openMenuBox === null || triggerBox === null) return;
		expect(openMenuBox.y).toBeGreaterThanOrEqual(4);
		expect(openMenuBox.y + openMenuBox.height).toBeLessThanOrEqual(
			triggerBox.y - 4,
		);
		const choiceScrollRegion = menu.locator("[data-combobox-scroll-region]");
		const choiceScrollMetrics = await choiceScrollRegion.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
			const metrics = {
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
				scrollTop: element.scrollTop,
				pageScrollY: window.scrollY,
			};
			element.scrollTop = 0;
			return metrics;
		});
		expect(choiceScrollMetrics.scrollHeight).toBeGreaterThan(
			choiceScrollMetrics.clientHeight,
		);
		expect(choiceScrollMetrics.scrollTop).toBeGreaterThan(0);
		expect(choiceScrollMetrics.pageScrollY).toBe(0);
		await informationSearch.fill("phone");
		await expect(
			page.getByRole("option", {
				name: /Phone number.*Text/,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("option", {
				name: /Date of birth.*Date/,
			}),
		).toHaveCount(0);

		const phoneItem = page.getByRole("option", {
			name: /Phone number.*Text/,
		});
		await phoneItem.hover();
		const [menuBox, phoneBox, phoneRadius] = await Promise.all([
			menu.boundingBox(),
			phoneItem.boundingBox(),
			phoneItem.evaluate((element) =>
				Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
			),
		]);
		expect(menuBox).not.toBeNull();
		expect(phoneBox).not.toBeNull();
		if (menuBox === null || phoneBox === null) return;
		await expect(menuPositioner).toHaveAttribute(
			"data-side",
			/^(?:top|bottom)$/,
		);
		expect(Math.abs(menuBox.x - openMenuBox.x)).toBeLessThanOrEqual(8);
		expect(menuBox.y).toBeGreaterThanOrEqual(4);
		expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(556);
		expect(phoneBox.x - menuBox.x).toBeGreaterThanOrEqual(4);
		expect(phoneRadius).toBeGreaterThanOrEqual(8);
		await informationSearch.fill("nothing-can-match-this-property");
		const emptyStatus = menu.getByRole("status");
		await expect(emptyStatus).toBeVisible();
		await expect(emptyStatus).toContainText("No matching information");
		await expect(menu.getByText("Try a different search")).toBeVisible();
		const [emptyMenuBox, emptyStateBox, emptyScrollMetrics] = await Promise.all(
			[
				menu.boundingBox(),
				menu.locator('[data-slot="combobox-empty"]').boundingBox(),
				menu.locator("[data-combobox-scroll-region]").evaluate((element) => ({
					clientHeight: element.clientHeight,
					scrollHeight: element.scrollHeight,
				})),
			],
		);
		expect(emptyMenuBox).not.toBeNull();
		expect(emptyStateBox).not.toBeNull();
		if (emptyMenuBox === null || emptyStateBox === null) return;
		await expect(menuPositioner).toHaveAttribute(
			"data-side",
			/^(?:top|bottom)$/,
		);
		expect(emptyMenuBox.y).toBeGreaterThanOrEqual(4);
		expect(emptyMenuBox.y + emptyMenuBox.height).toBeLessThanOrEqual(556);
		expect(emptyStateBox.height).toBeGreaterThanOrEqual(96);
		expect(emptyScrollMetrics.scrollHeight).toBeLessThanOrEqual(
			emptyScrollMetrics.clientHeight + 1,
		);
		const clearSearch = menu.getByRole("button", { name: "Clear search" });
		const clearSearchBox = await clearSearch.boundingBox();
		expect(clearSearchBox).not.toBeNull();
		if (clearSearchBox === null) return;
		expect(clearSearchBox.height).toBeGreaterThanOrEqual(44);
		await clearSearch.click();
		await expect(informationSearch).toHaveValue("");
		await expect(informationSearch).toBeFocused();
		await expect(menu.getByText("Common information")).toBeVisible();
		await informationSearch.press("Escape");
		await expect(informationSearch).toHaveCount(0);
		await expect(addInformation).toBeFocused();

		// The same picker keeps its conventional below-trigger placement when
		// there is enough room; the edge fix must not make every opening jump up.
		await page.setViewportSize({ width: 1280, height: 1000 });
		await addInformation.click();
		await expect(informationSearch).toBeVisible();
		await expect(menuPositioner).toHaveAttribute("data-side", "bottom");
		const [roomyMenuBox, roomyTriggerBox] = await Promise.all([
			menu.boundingBox(),
			addInformation.boundingBox(),
		]);
		expect(roomyMenuBox).not.toBeNull();
		expect(roomyTriggerBox).not.toBeNull();
		if (roomyMenuBox === null || roomyTriggerBox === null) return;
		expect(roomyMenuBox.y).toBeGreaterThanOrEqual(
			roomyTriggerBox.y + roomyTriggerBox.height + 4,
		);
		expect(roomyMenuBox.y + roomyMenuBox.height).toBeLessThanOrEqual(996);
		await informationSearch.press("Escape");
		await expect(addInformation).toBeFocused();

		await page.getByRole("button", { name: /^Case data for / }).click();
		const caseData = page.getByRole("dialog", { name: "Case data" });
		const caseDataDescription = caseData.getByText(
			"Add or replace the cases saved for the patient case type. They’re used throughout your app and in Preview.",
		);
		await expect(caseDataDescription).toBeVisible();
		const countValue = caseData.getByText("8", { exact: true });
		await expect(countValue).toBeVisible();
		await expect(caseData.getByText("cases", { exact: true })).toBeVisible();
		const [titleSize, countSize, descriptionSize, popoverBox] =
			await Promise.all([
				caseData
					.getByRole("heading", { name: "Case data" })
					.evaluate((element) =>
						Number.parseFloat(getComputedStyle(element).fontSize),
					),
				countValue.evaluate((element) =>
					Number.parseFloat(getComputedStyle(element).fontSize),
				),
				caseDataDescription.evaluate((element) =>
					Number.parseFloat(getComputedStyle(element).fontSize),
				),
				caseData.boundingBox(),
			]);
		expect(countSize).toBeGreaterThan(titleSize);
		expect(titleSize).toBeGreaterThan(descriptionSize);
		expect(popoverBox).not.toBeNull();
		if (popoverBox === null) return;
		const viewport = page.viewportSize();
		expect(viewport).not.toBeNull();
		if (viewport === null) return;
		expect(popoverBox.x).toBeGreaterThanOrEqual(4);
		expect(popoverBox.y).toBeGreaterThanOrEqual(4);
		expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
			viewport.width - 4,
		);
		expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(
			viewport.height - 4,
		);

		// Destructive confirmations use the shared AlertDialog contract.
		// Long confirmation copy must stay inside both axes on a short viewport;
		// the popup itself scrolls while its concise actions stay in one contained
		// horizontal row.
		await caseData.getByRole("button", { name: "Replace case data" }).click();
		const replaceDialog = page.getByRole("alertdialog");
		await expect(
			replaceDialog.getByRole("heading", {
				name: "Replace all 8 cases?",
			}),
		).toBeVisible();
		const cancelReplace = replaceDialog.getByRole("button", {
			name: "Cancel",
		});
		const replaceCases = replaceDialog.getByRole("button", {
			name: "Replace",
		});
		const [roomyReplaceBox, roomyKeepBox, roomyReplaceActionBox] =
			await Promise.all([
				replaceDialog.boundingBox(),
				cancelReplace.boundingBox(),
				replaceCases.boundingBox(),
			]);
		expect(roomyReplaceBox).not.toBeNull();
		expect(roomyKeepBox).not.toBeNull();
		expect(roomyReplaceActionBox).not.toBeNull();
		if (
			roomyReplaceBox === null ||
			roomyKeepBox === null ||
			roomyReplaceActionBox === null
		)
			return;
		for (const actionBox of [roomyKeepBox, roomyReplaceActionBox]) {
			expect(actionBox.x).toBeGreaterThanOrEqual(roomyReplaceBox.x);
			expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(
				roomyReplaceBox.x + roomyReplaceBox.width,
			);
		}
		expect(roomyKeepBox.y).toBeCloseTo(roomyReplaceActionBox.y, 0);
		expect(roomyKeepBox.height).toBeCloseTo(roomyReplaceActionBox.height, 0);

		await page.setViewportSize({ width: 640, height: 220 });
		const replaceMetrics = await replaceDialog.evaluate((element) => ({
			clientHeight: element.clientHeight,
			scrollHeight: element.scrollHeight,
		}));
		const replaceBox = await replaceDialog.boundingBox();
		expect(replaceBox).not.toBeNull();
		if (replaceBox === null) return;
		expect(replaceBox.x).toBeGreaterThanOrEqual(16);
		expect(replaceBox.y).toBeGreaterThanOrEqual(16);
		expect(replaceBox.x + replaceBox.width).toBeLessThanOrEqual(624);
		expect(replaceBox.y + replaceBox.height).toBeLessThanOrEqual(204);
		expect(replaceMetrics.scrollHeight).toBeGreaterThan(
			replaceMetrics.clientHeight,
		);

		// The row can sit below the fold when the viewport is deliberately
		// shorter than the confirmation copy. Scrolling one choice into view must
		// reveal both choices on the same contained row, never a vertical stack.
		await cancelReplace.scrollIntoViewIfNeeded();
		const [keepBox, replaceActionBox] = await Promise.all([
			cancelReplace.boundingBox(),
			replaceCases.boundingBox(),
		]);
		expect(keepBox).not.toBeNull();
		expect(replaceActionBox).not.toBeNull();
		if (keepBox === null || replaceActionBox === null) return;
		for (const actionBox of [keepBox, replaceActionBox]) {
			expect(actionBox.x).toBeGreaterThanOrEqual(replaceBox.x);
			expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(
				replaceBox.x + replaceBox.width,
			);
			expect(actionBox.y).toBeGreaterThanOrEqual(replaceBox.y);
			expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(
				replaceBox.y + replaceBox.height,
			);
		}
		expect(keepBox.y).toBeCloseTo(replaceActionBox.y, 0);
		expect(keepBox.height).toBeCloseTo(replaceActionBox.height, 0);
		await cancelReplace.click();
		await expect(replaceDialog).toHaveCount(0);
		await page.setViewportSize({ width: 1280, height: 720 });

		await test.step("preview explains why an otherwise populated list is empty", async () => {
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await expect(
				page.getByRole("button", { name: "Back to edit", exact: true }),
			).toBeVisible();
			const authoredEmptyTitle = page.getByRole("heading", {
				name: "Your availability settings hide every case",
				level: 2,
			});
			await expect(authoredEmptyTitle).toBeVisible({ timeout: 20_000 });
			const authoredEmpty = authoredEmptyTitle.locator("..");
			const authoredEmptyDescription = authoredEmpty.getByText(
				"To show cases, update Cases available in Results or create a matching case",
			);
			await expect(authoredEmptyDescription).toBeVisible();
			await expect(page.getByText("No cases yet", { exact: true })).toHaveCount(
				0,
			);
			await expect(
				page.getByRole("button", { name: /sample cases/i }),
			).toHaveCount(0);
			const [emptyTitleStyle, emptyDescriptionStyle] = await Promise.all([
				authoredEmptyTitle.evaluate((element) => {
					const style = getComputedStyle(element);
					return {
						fontSize: Number.parseFloat(style.fontSize),
						color: style.color,
					};
				}),
				authoredEmptyDescription.evaluate((element) => {
					const style = getComputedStyle(element);
					return {
						fontSize: Number.parseFloat(style.fontSize),
						color: style.color,
					};
				}),
			]);
			expect(emptyTitleStyle.fontSize).toBeGreaterThan(
				emptyDescriptionStyle.fontSize,
			);
			expect(emptyTitleStyle.color).not.toBe(emptyDescriptionStyle.color);

			// A submitted search cannot mask the broader availability problem: no
			// search can return a case while Results excludes every available case.
			await page.getByRole("textbox", { name: "Patient name" }).fill("Nobody");
			await page
				.getByRole("button", { name: "Show patients", exact: true })
				.click();
			await expect(authoredEmptyTitle).toBeVisible({ timeout: 20_000 });
			await expect(
				page.getByRole("heading", {
					name: "No cases match your search",
					level: 2,
				}),
			).toHaveCount(0);

			await page
				.getByRole("button", { name: "Back to edit", exact: true })
				.click();
			await expect(
				page.getByRole("heading", { name: "Results", level: 1 }),
			).toBeVisible();
		});

		// Details used to bypass the chooser when it had no information to add
		// back, silently picking the next system property. It must now wait for
		// an explicit choice, then expose true deletion separately from Hide.
		await page.goto(seed.caseWorkspace.routes.details);
		await expect(
			page.getByRole("heading", { name: "Details", level: 1 }),
		).toBeVisible();
		const detailsInformation = page.getByRole("region", {
			name: "Information shown",
		});
		const detailsRows = detailsInformation.locator(
			'[data-case-field-role="visible"]',
		);
		const originalDetailCount = await detailsRows.count();
		const addDetailsInformation = page.getByRole("combobox", {
			name: "Add information",
		});
		await addDetailsInformation.click();
		await expect(page.getByText("More case information")).toBeVisible();
		expect(await detailsRows.count()).toBe(originalDetailCount);
		await page
			.getByRole("option", { name: /Date opened.*Date and time/ })
			.click();
		await expect(
			detailsInformation.getByRole("button", {
				name: "Date opened",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Delete information" }),
		).toBeVisible();
		await page.getByRole("button", { name: "Delete information" }).click();
		const deletionDialog = page.getByRole("alertdialog");
		await expect(
			deletionDialog.getByText("Saved case data won’t change"),
		).toBeVisible();
		await deletionDialog.getByRole("button", { name: "Delete" }).click();
		await expect(
			detailsInformation.getByRole("button", {
				name: "Date opened",
				exact: true,
			}),
		).toHaveCount(0);
		await expect(addDetailsInformation).toBeFocused();
	});

	test("a module's display condition explains where it applies, and Preview runs the screen it governs", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await page.goto(seed.caseWorkspace.routes.condition);

		const heading = page.getByRole("heading", {
			name: `When \u201c${CASE_WORKSPACE_SEED.moduleName}\u201d appears`,
			level: 1,
		});
		await expect(heading).toBeVisible({ timeout: 20_000 });
		// The screen leads with the locus because that is what decides which
		// values the editor may offer at all.
		await expect(
			page.getByRole("heading", { name: "Where this is checked", level: 2 }),
		).toBeVisible();
		await expect(
			page.getByText("CommCare checks this on the home screen", {
				exact: false,
			}),
		).toBeVisible();
		await expect(
			page.getByText("not who may see the data behind it", { exact: false }),
		).toBeVisible();

		const conditionSection = page.locator(
			'section[aria-labelledby="display-condition-heading"]',
		);
		await expect(
			conditionSection.getByText(
				`\u201c${CASE_WORKSPACE_SEED.moduleName}\u201d always appears.`,
			),
		).toBeVisible();

		await conditionSection
			.getByRole("button", { name: "Add condition" })
			.click();
		// A module is decided before any case exists, so the seed compares a
		// session value rather than a case property.
		await expect(
			conditionSection.getByRole("button", {
				name: "Condition source: App information",
			}),
		).toBeVisible();
		// Relationship reads have no meaning before a case is chosen, and the
		// editor withholds them rather than letting the commit gate refuse.
		await conditionSection
			.getByRole("button", { name: "Add condition" })
			.click();
		const relatedCaseChoice = page.getByRole("menuitem", {
			name: /^Require a related case/,
		});
		// Withheld WITH its reason rather than silently absent — the
		// `data-disabled` attribute is what the menu's own styling keys on.
		await expect(relatedCaseChoice).toContainText("before a case is selected");
		await expect(relatedCaseChoice).toHaveAttribute("data-disabled", /.*/);
		await page.keyboard.press("Escape");

		// Preview runs the surface the condition governs — the home screen —
		// and leaves the authoring URL alone so exiting returns here.
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(
			page.locator("main").getByRole("button", {
				name: new RegExp(`^${CASE_WORKSPACE_SEED.moduleName}`),
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect(heading).toBeHidden();
		expect(new URL(page.url()).pathname).toBe(
			seed.caseWorkspace.routes.condition,
		);

		await page.getByRole("button", { name: "Back to edit" }).click();
		await expect(heading).toBeVisible();

		// Removing the condition leaves the item shown, and the empty state
		// says so in the author's own words.
		await conditionSection.getByRole("button", { name: "Always show" }).click();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Always show" })
			.click();
		await expect(
			conditionSection.getByText(
				`\u201c${CASE_WORKSPACE_SEED.moduleName}\u201d always appears.`,
			),
		).toBeVisible();
	});

	/**
	 * Visual parity for the tile-laid-out case list. Each assertion is a
	 * statement about what a CommCare client draws, so a regression here is
	 * a preview that has stopped agreeing with the device.
	 */
	test("a tile-laid-out case list renders at parity and pins its tile above the form", async ({
		page,
	}) => {
		await page.goto(seed.caseWorkspace.routes.tileResults);
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible({ timeout: 20_000 });

		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const tileList = page.locator('[data-case-results="tile"]');
		await expect(tileList).toBeVisible({ timeout: 20_000 });

		const tiles = tileList.locator('[data-case-tile="results"]');
		const rows = tileList.locator("[data-case-result-row]");
		await expect(tiles.first()).toBeVisible();

		await test.step("the grid is the occupied extent, not the 12-column canvas", async () => {
			// The seeded tile's widest cell ends at column 6. A renderer that
			// assumed the authoring canvas would draw every tile at half width.
			await expect(tiles.first()).toHaveAttribute("data-tile-columns", "6");
			const trackCount = await tiles
				.first()
				.evaluate(
					(el) =>
						getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length,
				);
			expect(trackCount).toBe(6);
		});

		await test.step("one tile per row, sized to its content", async () => {
			// `numEntitiesPerRow` resolves to 1 and `useUniformUnits` to false.
			expect(await tiles.count()).toBe(await rows.count());
			const [first, second] = await Promise.all([
				tiles.nth(0).boundingBox(),
				tiles.nth(1).boundingBox(),
			]);
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			if (first === null || second === null) return;
			expect(second.x).toBeCloseTo(first.x, 0);
			expect(second.y).toBeGreaterThan(first.y + first.height - 1);
		});

		await test.step("a boxed cell stretches while a plain sibling keeps its alignment", async () => {
			const tile = tiles.first();
			const boxed = tile.locator('[data-tile-cell="boxed"]').first();
			const inset = tile.locator('[data-tile-cell="inset"]').first();
			expect(
				await boxed.evaluate((el) => getComputedStyle(el).justifySelf),
			).toBe("stretch");
			expect(
				await inset.evaluate((el) => getComputedStyle(el).justifySelf),
			).toBe("start");

			const [tileBox, boxedBox, insetBox] = await Promise.all([
				tile.boundingBox(),
				boxed.boundingBox(),
				inset.boundingBox(),
			]);
			expect(tileBox).not.toBeNull();
			expect(boxedBox).not.toBeNull();
			expect(insetBox).not.toBeNull();
			if (tileBox === null || boxedBox === null || insetBox === null) return;
			// The boxed cell fills its two of six columns (less its margins);
			// the plain one hugs its text inside a wider span.
			expect(boxedBox.width).toBeGreaterThan((tileBox.width * 2) / 6 - 12);
			expect(insetBox.width).toBeLessThan(tileBox.width * 0.5);
		});

		await test.step("an authored cell action stays a sibling of the row action", async () => {
			// A phone link may never be nested inside the row's primary button:
			// HTML forbids it, and a worker reaching the number would open the
			// case instead of dialling.
			const firstRow = rows.first();
			const phone = firstRow.getByRole("link", { name: /^Call / });
			await expect(phone).toBeVisible();
			expect(
				await phone.evaluate((el) =>
					el.closest("[data-case-result-action]") === null
						? "sibling"
						: "nested",
				),
			).toBe("sibling");
			const phoneBox = await phone.boundingBox();
			expect(phoneBox).not.toBeNull();
			expect(phoneBox?.height ?? 0).toBeGreaterThanOrEqual(44);
			await phone.focus();
			await expect(phone).toBeFocused();
		});

		await test.step("the same tile pins above the module's form", async () => {
			await rows.first().locator("[data-case-result-action]").click();
			const persistent = page.locator("[data-persistent-case-tile]");
			await expect(persistent).toBeVisible({ timeout: 20_000 });
			await expect(
				persistent.locator('[data-case-tile="persistent"]'),
			).toHaveAttribute("data-tile-columns", "6");

			// Context, not a chooser: nothing in the band opens a case.
			await expect(persistent.locator("[data-case-result-action]")).toHaveCount(
				0,
			);

			const [band, formHeader] = await Promise.all([
				persistent.boundingBox(),
				page.locator("[data-form-header]").boundingBox(),
			]);
			expect(band).not.toBeNull();
			expect(formHeader).not.toBeNull();
			if (band === null || formHeader === null) return;
			expect(band.y + band.height).toBeLessThanOrEqual(formHeader.y + 1);
		});

		await test.step("the band stays pinned while the form scrolls beneath it", async () => {
			// A short window is what makes the form overflow at all; without it
			// there is nothing to scroll and the sticky contract goes untested.
			await page.setViewportSize({ width: 1280, height: 420 });
			const persistent = page.locator("[data-persistent-case-tile]");
			const before = await persistent.boundingBox();
			const scroller = page.locator("[data-preview-scroll-container]").first();
			await expect
				.poll(async () =>
					scroller.evaluate((el) => el.scrollHeight - el.clientHeight),
				)
				.toBeGreaterThan(0);
			await scroller.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
			});
			await expect
				.poll(async () => scroller.evaluate((el) => el.scrollTop))
				.toBeGreaterThan(0);
			const after = await persistent.boundingBox();
			expect(before).not.toBeNull();
			expect(after).not.toBeNull();
			if (before === null || after === null) return;
			expect(after.y).toBeCloseTo(before.y, 0);
			await page.setViewportSize({ width: 1280, height: 720 });
		});
	});

	/**
	 * The tile's AUTHORING surface, which the parity test above never
	 * enters. Everything asserted here is something a state test cannot
	 * see: that a keyboard gesture round-trips through the real commit gate
	 * and comes back with the cell's new place in its accessible name, that
	 * a refused gesture states its reason and leaves the cell where it was,
	 * and that focus survives the commit.
	 *
	 * It deliberately restores the arrangement it found, because the seed's
	 * tile module is shared with the parity test above.
	 */
	test("the tile grid moves a field by keyboard and states a refused move", async ({
		page,
	}) => {
		await page.goto(seed.caseWorkspace.routes.tileResults);
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible({ timeout: 20_000 });

		await test.step("Results is arranged as a tile, and says how wide it draws", async () => {
			await expect(
				page.getByRole("group", { name: /^Tile layout, 12 columns/ }),
			).toBeVisible();
			// `exact` matters: the seeded module is called "Patient tile".
			await expect(
				page.getByRole("button", { name: "Tile", exact: true }),
			).toHaveAttribute("aria-pressed", "true");
			// The occupied extent, not the 12-column authoring canvas — the
			// same fact the running list's grid is built from.
			await expect(
				page.getByText(/This tile uses 6 columns and 3 rows/),
			).toBeVisible();
		});

		const phone = page.getByRole("button", {
			name: "Phone number, columns 1 to 6, row 3",
		});

		await test.step("an arrow key moves the field and renames its place", async () => {
			await phone.focus();
			await phone.press("ArrowDown");
			const moved = page.getByRole("button", {
				name: "Phone number, columns 1 to 6, row 4",
			});
			await expect(moved).toBeVisible();
			// The commit replaced the doc; the cell must still hold focus.
			await expect(moved).toBeFocused();
			await expect(
				page.getByText(/This tile uses 6 columns and 4 rows/),
			).toBeVisible();
		});

		await test.step("a move onto an occupied square is refused, and says why", async () => {
			const patient = page.getByRole("button", {
				name: "Patient, columns 1 to 4, row 1",
			});
			await patient.focus();
			await patient.press("ArrowDown");
			// Twice on purpose: the canvas states the reason where the author
			// is looking, and the live region announces the same words.
			await expect(
				page.getByText(
					"Patient would sit on top of Village. Two fields can’t share a square on a tile — one would be drawn over the other.",
				),
			).toHaveCount(2);
			// Refused means unmoved, not moved-and-reverted.
			await expect(patient).toBeVisible();
			await expect(patient).toBeFocused();
		});

		await test.step("the arrangement returns to where it started", async () => {
			const moved = page.getByRole("button", {
				name: "Phone number, columns 1 to 6, row 4",
			});
			await moved.focus();
			await moved.press("ArrowUp");
			await expect(
				page.getByRole("button", {
					name: "Phone number, columns 1 to 6, row 3",
				}),
			).toBeVisible();
			await expect(
				page.getByText(/This tile uses 6 columns and 3 rows/),
			).toBeVisible();
		});
	});

	test("/build/new renders the new-app builder (no LLM)", async ({ page }) => {
		await page.goto("/build/new");
		await expect(page).toHaveURL(/\/build\/new/);
		await expect(
			page.getByRole("button", { name: "Account menu" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("button", { name: "Attach a file" }),
		).toBeVisible();
	});

	test("the blank-app escape hatch mints a real app and opens it (no LLM)", async ({
		page,
	}) => {
		await page.goto("/build/new");

		const startBlank = page.getByRole("button", {
			name: "Start with a blank app",
		});
		await expect(startBlank).toBeVisible({ timeout: 20_000 });

		// The chat owns the screen until an app exists, so the sidebar chrome is
		// absent here — this is the "centered, phase = Idle" state.
		await expect(
			page.getByRole("button", { name: "Collapse chat sidebar" }),
		).toHaveCount(0);

		await startBlank.click();

		// The real createBlankApp Server Action → createApp → router.replace.
		await page.waitForURL(/\/build\/(?!new)[\w-]+$/, { timeout: 30_000 });

		// The chat DOCKED, which only happens once `docHasData` (moduleOrder is
		// non-empty). That is the load-bearing assertion: a blank app that shipped
		// with zero modules would render the centered chat again — and would fail
		// the export validator with NO_MODULES.
		await expect(
			page.getByRole("button", { name: "Collapse chat sidebar" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(startBlank).toHaveCount(0);
	});

	test("conversations open at the bottom and switch without exposing the prior transcript", async ({
		page,
	}) => {
		await page.goto(`/build/${seed.threadsAppId}`);

		// Docked chat — the app has a module, so the sidebar chrome mounts.
		await expect(
			page.getByRole("button", { name: "Collapse chat sidebar" }),
		).toBeVisible({ timeout: 20_000 });

		// The seeded transcript hydrated into the LIVE message path (server
		// rows → RSC props → useChat initial messages), not a separate
		// historical rendering.
		await expect(page.getByText(seed.threadUserText)).toBeAttached();
		await expect(page.getByText(seed.threadAssistantText)).toBeVisible();
		expect(await bottomGap(page)).toBeLessThanOrEqual(1);

		// History is a labeled action below the title bar. The list replaces the
		// transcript with full-width rows — summary is the first user text.
		await page.getByRole("button", { name: "History" }).click();
		await expect(page.getByText("Initial build")).toBeVisible();
		await expect(page.getByText("Edit", { exact: true })).toBeVisible();
		await expect(page.getByText(seed.threadAssistantText)).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Back to chat" }),
		).toBeVisible();

		// Hold the older-thread request. While it is loading, History must stay
		// over the transcript instead of flashing the original conversation.
		let releaseThreadRequest: (() => void) | undefined;
		const threadRequestGate = new Promise<void>((resolve) => {
			releaseThreadRequest = resolve;
		});
		await page.route(
			`**/api/apps/${seed.threadsAppId}/threads/${seed.olderThreadId}`,
			async (route) => {
				await threadRequestGate;
				await route.continue();
			},
		);
		await page
			.getByRole("button", { name: new RegExp(seed.olderThreadUserText) })
			.click();
		await expect(
			page.getByText("Conversations", { exact: true }),
		).toBeVisible();
		await expect(page.getByText(seed.threadAssistantText)).toHaveCount(0);
		releaseThreadRequest?.();

		// The requested transcript replaces the list in one commit and is already
		// at the bottom — no smooth trip through historical messages.
		await page.getByText(seed.olderThreadAssistantText).waitFor();
		expect(await bottomGap(page)).toBeLessThanOrEqual(1);
		await expect(page.getByText(seed.threadAssistantText)).toHaveCount(0);

		// New chat starts fresh: transcript gone, edit-mode empty state shown.
		await page.getByRole("button", { name: "New chat" }).click();
		await expect(page.getByText(seed.olderThreadAssistantText)).toHaveCount(0);
		await expect(
			page.getByText("What changes would you like to make?"),
		).toBeVisible();

		// The old conversation is one list-click away — nothing was lost.
		await page.getByRole("button", { name: "History" }).click();
		await page.getByText(seed.threadUserText).click();
		await expect(page.getByText(seed.threadAssistantText)).toBeVisible({
			timeout: 10_000,
		});
	});

	test("sending a message returns the view to it — a jump, never an animated trip", async ({
		page,
	}) => {
		const stub = await stubChatSends(page);
		await page.goto(`/build/${seed.scrollAppId}`);

		// The settled conversation opens already at the bottom.
		await expect(page.getByText(seed.scrollThreadAssistantText)).toBeVisible({
			timeout: 20_000,
		});
		expect(await bottomGap(page)).toBeLessThanOrEqual(1);

		const composer = page.getByPlaceholder("Describe a change");
		const submit = page.getByRole("button", { name: "Submit" });

		// Re-reading history escapes the bottom pin: the view holds still and
		// the return affordance appears — nothing yanks the reader around.
		await wheelScrollLog(page, -30_000);
		await expect(
			page.getByRole("button", { name: "Scroll to latest" }),
		).toBeVisible();
		await expect.poll(() => logScrollTop(page)).toBeLessThanOrEqual(1);

		// Config 1 — send from the TOP of a tall transcript. The view must jump
		// straight to the new message: no scroll sample may land in the interior
		// of the transcript (an animated scroll leaves a dense trail there).
		const preSendMax = await armScrollTrace(page);
		expect(preSendMax).toBeGreaterThan(400); // tall enough to prove a jump
		await composer.fill("Smoke: rename the referral module");
		await submit.click();
		await expect(
			page.getByText("Smoke: rename the referral module"),
		).toBeVisible();
		await expect(page.getByText(stub.reply(1))).toBeVisible();
		await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
		const trace = await readScrollTrace(page);
		expect(trace.length).toBeGreaterThan(0);
		expect(trace.filter((y) => y > 60 && y < preSendMax - 60)).toEqual([]);

		// Config 2 — send while already AT the bottom: the reply streams in and
		// the view stays pinned to it.
		await composer.fill("Smoke: also rename the form");
		await submit.click();
		await expect(page.getByText(stub.reply(2))).toBeVisible();
		await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
	});

	test("answering a waiting question round returns the view to the conversation tail", async ({
		page,
	}) => {
		const stub = await stubChatSends(page);
		await page.goto(`/build/${seed.scrollAppId}`);
		await expect(page.getByText(seed.scrollThreadAssistantText)).toBeVisible({
			timeout: 20_000,
		});

		// Open the paused conversation from History — it lands at the bottom
		// with the question card waiting, no animated travel to get there.
		await page.getByRole("button", { name: "History" }).click();
		await page
			.getByRole("button", {
				name: new RegExp(seed.scrollQuestionThreadUserText),
			})
			.click();
		await expect(page.getByText(seed.scrollQuestionHeader)).toBeVisible();
		await expect(page.getByText(seed.scrollQuestionOneText)).toBeVisible();
		expect(await bottomGap(page)).toBeLessThanOrEqual(1);

		// Config 3 — TYPE an answer from the top of the transcript. A typed
		// message while a card waits routes as that question's answer; it is a
		// local turn, so the view jumps back to the card (which advances to the
		// next question) without an animated trip.
		await wheelScrollLog(page, -30_000);
		await expect(
			page.getByRole("button", { name: "Scroll to latest" }),
		).toBeVisible();
		await expect.poll(() => logScrollTop(page)).toBeLessThanOrEqual(1);
		const preAnswerMax = await armScrollTrace(page);
		const composer = page.getByPlaceholder("Describe a change");
		await composer.fill("The community team handles it");
		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page.getByText(seed.scrollQuestionTwoText)).toBeVisible();
		await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
		const trace = await readScrollTrace(page);
		expect(trace.length).toBeGreaterThan(0);
		expect(trace.filter((y) => y > 60 && y < preAnswerMax - 60)).toEqual([]);

		// Config 4 — CLICK the final option after nudging the view off the
		// bottom (escaping the pin while the card stays on screen). The answered
		// round auto-resends the turn — a local send, so the streamed reply must
		// land pinned in view rather than growing below the fold.
		await wheelScrollLog(page, -150);
		await expect(
			page.getByRole("button", { name: "Scroll to latest" }),
		).toBeVisible();
		// Click near the option's left edge — the centered Scroll-to-latest
		// overlay floats over the card's midline in this escaped position.
		await page
			.getByRole("button", { name: seed.scrollQuestionFinalOption })
			.click({ position: { x: 24, y: 12 } });
		await expect(page.getByText(stub.reply(1))).toBeVisible();
		await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
	});

	test("GET /api/auth/get-session returns the seeded user", async ({
		request,
	}) => {
		// Proves the forged cookie → Better Auth → Kysely/Postgres adapter read path
		// round-trips in the live app: if better-auth/better-call signing or the
		// adapter's session lookup drifted, this returns null.
		const res = await request.get("/api/auth/get-session");
		expect(res.status()).toBe(200);
		const body = (await res.json()) as { user?: { email?: string } } | null;
		expect(body?.user?.email).toBe(seed.userEmail);
	});

	test("delete an app through the UI moves it out of the active list", async ({
		page,
	}) => {
		await page.goto("/");

		// Count active throwaway cards by HEADING. AppListBody renders only the
		// active view, so a soft-deleted card leaves the DOM — but a *confirming*
		// card keeps its heading, so the count drops only on a real deletion (a
		// link-count would false-pass the moment the card flips out of <a>).
		const deleteHeadings = page.getByRole("heading", {
			name: seed.deleteAppName,
			level: 3,
		});
		// Wait for the list to render before counting — `count()` doesn't auto-wait
		// and would otherwise read 0 mid-hydration.
		await expect(deleteHeadings.first()).toBeVisible();
		const before = await deleteHeadings.count();
		expect(before).toBeGreaterThan(0);

		// Trash → confirm on the first throwaway card. Its app-specific accessible
		// name disambiguates the sibling action from every other card; exactly one
		// confirm dialog is open at a time, so target Confirm at the page level.
		// This is the real deleteApp Server Action → softDeleteApp →
		// revalidatePath("/") round-trip.
		await page
			.getByRole("button", {
				name: `Move ${seed.deleteAppName} to recently deleted`,
			})
			.first()
			.click();
		await page.getByRole("button", { name: "Confirm delete" }).click();

		// One fewer active card, and the trash tab is present. Idempotent under
		// retries: the seed mints several throwaway apps, so each attempt consumes
		// a fresh one.
		await expect(deleteHeadings).toHaveCount(before - 1, { timeout: 15_000 });
		await expect(
			page.getByRole("tab", { name: "Recently deleted" }),
		).toBeVisible();
	});

	/**
	 * The cross-Project move, end to end.
	 *
	 * Compact first, then desktop, in ONE sequential journey: the app leaves the
	 * source list and STAYS gone across a reload, while still opening in the
	 * builder. That pair is the arrival proof — the builder authorizes through the
	 * app's CURRENT Project and the viewer's membership in it, so an app that had
	 * landed anywhere this user does not belong would 404 instead.
	 *
	 * Deliberately does NOT switch the active Project to look: that writes to the
	 * SHARED seeded session, which every later test reads.
	 *
	 * The seed mints one throwaway app per Playwright attempt (`MOVE_APP_COUNT`),
	 * since a moved app is gone from the source Project — the same idempotency
	 * rule the delete test follows.
	 */
	test("an owner moves an app to another Project and it stays moved", async ({
		page,
	}) => {
		// Compact width: the placement control and its popover must be reachable
		// on a phone-sized canvas, not only on the desktop grid.
		await page.setViewportSize({ width: 390, height: 780 });
		await page.goto("/");

		const moveControl = page
			.getByRole("button", {
				name: `Move ${seed.moveAppName} to another Project`,
			})
			.first();
		await expect(moveControl).toBeVisible();
		const box = await moveControl.boundingBox();
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

		const moveHeadings = page.getByRole("heading", {
			name: seed.moveAppName,
			level: 3,
		});
		await expect(moveHeadings.first()).toBeVisible();
		const before = await moveHeadings.count();
		expect(before).toBeGreaterThan(0);

		// Capture WHICH app this attempt is about to move — a retry consumes the
		// next throwaway card, so a fixed seeded id would name the wrong one.
		const movedHref = await page
			.getByRole("link", { name: `Open ${seed.moveAppName}` })
			.first()
			.getAttribute("href");
		expect(movedHref).toMatch(/^\/build\//);

		await page.setViewportSize({ width: 1280, height: 900 });
		await moveControl.click();
		await expect(page.getByText(CROSS_PROJECT_MOVE_DISCLOSURE)).toBeVisible();

		// Choosing a destination is required before the action arms.
		const moveButton = page.getByRole("button", { name: "Move app" });
		await expect(moveButton).toBeDisabled();
		const destination = page.getByRole("radio", {
			name: seed.moveProjectName,
		});
		await expect(destination).not.toBeChecked();
		await destination.check();
		await expect(destination).toBeChecked();
		await expect(moveButton).toBeEnabled();
		await moveButton.click();

		// The real moveApp Server Action → move transaction → revalidatePath("/").
		await expect(moveHeadings).toHaveCount(before - 1, { timeout: 20_000 });

		// A reload proves the app left this Project durably, not optimistically.
		await page.reload();
		await expect(
			page.getByRole("heading", { name: seed.openAppName, level: 3 }),
		).toBeVisible();
		await expect(moveHeadings).toHaveCount(before - 1);

		// …and arrived somewhere this user still belongs: the builder authorizes
		// through the app's CURRENT Project, so a stranded app would 404 here.
		await page.goto(movedHref ?? "");
		await expect(
			page.getByRole("button", { name: "Account menu" }),
		).toBeVisible();
	});

	/**
	 * The Project data workspace's reason to exist, end to end: a shared table
	 * is there, it can be opened, and a question can be pointed at one of its
	 * columns.
	 *
	 * This path exists because the two defects that shipped through review —
	 * a table picker that silently did nothing, and a date-and-time cell that
	 * erased itself — both passed the type checker, the linter, and every pure
	 * test. They were only visible by driving the surface. `View = f(state)`
	 * makes the state model the right unit for Vitest; it does not make the
	 * composition around it verify itself.
	 */
	test("a select can be pointed at a shared data table's column", async ({
		page,
	}) => {
		test.setTimeout(120_000);

		// 1. The workspace lists the Project's tables, and says they are shared.
		await page.goto(seed.caseWorkspace.routes.projectData);
		await expect(
			page.getByRole("heading", { name: "Data tables", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByText("shared with every app in this project", { exact: false }),
		).toBeVisible();

		// Export identity is visible before opening a table; authors do not need
		// to enter an admin-only edit control merely to discover it.
		await expect(
			page.getByText(`Export tag: ${CASE_WORKSPACE_SEED.lookupTableTag}`, {
				exact: true,
			}),
		).toBeVisible();

		// 2. A table with no rows still exposes its schema and column settings.
		await page
			.getByRole("button", {
				name: new RegExp(`^${CASE_WORKSPACE_SEED.emptyLookupTableName}`),
			})
			.click();
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.emptyLookupTableName,
				level: 1,
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("columnheader", {
				name: new RegExp(CASE_WORKSPACE_SEED.emptyLookupColumnLabel),
			}),
		).toBeVisible();
		await expect(
			page.getByText("This table has its columns but no rows yet.", {
				exact: false,
			}),
		).toBeVisible();
		await page
			.getByRole("button", {
				name: new RegExp(CASE_WORKSPACE_SEED.emptyLookupColumnLabel),
			})
			.click();
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.emptyLookupColumnLabel,
				level: 2,
			}),
		).toBeVisible();

		// 3. Opening the populated table shows its rows — the read path,
		// columns, tag and all.
		await page.getByRole("button", { name: "All data tables" }).click();
		await page
			.getByRole("button", {
				name: new RegExp(`^${CASE_WORKSPACE_SEED.lookupTableName}`),
			})
			.click();
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.lookupTableName,
				level: 1,
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("columnheader", {
				name: new RegExp(CASE_WORKSPACE_SEED.lookupLabelColumnLabel),
			}),
		).toBeVisible();
		await expect(
			page.getByText(`Export tag: ${CASE_WORKSPACE_SEED.lookupTableTag}`, {
				exact: true,
			}),
		).toBeVisible();
		await expect(page.getByText("District hospital")).toBeVisible();

		// Opening an already-visible search result keeps the author's search.
		// Only a newly minted row needs the grid to clear filters and reveal it.
		const findRow = page.getByRole("searchbox", { name: "Find a row" });
		await findRow.fill("District hospital");
		const districtRow = page.getByRole("row", {
			name: /District hospital/,
		});
		const openedRow = districtRow.getByRole("button", {
			name: /^Open row/,
		});
		await openedRow.click();
		await expect(findRow).toHaveValue("District hospital");
		const destination = page.getByRole("textbox", {
			name: new RegExp(`^${CASE_WORKSPACE_SEED.lookupLabelColumnLabel}`),
		});
		const openingTime = page.getByRole("textbox", {
			name: `${CASE_WORKSPACE_SEED.lookupTimeColumnLabel} time`,
		});
		await expect(openingTime).toHaveValue("09:30:00.125");
		await expect(
			page.getByRole("textbox", {
				name: `${CASE_WORKSPACE_SEED.lookupDatetimeColumnLabel} time`,
			}),
		).toHaveValue("14:45:00");
		// Draft ownership is the controller's contract, not the rail body's.
		// Close, another selection, a table route, and Escape all unmount the
		// body; each must recover the exact typed value.
		await destination.fill("  District hospital  ");
		await openingTime.fill("10:00 AM");
		await openingTime.fill("09:30:00.125");
		await page
			.getByRole("button", { name: "Close properties", exact: true })
			.click();
		await expect(
			page.getByText("One unsaved row draft is kept in this table."),
		).toBeVisible();
		await page.getByRole("button", { name: "Review draft" }).click();
		await expect(destination).toHaveValue("  District hospital  ");
		await expect(openingTime).toHaveValue("09:30:00.125");

		await page
			.getByRole("button", {
				name: new RegExp(CASE_WORKSPACE_SEED.lookupLabelColumnLabel),
			})
			.first()
			.click();
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.lookupLabelColumnLabel,
				level: 2,
			}),
		).toBeVisible();
		await page.getByRole("button", { name: "Review draft" }).click();
		await expect(destination).toHaveValue("  District hospital  ");

		await page.getByRole("button", { name: "All data tables" }).click();
		await page
			.getByRole("button", {
				name: new RegExp(`^${CASE_WORKSPACE_SEED.lookupTableName}`),
			})
			.click();
		await page.getByRole("button", { name: "Review draft" }).click();
		await expect(destination).toHaveValue("  District hospital  ");

		await page.getByRole("button", { name: "Add row" }).focus();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "Close properties", exact: true }),
		).toBeHidden();
		await expect(openedRow).toBeFocused();
		await page.getByRole("button", { name: "Review draft" }).click();
		await expect(destination).toHaveValue("  District hospital  ");
		await page.getByRole("button", { name: "Save row" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "Saved." }),
		).toBeVisible();
		await expect(destination).toHaveValue("  District hospital  ");
		await expect(
			districtRow.getByText("09:30:00.125+05:30", { exact: true }),
		).toBeVisible();
		await expect(
			districtRow.getByText("2026-07-26T14:45:00-04:00", {
				exact: true,
			}),
		).toBeVisible();
		await findRow.fill("");

		// A rapid repeated gesture creates exactly one row, and the returned row
		// is selected/revealed immediately instead of being stranded off-page.
		const rowsBefore = await page.getByRole("row").count();
		const addRow = page.getByRole("button", { name: "Add row" });
		await addRow.dblclick();
		await expect(
			page.getByRole("status").filter({
				hasText: "Added and opened a new empty row.",
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole("row")).toHaveCount(rowsBefore + 1);
		await expect(page.getByRole("button", { name: "Save row" })).toBeVisible();

		// 4. The gesture the unit is for: bind a question's choices to a column.
		await page.goto(seed.caseWorkspace.routes.selectField);
		const source = page.getByRole("combobox", {
			name: "Where the choices come from",
		});
		await expect(source).toBeVisible({ timeout: 20_000 });
		// It starts on the field's own typed-in options.
		await expect(source).toHaveText("The options typed in here");

		await source.click();
		await page
			.getByRole("option", { name: CASE_WORKSPACE_SEED.lookupTableName })
			.click();

		/* The bind is what the picker could not do before: the two column
		 * pickers appearing IS the proof, because they render only once the
		 * source holds a real table plus both of its columns. */
		await expect(
			page.getByRole("combobox", { name: "Value that gets saved" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("combobox", { name: "Value people see" }),
		).toBeVisible();
		await expect(source).toHaveText(CASE_WORKSPACE_SEED.lookupTableName);
		await expect(
			page.getByRole("combobox", { name: "Value that gets saved" }),
		).toHaveText(CASE_WORKSPACE_SEED.lookupValueColumnLabel);
		await expect(
			page.getByRole("combobox", { name: "Value people see" }),
		).toHaveText(CASE_WORKSPACE_SEED.lookupValueColumnLabel);

		// 5. And back again — the typed-in options were kept, not replaced.
		await source.click();
		await page
			.getByRole("option", { name: "The options typed in here" })
			.click();
		await expect(source).toHaveText("The options typed in here", {
			timeout: 20_000,
		});
		await expect(
			page.getByRole("combobox", { name: "Value that gets saved" }),
		).toBeHidden();
	});
});
