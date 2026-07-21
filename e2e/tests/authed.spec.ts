import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
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
	caseWorkspace: {
		routes: {
			search: string;
			results: string;
			details: string;
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
		await expect(page.getByText(seed.openAppName)).toBeVisible();

		// Open the app — each card is a single <a href="/build/{id}">. getByRole's
		// `name` does a substring match, so the plain string suffices (no RegExp,
		// no regex-injection risk if a name ever contains a metachar).
		await page.getByRole("link", { name: seed.openAppName }).click();
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
			"Add or replace the cases saved for the Patient case type. They’re used throughout your app and in Preview.",
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

		// Trash → confirm on the first throwaway card. The trash click flips THAT
		// card to a confirming state (re-rendered as a non-link); exactly one
		// confirm dialog is open at a time, so target Confirm at the page level.
		// This is the real deleteApp Server Action → softDeleteApp →
		// revalidatePath("/") round-trip.
		await page
			.getByRole("link", { name: seed.deleteAppName })
			.first()
			.getByRole("button", { name: "Delete app" })
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
});
