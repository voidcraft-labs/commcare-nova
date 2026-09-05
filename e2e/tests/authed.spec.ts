import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page, Request } from "@playwright/test";
import { CROSS_PROJECT_MOVE_DISCLOSURE } from "../../lib/projects/moveTargets";
import {
	CASE_CHANGES_ROUTINE,
	CASE_CHANGES_SEED,
	CASE_CHANGES_SEQUENCE_LENGTH,
} from "../lib/caseChangesSeed";
import {
	CASE_WORKSPACE_SEED,
	SEEDED_TEMPORAL_DISPLAY,
} from "../lib/caseWorkspaceSeed";
import { attachErrorGuard } from "../lib/errorGuard";
import { expect, test } from "../lib/fixtures";
import { FORM_LINKS_SEED } from "../lib/formLinksSeed";
import { FORM_SECTIONS_SEED } from "../lib/formSectionsSeed";
import { SEARCH_FIRST_SEED } from "../lib/searchFirstSeed";

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
	organizationAppName: string;
	deleteAppName: string;
	openAppId: string;
	organizationAppIds: string[];
	organizationCaseChangeRoutes: string[];
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
	designBuildActivation: {
		eventVersion: 1;
		designSessionId: string;
		appId: string;
		projectId: string;
		role: string;
		canEdit: boolean;
		seq: 1;
		batchId: string;
		changeSetId: string;
		snapshotDigest: string;
		blueprint: Record<string, unknown>;
		starter: null;
	};
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
			groupedResults: string;
			projectData: string;
			selectField: string;
			tileForm: string;
		};
	};
	caseChanges: {
		appId: string;
		route: string;
		identityProjectionRoute: string;
		caseId: string;
		viewerStateFile: string;
	}[];
	formLinks: {
		appId: string;
		route: string;
		caseId: string;
	}[];
	searchFirst: {
		appId: string;
		routes: {
			searchConfig: string;
			results: string;
			registerForm: string;
		};
		caseId: string;
	}[];
	formSections: { appId: string; route: string };
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
 * contract (`transportContract.postgres.test.ts`): SSE `data:` lines
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

type ScriptedChunk = { type: string; [key: string]: unknown };

function designProgressEnvelope(
	designSessionId: string,
	revision: number,
	data: unknown,
): Record<string, unknown> {
	return {
		eventVersion: 1,
		designSessionId,
		orchestrationEventId: `scripted-event-${revision}`,
		orchestrationRevision: revision,
		data,
	};
}

/** Three deterministic responses exercise the real chat/UI state machine:
 * pre-app question → materialized but still locked question → completion.
 * The route never reaches Nova's server, provider, or usage meter. */
async function stubDesignBuildJourney(
	page: Page,
	activation: SeedManifest["designBuildActivation"],
): Promise<void> {
	let sends = 0;
	const sessionId = activation.designSessionId;
	const ask = (
		toolCallId: string,
		header: string,
		question: string,
		options: { label: string }[],
	): ScriptedChunk[] => [
		{ type: "tool-input-start", toolCallId, toolName: "askQuestions" },
		{
			type: "tool-input-available",
			toolCallId,
			toolName: "askQuestions",
			input: { header, questions: [{ question, options }] },
		},
	];
	const textChunks = (id: string, text: string): ScriptedChunk[] => [
		{ type: "text-start", id },
		{ type: "text-delta", id, delta: text },
		{ type: "text-end", id },
	];

	await page.route("**/api/chat", async (route) => {
		if (route.request().method() !== "POST") {
			await route.fallback();
			return;
		}
		sends += 1;
		let chunks: ScriptedChunk[];
		if (sends === 1) {
			chunks = [
				{ type: "start", messageId: "scripted-design-1" },
				{ type: "start-step" },
				{
					type: "data-design-session",
					data: { designSessionId: sessionId, materializedAppId: null },
				},
				{
					type: "data-design-pulse",
					data: designProgressEnvelope(sessionId, 1, {
						phase: "review",
						chars: 120,
					}),
				},
				...textChunks(
					"scripted-design-text",
					"I’ve outlined the referral flow. One detail will make the follow-up queue fit your team.",
				),
				{
					type: "data-design-outline",
					data: designProgressEnvelope(sessionId, 2, {
						objective: "Track referrals from intake through follow-up",
						actors: ["Intake worker", "Follow-up coordinator"],
						tasks: ["Register a referral", "Record follow-up"],
						records: ["Referral"],
						lists: ["Open referrals"],
						assumptions: [],
						blockingQuestions: ["How quickly should follow-up begin?"],
						outOfScope: [],
						reviewed: true,
					}),
				},
				{
					type: "data-build-plan-summary",
					data: designProgressEnvelope(sessionId, 3, {
						sliceCount: 1,
						sliceNames: ["Referral intake and follow-up"],
						externalActionCount: 0,
					}),
				},
				...ask(
					"scripted-design-question",
					"A follow-up detail",
					"How quickly should follow-up begin?",
					[],
				),
				{ type: "finish-step" },
				{ type: "finish" },
			];
		} else if (sends === 2) {
			chunks = [
				{ type: "start", messageId: "scripted-design-2" },
				{ type: "start-step" },
				{
					type: "data-design-session",
					data: { designSessionId: sessionId, materializedAppId: null },
				},
				...textChunks(
					"scripted-build-text",
					"Thanks. I’m building the referral workflow now.",
				),
				{
					type: "data-build-slice-started",
					data: designProgressEnvelope(sessionId, 4, {
						sliceId: "scripted-slice-1",
						sliceName: "Referral intake and follow-up",
					}),
				},
				{
					type: "data-build-slice-committed",
					data: designProgressEnvelope(sessionId, 5, {
						sliceId: "scripted-slice-1",
						sliceName: "Referral intake and follow-up",
						seq: 1,
					}),
				},
				{ type: "data-app-materialized", data: activation },
				...ask(
					"scripted-build-question",
					"One final choice",
					"Who should see the follow-up queue?",
					[{ label: "Follow-up coordinators" }],
				),
				{ type: "finish-step" },
				{ type: "finish" },
			];
		} else {
			chunks = [
				{ type: "start", messageId: "scripted-design-3" },
				{ type: "start-step" },
				{
					type: "data-design-session",
					data: {
						designSessionId: sessionId,
						materializedAppId: activation.appId,
					},
				},
				...textChunks(
					"scripted-finish-text",
					"Your referral app is ready to try.",
				),
				{
					type: "data-build-completion",
					data: designProgressEnvelope(sessionId, 6, {
						appId: activation.appId,
						appSeq: 1,
						plannedSlices: 1,
					}),
				},
				{
					type: "data-done",
					data: { doc: activation.blueprint, seq: 1, success: true },
				},
				{ type: "finish-step" },
				{ type: "finish" },
			];
		}
		await route.fulfill({
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-workflow-run-id": `00000000-0000-4000-8000-00000000001${sends}`,
			},
			body: `${chunks
				.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
				.join("")}data: [DONE]\n\n`,
		});
	});
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
			page.getByRole("heading", { name: "Your apps", level: 1 }),
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

		// A born-valid canonical starter opens in the builder with chat available
		// for refinement. The chat composer carries the arrival wait: it is the
		// first thing that is unique to THIS route, whereas the account menu is
		// shared chrome that the page we just left also rendered, so waiting on
		// the menu can be satisfied before the builder has mounted at all.
		await expect(
			page.getByRole("button", { name: "Attach a file" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("button", { name: "Account menu" }),
		).toBeVisible();
		// Authed, not bounced to the landing page.
		await expect(
			page.getByRole("button", { name: "Sign in with Google" }),
		).toHaveCount(0);
	});

	test("authors and restores a responsive organization hierarchy", async ({
		page,
		baseURL,
	}, testInfo) => {
		test.setTimeout(300_000);
		const appId = seed.organizationAppIds[testInfo.retry];
		expect(appId).toBeTruthy();
		await page.goto(`/build/${appId}/setup/organization`);

		const levels = page.getByRole("region", { name: "Levels" });
		const places = page.getByRole("region", { name: "Places" });
		await expect(levels.getByRole("heading", { name: "Levels" })).toBeVisible();
		await expect(
			places.getByText("Add a level before adding its places."),
		).toBeVisible();

		await levels.getByRole("button", { name: "Add level" }).click();
		await expect(levels.getByLabel("Level name")).toBeFocused();
		await levels.getByLabel("Level name").fill("Cancelled level");
		await levels.getByRole("button", { name: "Cancel" }).click();
		await expect(
			levels.getByRole("button", { name: "Add level" }),
		).toBeFocused();

		await levels.getByRole("button", { name: "Add level" }).click();
		await expect(levels.getByLabel("Level name")).toBeFocused();
		await levels.getByLabel("Level name").fill("Region");
		await levels.getByLabel("Level name").press("Enter");
		await expect(levels.getByRole("button", { name: /Region/ })).toBeFocused();

		await levels.getByRole("button", { name: "Add level" }).click();
		await expect(levels.getByLabel("Level name")).toBeFocused();
		await levels.getByLabel("Level name").fill("District");
		await levels.getByLabel("Level name").press("Enter");
		const districtLevel = levels.getByRole("button", { name: /District/ });
		await expect(districtLevel).toBeFocused();
		await expect(
			levels
				.getByRole("checkbox", { name: "Places here own cases" })
				.filter({ visible: true }),
		).toBeChecked();
		await levels.getByRole("button", { name: "Change" }).click();
		await expect(
			levels.getByLabel("Stop descending at").filter({ visible: true }),
		).toHaveText("No limit");
		await expect(
			levels
				.getByLabel("Also carry the top of the organization down to")
				.filter({ visible: true }),
		).toHaveText("Do not carry the top down");
		await levels
			.getByLabel("How much of the organization workers here can see")
			.filter({ visible: true })
			.click();
		await page.getByRole("option", { name: "The whole organization" }).click();
		await expect(
			levels
				.getByLabel("How much of the organization workers here can see")
				.filter({ visible: true }),
		).toContainText("The whole organization");

		await levels.getByRole("button", { name: "Add level" }).click();
		await levels.getByLabel("Level name").fill("Temporary");
		await levels.getByLabel("Level name").press("Enter");
		await levels.getByRole("button", { name: "Remove level" }).click();
		await levels.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(districtLevel).toBeFocused();

		const placeInformation = page.getByRole("region", {
			name: "Place information",
		});
		await placeInformation
			.getByRole("button", { name: "Add information" })
			.click();
		await expect(placeInformation.getByLabel("Name")).toBeFocused();
		await placeInformation.getByLabel("Name").fill("Facility kind");
		await placeInformation.getByLabel("Name").press("Enter");
		await placeInformation
			.getByLabel("Accepted values")
			.fill("Clinic\nHospital");
		await placeInformation
			.getByRole("button", { name: "Apply accepted values" })
			.click();
		await placeInformation
			.getByRole("checkbox", {
				name: "A value is required before a place can be saved",
			})
			.click();

		await places.getByRole("button", { name: "Add place" }).click();
		await expect(places.getByLabel("Name")).toBeFocused();
		await places.getByLabel("Name").fill("Cancelled place");
		await places.getByRole("button", { name: "Cancel" }).click();
		await expect(
			places.getByRole("button", { name: "Add place" }),
		).toBeFocused();

		await places.getByRole("button", { name: "Add place" }).click();
		await expect(places.getByLabel("Name")).toBeFocused();
		await places.getByLabel("Name").fill("Coast Region");
		await places.getByLabel("Code (optional)").fill("coast-region");
		await places.getByLabel("ID in another system").fill("region-001");
		await places.getByLabel("Latitude").fill("-4.0435");
		await places.getByLabel("Longitude").fill("39.6682");
		await places.getByLabel("Facility kind").last().click();
		await page.getByRole("option", { name: "Hospital" }).click();
		await places.getByRole("button", { name: "Add place" }).click();
		const coastRegion = places.getByRole("button", { name: /Coast Region/ });
		await expect(coastRegion).toBeFocused();
		await expect(coastRegion).toContainText("coast-region");
		await expect(places.getByLabel("Latitude")).toHaveValue("-4.0435");

		await places.getByRole("button", { name: "Add place" }).click();
		await places.getByLabel("Name").last().fill("Kilifi District");
		await places.getByLabel("Level").last().click();
		await page.getByRole("option", { name: "District" }).click();
		await places.getByLabel("Sits in").click();
		await page.getByRole("option", { name: "Coast Region" }).click();
		await places.getByLabel("Facility kind").last().click();
		await page.getByRole("option", { name: "Clinic" }).click();
		await places.getByRole("button", { name: "Add place" }).click();
		const kilifiDistrict = places.getByRole("button", {
			name: /Kilifi District/,
		});
		await expect(kilifiDistrict).toBeVisible();

		await places.getByRole("button", { name: "Add place" }).click();
		await places.getByLabel("Name").last().fill("Mombasa District");
		await places.getByLabel("Level").last().click();
		await page.getByRole("option", { name: "District" }).click();
		await places.getByLabel("Sits in").last().click();
		await page.getByRole("option", { name: "Coast Region" }).click();
		await places.getByLabel("Facility kind").last().click();
		await page.getByRole("option", { name: "Hospital" }).click();
		await places.getByRole("button", { name: "Add place" }).click();
		await expect(
			places.getByRole("button", { name: /Mombasa District/ }),
		).toBeVisible();
		await expect(
			places.getByRole("list", { name: "Place hierarchy" }),
		).toBeVisible();
		await expect(places.getByRole("tree")).toHaveCount(0);
		if ((await kilifiDistrict.getAttribute("aria-expanded")) !== "true") {
			await kilifiDistrict.click();
		}
		await expect(kilifiDistrict).toHaveAttribute("aria-expanded", "true");
		await places.getByLabel("Position").filter({ visible: true }).click();
		await page.getByRole("option", { name: "At the end" }).click();
		await expect(
			places.getByLabel("Position").filter({ visible: true }),
		).toHaveText("At the end");

		await places.getByLabel("Level").filter({ visible: true }).click();
		await page.getByRole("option", { name: "Region" }).click();
		await places.getByRole("button", { name: "Apply level change" }).click();
		await expect(
			places.getByLabel("Level").filter({ visible: true }),
		).toContainText("Region");
		// The combobox is the staged draft and changes immediately. Wait for the
		// row's saved detail before choosing the old level again, or the stale
		// location prop can mistake that choice for no change.
		await expect(
			kilifiDistrict.getByText("Region", { exact: true }),
		).toBeVisible();
		await places.getByLabel("Level").filter({ visible: true }).click();
		await page.getByRole("option", { name: "District" }).click();
		await places.getByRole("button", { name: "Apply level change" }).click();
		await expect(
			kilifiDistrict.getByText("District", { exact: true }),
		).toBeVisible();
		await expect(
			places.getByLabel("Sits in").filter({ visible: true }),
		).toContainText("Coast Region");

		await places.getByRole("button", { name: "Archive" }).click();
		await expect(places.getByText("Checking what this affects…")).toHaveCount(
			0,
		);
		await places.getByRole("button", { name: "Archive" }).click();
		await expect(places.getByText("Archived", { exact: true })).toBeVisible();
		await places.getByRole("button", { name: "Bring back" }).click();
		await expect(places.getByText("Archived", { exact: true })).toHaveCount(0);

		await page.goto(`/build/${appId}/setup/users`);
		const personas = page.getByRole("region", { name: "Personas" });
		await personas.getByRole("button", { name: "Add persona" }).click();
		await expect(personas.getByLabel("Name")).toBeFocused();
		const role = personas.getByRole("combobox", { name: "Role" });
		const roleHelp = personas.getByText(
			"Add a role above to give this persona one.",
		);
		await expect(role).toHaveText("No role");
		await expect(role).toBeDisabled();
		await expect(roleHelp).toBeVisible();
		const roleHelpId = await roleHelp.getAttribute("id");
		expect(roleHelpId).toBeTruthy();
		await expect(role).toHaveAttribute("aria-describedby", roleHelpId ?? "");
		await personas.getByLabel("Name").fill("Asha");
		await personas.getByLabel("Name").press("Enter");
		await personas.getByLabel("Add a place").click();
		await page.getByRole("option", { name: "Kilifi District" }).click();
		await expect(personas.getByText("Kilifi District")).toBeVisible();
		await personas
			.getByRole("button", { name: "Remove Kilifi District" })
			.click();
		await expect(personas.getByLabel("Add a place")).toBeFocused();
		await personas.getByLabel("Add a place").click();
		await page.getByRole("option", { name: "Kilifi District" }).click();
		await personas.getByLabel("Add a place").click();
		await page.getByRole("option", { name: "Mombasa District" }).click();
		await personas.getByRole("button", { name: "Make main" }).click();
		await expect(
			personas
				.getByRole("listitem")
				.filter({ hasText: "Mombasa District · mombasa_district" }),
		).toBeFocused();
		await personas
			.getByRole("button", { name: "Remove Mombasa District" })
			.click();
		await expect(
			personas
				.getByRole("listitem")
				.filter({ hasText: "Kilifi District · kilifi_district" }),
		).toBeFocused();
		// Persona assignments live in the Blueprint while places live in the
		// organization store. Wait for the final assignment to reach the
		// authoritative document before opening Organization, or this journey can
		// race the autosave debounce and briefly offer a cross-store-invalid level
		// gesture that the committed Blueprint does not know is invalid yet.
		await expect
			.poll(async () => {
				const response = await page.request.get(`/api/apps/${appId}`);
				if (!response.ok()) return -1;
				const body = (await response.json()) as {
					blueprint?: {
						personas?: Record<
							string,
							{
								name?: string;
								locations?: {
									primaryUuid?: string;
									additionalUuids?: string[];
								};
							}
						>;
					};
				};
				const asha = Object.values(body.blueprint?.personas ?? {}).find(
					(persona) => persona.name === "Asha",
				);
				return asha?.locations?.primaryUuid === undefined
					? 0
					: 1 + (asha.locations.additionalUuids?.length ?? 0);
			})
			.toBe(1);
		// The database can commit just before the browser receives the PUT
		// response. Wait for the reconciler acknowledgement too, or navigation can
		// abort that response and leave the next page holding its stale local doc.
		await expect(page.getByText(/^Saved /)).toBeVisible();

		await page.goto(`/build/${appId}/setup/organization`);
		const refreshedPlaces = page.getByRole("region", { name: "Places" });
		const refreshedLevels = page.getByRole("region", { name: "Levels" });
		await refreshedLevels.getByRole("button", { name: /District/ }).click();
		await expect(
			refreshedLevels
				.getByRole("checkbox", { name: "People work here" })
				.filter({ visible: true }),
		).toBeDisabled();
		await expect(
			refreshedLevels.getByText(
				/Asha is assigned to .*Move that assignment before changing who can work/,
			),
		).toBeVisible();

		await refreshedPlaces
			.getByRole("button", { name: /Mombasa District/ })
			.click();
		await refreshedPlaces.getByRole("button", { name: "Archive" }).click();
		await refreshedPlaces.getByRole("button", { name: "Archive" }).click();
		await expect(
			refreshedPlaces.getByText("Archived", { exact: true }),
		).toBeVisible();

		const caseChangesRoute = seed.organizationCaseChangeRoutes[testInfo.retry];
		if (caseChangesRoute === undefined) {
			throw new Error("organization case-change route missing");
		}
		await page.goto(caseChangesRoute);
		await page.getByRole("button", { name: "Add a change" }).click();
		await page
			.getByRole("button", { name: "Update the case this form opened" })
			.click();
		await page.getByRole("button", { name: "Choose an owner" }).click();
		await expect(page.getByLabel("How to choose the owner")).toHaveText(
			"A person, form answer, or case value",
		);
		await page.getByLabel("How to choose the owner").click();
		await page.getByRole("option", { name: "A particular place" }).click();
		await page.getByLabel("Place that owns the case").click();
		await page.getByRole("option", { name: "Kilifi District" }).click();
		await expect(page.getByLabel("How to choose the owner")).toHaveText(
			"A particular place",
		);
		await expect(page.getByLabel("Place that owns the case")).toHaveText(
			"Kilifi District · kilifi_district",
		);
		await expect
			.poll(async () => {
				const response = await page.request.get(`/api/apps/${appId}`);
				if (!response.ok()) return false;
				const body = (await response.json()) as {
					blueprint?: {
						forms?: Record<
							string,
							{
								caseOperations?: Array<{
									owner?: { kind?: string; term?: { kind?: string } };
								}>;
							}
						>;
					};
				};
				return Object.values(body.blueprint?.forms ?? {}).some((form) =>
					(form.caseOperations ?? []).some(
						(operation) => operation.owner?.term?.kind === "fixed-location",
					),
				);
			})
			.toBe(true);
		await page.reload();
		await expect(page.getByLabel("Place that owns the case")).toHaveText(
			"Kilifi District · kilifi_district",
		);
		await page.getByLabel("How to choose the owner").click();
		await page
			.getByRole("option", { name: "A place beneath the current case owner" })
			.click();
		await expect(page.getByLabel("How to choose the owner")).toHaveText(
			"A place beneath the current case owner",
		);
		await page.getByLabel("Level to find beneath the current owner").click();
		await page.getByRole("option", { name: "District" }).click();
		await expect(
			page.getByLabel("Level to find beneath the current owner"),
		).toContainText("District");
		await expect
			.poll(async () => {
				const response = await page.request.get(`/api/apps/${appId}`);
				if (!response.ok()) return false;
				const body = (await response.json()) as {
					blueprint?: {
						forms?: Record<
							string,
							{
								caseOperations?: Array<{
									owner?: { kind?: string; term?: { kind?: string } };
								}>;
							}
						>;
					};
				};
				return Object.values(body.blueprint?.forms ?? {}).some((form) =>
					(form.caseOperations ?? []).some(
						(operation) =>
							operation.owner?.term?.kind === "owner-location-at-level",
					),
				);
			})
			.toBe(true);
		await page.reload();
		await expect(
			page.getByLabel("Level to find beneath the current owner"),
		).toContainText("District");

		await page.goto(`/build/${appId}/setup/organization`);
		const conflictPlaces = page.getByRole("region", { name: "Places" });
		await expect(
			conflictPlaces.getByRole("button", { name: /Coast Region/ }),
		).toBeVisible();
		await conflictPlaces.getByRole("button", { name: /Coast Region/ }).click();
		const draftName = conflictPlaces
			.getByLabel("Name")
			.filter({ visible: true });
		await draftName.fill("Coast draft kept locally");

		const peerPage = await page.context().newPage();
		const peerGuard = attachErrorGuard(peerPage, baseURL);
		try {
			await peerPage.goto(`/build/${appId}/setup/organization`);
			const peerPlaces = peerPage.getByRole("region", { name: "Places" });
			await peerPlaces.getByRole("button", { name: /Coast Region/ }).click();
			await peerPlaces
				.getByLabel("ID in another system")
				.filter({ visible: true })
				.fill("region-peer-update");
			await peerPlaces.getByRole("heading", { name: "Places" }).click();
			await expect(
				conflictPlaces.getByText(
					"This place changed while you were editing. Your draft is still here.",
				),
			).toBeVisible();
			await expect(draftName).toHaveValue("Coast draft kept locally");
			await conflictPlaces
				.getByRole("button", { name: "Keep my draft" })
				.click();
			await expect(draftName).toHaveValue("Coast draft kept locally");
			await expect(
				conflictPlaces.getByText(
					"This place changed while you were editing. Your draft is still here.",
				),
			).toHaveCount(0);
			await draftName.focus();
			await conflictPlaces.getByRole("heading", { name: "Places" }).click();
			await expect(
				conflictPlaces.getByRole("button", {
					name: /Coast draft kept locally/,
				}),
			).toBeVisible();
			peerGuard.assertNoErrors();
		} finally {
			await peerPage.close();
		}

		await page.goto(`/build/${appId}/setup/organization`);
		const barrierLevels = page.getByRole("region", { name: "Levels" });
		const barrierPlaces = page.getByRole("region", { name: "Places" });
		let releaseRejectedSave: (() => void) | undefined;
		let observeRejectedSave: (() => void) | undefined;
		const rejectedSaveStarted = new Promise<void>((resolve) => {
			observeRejectedSave = resolve;
		});
		const rejectedSaveRelease = new Promise<void>((resolve) => {
			releaseRejectedSave = resolve;
		});
		/* Count the WRITE, not every Server Action on the page. The
		 * organization panel also re-READS through a Server Action whenever a
		 * co-editor poke arrives on the builder stream, and that arrives on
		 * its own schedule — counting those made this assert a race that a
		 * slower machine loses. The place's name is the discriminator,
		 * because it is exactly the thing that must not be sent. */
		/* Distinctive enough that no other request can contain it. */
		const BLOCKED_PLACE_NAME = "Must not persist";
		let placeWritePosts = 0;
		const countPlaceWrites = (request: Request) => {
			if (
				request.method() === "POST" &&
				request.headers()["next-action"] !== undefined &&
				(request.postData() ?? "").includes(BLOCKED_PLACE_NAME)
			) {
				placeWritePosts++;
			}
		};
		page.on("request", countPlaceWrites);
		await page.route(`**/api/apps/${appId}`, async (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			observeRejectedSave?.();
			await rejectedSaveRelease;
			await route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({
					error: "Smoke forced the Blueprint save to fail.",
					type: "commit_rejected",
				}),
			});
		});
		await barrierLevels.getByRole("button", { name: "Add level" }).click();
		await barrierLevels.getByLabel("Level name").fill("Barrier level");
		await barrierLevels.getByLabel("Level name").press("Enter");
		await rejectedSaveStarted;
		await barrierPlaces.getByRole("button", { name: "Add place" }).click();
		// The form initially opens at Region, whose active reverse-hop rule also
		// renders a required District branch. Name the root explicitly before
		// switching it to the newly authored Barrier level.
		await barrierPlaces.getByLabel("Name").first().fill(BLOCKED_PLACE_NAME);
		await barrierPlaces.getByLabel("Level").last().click();
		await page.getByRole("option", { name: "Barrier level" }).click();
		await barrierPlaces.getByLabel("Sits in").last().click();
		await page.getByRole("option", { name: /Kilifi District/ }).click();
		await barrierPlaces.getByLabel("Facility kind").last().click();
		await page.getByRole("option", { name: "Clinic" }).click();
		const blockedAddPlace = barrierPlaces.getByRole("button", {
			name: "Add place",
		});
		await expect(blockedAddPlace).toBeEnabled();
		await blockedAddPlace.click();
		releaseRejectedSave?.();
		await expect(
			barrierPlaces.getByText(
				"The app changed before its places could be saved. Review the latest app, then try again.",
			),
		).toBeVisible();
		// The place never left the browser, so nothing on CommCare HQ or in
		// the case store can be holding it.
		expect(placeWritePosts).toBe(0);
		await page.unroute(`**/api/apps/${appId}`);
		page.off("request", countPlaceWrites);
		await page.reload();
		await expect(
			barrierPlaces.getByRole("button", { name: BLOCKED_PLACE_NAME }),
		).toHaveCount(0);

		for (const viewport of [
			{ width: 1440, height: 900 },
			{ width: 768, height: 900 },
			{ width: 390, height: 844 },
		]) {
			await page.setViewportSize(viewport);
			await expect(
				page.getByRole("navigation", { name: "App setup sections" }),
			).toBeVisible();
			await expect
				.poll(() =>
					page
						.locator("body")
						.evaluate((element) => element.scrollWidth - element.clientWidth),
				)
				.toBeLessThanOrEqual(1);
		}
		const addLevelBox = await page
			.getByRole("region", { name: "Levels" })
			.getByRole("button", { name: "Add level" })
			.boundingBox();
		expect(addLevelBox?.height ?? 0).toBeGreaterThanOrEqual(44);

		const viewerStateFile = seed.caseChanges[0]?.viewerStateFile;
		if (viewerStateFile === undefined) throw new Error("viewer state missing");
		const context = page.context();
		const viewerState = JSON.parse(readFileSync(viewerStateFile, "utf8")) as {
			cookies: Parameters<typeof context.addCookies>[0];
		};
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.clearCookies();
		await context.addCookies(viewerState.cookies);
		await page.goto(`/build/${appId}/setup/organization`);
		await expect(
			page.getByRole("region", { name: "Organization" }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Add level" })).toHaveCount(
			0,
		);
		await expect(
			page.getByRole("button", { name: "Add information" }),
		).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Add place" })).toHaveCount(
			0,
		);
		const viewerPlaces = page.getByRole("region", { name: "Places" });
		await viewerPlaces
			.getByRole("button", { name: /Coast draft kept locally/ })
			.click();
		await expect(
			viewerPlaces.getByLabel("Name").filter({ visible: true }),
		).toBeDisabled();
	});

	test("the Publishing section states where the app stands and keeps the one publish flow in the header", async ({
		page,
	}) => {
		await page.goto(`/build/${seed.openAppId}/setup/publishing`);

		const nav = page.getByRole("navigation", { name: "App setup sections" });
		await expect(nav.getByRole("button", { name: "Publishing" })).toBeVisible();
		await expect(
			nav.getByRole("button", { name: "Publishing" }),
		).toHaveAttribute("aria-current", "page");

		// The hermetic smoke stack has no CommCare HQ connection, so the section
		// invites one rather than pretending, and points at Settings.
		const connection = page.getByRole("complementary", {
			name: "CommCare HQ connection",
		});
		await expect(connection).toBeVisible();
		await expect(
			connection.getByRole("link", { name: /Open Settings/ }),
		).toBeVisible();

		// The record read settles on the honest empty state: this app has never
		// been published, and the editor is pointed at the header's Publish.
		await expect(
			page.getByText(
				"This app hasn't been published yet. Choose Publish in the header",
			),
		).toBeVisible();

		// No records means no per-target card: publishing again and the Workers
		// panel exist only under a real deployment record.
		await expect(
			page.getByRole("button", { name: "Publish again" }),
		).toHaveCount(0);

		// The dialog stays the one publish flow, opened from the header band.
		await expect(
			page.getByRole("button", { name: "Publish", exact: true }),
		).toBeVisible();

		// The section strip and body stay usable at the handset dock layout.
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(nav).toBeVisible();
		await expect
			.poll(() =>
				page
					.locator("body")
					.evaluate((element) => element.scrollWidth - element.clientWidth),
			)
			.toBeLessThanOrEqual(1);
		await page.setViewportSize({ width: 1440, height: 900 });
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

		// Results reads in the worker-facing order: how many cases move into a
		// form, what each row says, which cases may appear, then how the matching
		// rows are ordered.
		await expect(page.locator("[data-case-list-layout] h2")).toHaveText([
			"Case selection",
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
		// Visibility precedes the popup's scale transition. Geometry assertions
		// need its settled size, otherwise a 4px inset briefly reads as 3.94px.
		await expect(menu).toHaveCSS("scale", "none");
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
			"Add or replace the cases saved for the patient case type. They're used throughout your app and in Preview.",
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
			deletionDialog.getByText("Saved case data won't change"),
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
	 * The form editor is the most-used screen in the product, and until this
	 * test nothing asserted it draws anything at all.
	 *
	 * It fails silently by construction: the canvas is a virtualized list
	 * that renders only the rows fitting its scroll viewport, so an upstream
	 * layout change that leaves that element without a resolvable height
	 * renders ZERO rows — no console error, no failed request, no empty
	 * state, just a blank canvas under a correct header with a correct
	 * structure tree beside it. Assert the viewport AND a row: the height
	 * alone can be right while nothing draws, and a row assertion alone can
	 * pass on a taller sibling.
	 */
	test("the form edit canvas gives its virtualized list a real viewport and draws the fields", async ({
		page,
	}) => {
		await page.goto(seed.caseWorkspace.routes.tileForm);
		await expect(page.locator("[data-form-header]")).toBeVisible({
			timeout: 20_000,
		});

		// The INNER scroller — `builder/CLAUDE.md` names it the edit-mode one,
		// and it is the surface the flipbook restores its offset and row
		// measurements through. PreviewShell's <main> carries the same
		// attribute, so scope to a descendant of it rather than `.first()`.
		const canvas = page.locator("main [data-preview-scroll-container]");
		await expect(canvas).toBeVisible({ timeout: 20_000 });
		expect(await canvas.evaluate((el) => el.clientHeight)).toBeGreaterThan(0);

		// One row per authored field, counted from the seed rather than a
		// literal — the seed is what decides how many rows there should be.
		await expect(canvas.locator("[data-field-uuid]")).toHaveCount(
			CASE_WORKSPACE_SEED.tile.formFieldIds.length,
		);
		await expect(canvas.getByText("Visit note")).toBeVisible();
	});

	/**
	 * The date / time / datetime questions, which are the only ones whose
	 * STORED value a person cannot be shown directly and the only ones a
	 * person can half-finish into something that is not a value of its type.
	 *
	 * Three things here are invisible to any unit test:
	 *
	 *   - A native `<input type="datetime-local">` silently blanks any value
	 *     carrying a zone designator — which every stored datetime does — so
	 *     the widget swap is what makes a preloaded answer visible at all.
	 *     Nothing throws; the answer is just gone, and re-submitting the form
	 *     erases the case property.
	 *   - The flipbook's contract is that edit and live land every row at
	 *     identical X/Y. A picker trigger and a text input are different
	 *     controls with different intrinsic heights, so this pair is exactly
	 *     where the two renderers can drift apart.
	 *   - The shape gate has to hold a half-typed clock back at Submit while
	 *     leaving the person's own text on screen to correct.
	 */
	test("temporal questions show their stored answers, hold their row geometry, and refuse a half-typed clock", async ({
		page,
	}) => {
		await page.goto(seed.caseWorkspace.routes.tileForm);
		await expect(page.locator("[data-form-header]")).toBeVisible({
			timeout: 20_000,
		});

		// The row STACK, measured from its own first row rather than from the
		// viewport. Absolute position is the shell's business and the two
		// modes legitimately differ there — the sidebar collapses on the flip,
		// and live mode pins a persistent case tile above the form that edit
		// mode has no equivalent for, translating every row down by the tile's
		// height without changing the layout at all. What must not move is the
		// stack itself: same heights, same spacing. That is also where the
		// real risk lives, since a 44px picker trigger and a 38px text input
		// are different controls standing in for the same row.
		const rowGeometry = async () =>
			await page.locator("main [data-field-uuid]").evaluateAll((els) => {
				const boxes = els.map((el) => el.getBoundingClientRect());
				const top = boxes[0]?.y ?? 0;
				return els.map((el, i) => ({
					uuid: (el as HTMLElement).dataset.fieldUuid ?? "",
					offset: Math.round((boxes[i]?.y ?? 0) - top),
					height: Math.round(boxes[i]?.height ?? 0),
				}));
			});

		const edit = await rowGeometry();
		// Counted from the seed: this test is about edit and live landing every
		// row at identical geometry, not about how many rows the form has.
		expect(edit).toHaveLength(CASE_WORKSPACE_SEED.tile.formFieldIds.length);

		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const dateTrigger = page.locator('button[data-slot="date-picker"]');
		await expect(dateTrigger).toHaveCount(1, { timeout: 20_000 });
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible({ timeout: 20_000 });

		await test.step("both renderers lay the rows out identically", async () => {
			await expect.poll(rowGeometry).toEqual(edit);
		});

		await test.step("no native temporal input survives anywhere", async () => {
			// The whole point of the migration: the browser's own picker
			// chrome never opens over the previewed app's theme.
			await expect(
				page.locator(
					'input[type="date"], input[type="time"], input[type="datetime-local"]',
				),
			).toHaveCount(0);
		});

		const clocks = page.locator('input[data-slot="time-field"]');

		await test.step("a preloaded answer is readable, not blank", async () => {
			// A followup opened on a seeded row. The datetime's calendar half
			// reads its date, its clock half reads the wall clock it was
			// entered at, and the standalone time reads through its `Z` tag.
			await expect(dateTrigger).not.toHaveText(/Pick a date/, {
				timeout: 20_000,
			});
			await expect(clocks.nth(0)).toHaveValue(
				SEEDED_TEMPORAL_DISPLAY.visitStartedTime,
			);
			await expect(clocks.nth(1)).toHaveValue(SEEDED_TEMPORAL_DISPLAY.nextDose);
		});

		await test.step("a stored answer nobody touched does not block Submit", async () => {
			// The seeded time predates the millisecond padding rule. It is
			// valid RFC 3339 and the schema takes it, so the shape gate must
			// let it through — refusing it would strand a person on a form
			// over an answer they never entered and cannot correct.
			await expect(clocks.nth(0)).not.toHaveAttribute("aria-invalid", "true");
			await expect(clocks.nth(1)).not.toHaveAttribute("aria-invalid", "true");
		});

		await test.step("emptying the clock half answers nothing on the person's behalf", async () => {
			// The date's own midnight is a value nobody chose, and committing
			// it back here would make a cleared clock refill itself.
			await clocks.nth(0).fill("");
			await clocks.nth(0).blur();
			await expect(clocks.nth(0)).toHaveValue("");
			await expect(dateTrigger).not.toHaveText(/Pick a date/);
			await expect(clocks.nth(0)).not.toHaveAttribute("aria-invalid", "true");
		});

		await test.step("a clock entered before its date reads back as typed", async () => {
			// Clear the date too, so the clock really is the only half there.
			// The join has to survive that: showing back "14:30:00" would be
			// the field rewriting the person's own "2:30 PM" into a spelling
			// they never used, and quoting the join at them in the error would
			// put punctuation they never typed on screen.
			await dateTrigger.click();
			await page.getByRole("button", { name: "Clear", exact: true }).click();
			await expect(dateTrigger).toHaveText(/Pick a date/);

			await clocks.nth(0).fill("2:30 PM");
			await clocks.nth(0).blur();
			await expect(clocks.nth(0)).toHaveValue("2:30 PM");
			await expect(
				page.getByText("Pick a date: this question needs both."),
			).toBeVisible();

			// And clearing the remaining half empties the answer outright.
			await clocks.nth(0).fill("");
			await clocks.nth(0).blur();
			await expect(clocks.nth(0)).toHaveValue("");
			await expect(
				page.getByText("Pick a date: this question needs both."),
			).toBeHidden();
		});

		await test.step("a typed clock commits in the locale's own spelling", async () => {
			await clocks.nth(1).fill("7:05 am");
			await clocks.nth(1).blur();
			await expect(clocks.nth(1)).toHaveValue("7:05 AM");
			await expect(clocks.nth(1)).not.toHaveAttribute("aria-invalid", "true");
		});

		await test.step("a half-typed clock is named, kept, and refused at Submit", async () => {
			await clocks.nth(1).fill("2:3");
			await clocks.nth(1).blur();
			// Kept verbatim: the person's own text is what they have to fix.
			await expect(clocks.nth(1)).toHaveValue("2:3");
			await expect(clocks.nth(1)).toHaveAttribute("aria-invalid", "true");
			await expect(
				page.getByText(
					"“2:3” isn't a time yet. Enter a clock time like 2:30 PM.",
				),
			).toBeVisible();

			await page
				.locator("main")
				.getByRole("button", { name: "Submit", exact: true })
				.click();
			// Still on the form, with the answer still there to correct.
			await expect(clocks.nth(1)).toHaveValue("2:3");
		});
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
	 * The GROUPED tile, which is the one layout with no other real UI
	 * coverage. Every assertion is a statement about what Web Apps draws:
	 * one card per group, the heading drawn once from the group's first
	 * case, a body row per member, and ONE target per card.
	 */
	test("a grouped case list draws one card per group and opens the group's first case", async ({
		page,
	}) => {
		await page.goto(seed.caseWorkspace.routes.groupedResults);
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible({ timeout: 20_000 });

		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const list = page.locator('[data-case-results="tile"]');
		await expect(list).toBeVisible({ timeout: 20_000 });
		const groups = list.locator("[data-case-tile-group]");
		await expect(groups.first()).toBeVisible();

		await test.step("clustering, not sorting", async () => {
			// Visit names interleave the households alphabetically, so whole
			// groups on screen are the clustering doing its job.
			await expect(groups).toHaveCount(3);
			const names = await list
				.locator('[data-case-tile-group-rows] [data-case-tile="results"]')
				.allInnerTexts();
			const order = CASE_WORKSPACE_SEED.grouped.visitOrder;
			for (const [index, visit] of order.entries()) {
				expect(names[index]).toContain(visit);
			}
		});

		await test.step("the heading is drawn once per group, from its first case", async () => {
			const first = groups.first();
			// One heading grid above the body run, both on the tile's full
			// geometry: the template draws them as separate grids sharing one
			// `-cell-grid-style` block.
			const headings = first.locator(
				'[data-case-tile-group-header] [data-case-tile="results"]',
			);
			await expect(headings).toHaveCount(1);
			await expect(headings.first()).toContainText("Kijiji");
			await expect(headings.first()).toHaveAttribute("data-tile-columns", "6");

			const bodies = first.locator(
				'[data-case-tile-group-rows] [data-case-tile="results"]',
			);
			await expect(bodies).toHaveCount(2);
			await expect(bodies.first()).toHaveAttribute("data-tile-columns", "6");
		});

		await test.step("every case with no such connection is one group", async () => {
			// Eve carries no household, so `string(./index/parent)` is the empty
			// string for her and the device puts every such case in one group.
			const last = groups.last();
			await expect(
				last.locator('[data-case-tile-group-rows] [data-case-tile="results"]'),
			).toHaveCount(1);
			await expect(last).toContainText("Eve");
		});

		await test.step("a group is ONE target, and it opens the first case", async () => {
			// Web Apps removes every non-first model from the rendered
			// collection, so the body rows carry no handler. One action per card
			// is the whole selection contract.
			const actions = list.locator("[data-case-result-action]");
			await expect(actions).toHaveCount(3);
			await expect(actions.first()).toHaveAttribute(
				"aria-label",
				/View details for .*Ada/,
			);

			await actions.first().click();
			await expect(page.getByText("Ada", { exact: false }).first()).toBeVisible(
				{ timeout: 20_000 },
			);
		});

		await test.step("the list says so, permanently", async () => {
			await page.goBack();
			await expect(list).toBeVisible({ timeout: 20_000 });
			await expect(list).toContainText(
				"Choosing a group selects its first case",
			);
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
					"Patient would sit on top of Village. Two fields can't share a square on a tile: one would be drawn over the other.",
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

	test("a close condition keeps its friendly field projection through rename and move", async ({
		page,
	}, testInfo) => {
		test.setTimeout(120_000);
		const fixture = seed.caseChanges[testInfo.retry];
		if (fixture === undefined) {
			throw new Error(
				`Identity-projection fixture missing for Playwright attempt ${testInfo.retry}`,
			);
		}
		const identity = CASE_CHANGES_SEED.identityProjection;
		const waitForSavedMutation = async (
			bodyNeedle: string,
			mutate: () => Promise<void>,
		) => {
			const responsePromise = page.waitForResponse((response) => {
				const request = response.request();
				return (
					new URL(response.url()).pathname === `/api/apps/${fixture.appId}` &&
					request.method() === "PUT" &&
					(request.postData() ?? "").includes(bodyNeedle)
				);
			});
			await mutate();
			const response = await responsePromise;
			expect(response.ok()).toBe(true);
		};
		await page.goto(fixture.identityProjectionRoute);
		await expect(
			page.getByRole("button", { name: "Form settings", exact: true }),
		).toBeVisible({ timeout: 20_000 });

		await test.step("Always becomes a complete conditional reference without an empty saved identity", async () => {
			await page
				.getByRole("button", { name: "Form settings", exact: true })
				.click();
			await page.getByRole("button", { name: "Close Behavior" }).click();
			await page
				.getByRole("menuitem", { name: "When condition is met" })
				.click();

			const field = page.getByPlaceholder("Search fields");
			await expect(field).toHaveValue("");
			await field.click();
			await page
				.getByRole("option", { name: /First name.*first_name/ })
				.click();
			await expect(field).toHaveValue("first_name");

			const answer = page.getByPlaceholder("Plain text value");
			await waitForSavedMutation('"answer":"Ada"', async () => {
				await answer.fill("Ada");
				await answer.blur();
			});
			await expect(answer).toHaveValue("Ada");
		});

		await test.step("renaming and moving the field preserve the reference", async () => {
			await page.goto(
				`${fixture.identityProjectionRoute}/${identity.firstNameUuid}`,
			);
			const idInput = page.locator('[data-field-id="id"] input:visible');
			await expect(idInput).toHaveValue("first_name", { timeout: 20_000 });
			/* A field id rename is `updateField` with `patch.id` — `newId` belongs
			 * to renameModule/renameForm, which name a different entity. */
			await waitForSavedMutation('"id":"given_name"', async () => {
				await idInput.fill("given_name");
				await idInput.press("Enter");
			});
			await expect(idInput).toHaveValue("given_name");

			await page.getByRole("button", { name: "Field actions" }).click();
			await waitForSavedMutation('"kind":"moveField"', async () => {
				await page.getByRole("menuitem", { name: "Move down" }).click();
			});
			await expect(
				page.locator("main [data-field-uuid]").first(),
			).toHaveAttribute("data-field-uuid", identity.noteUuid);
		});

		await test.step("reopening and Preview show names, never UUID-shaped XPath", async () => {
			await page.goto(fixture.identityProjectionRoute);
			await page
				.getByRole("button", { name: "Form settings", exact: true })
				.click();
			const field = page.getByPlaceholder("Search fields");
			await expect(field).toHaveValue("given_name", { timeout: 20_000 });
			const settings = page
				.getByRole("dialog")
				.filter({ hasText: "Form settings" });
			await expect(settings).toHaveCount(1);
			await expect(settings).not.toContainText(identity.firstNameUuid);
			await expect(settings).not.toContainText(
				`#form/${identity.firstNameUuid}`,
			);

			await page
				.getByRole("button", { name: "Form settings", exact: true })
				.click();
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await expect(
				page.getByRole("textbox", { name: "First name" }),
			).toBeVisible({ timeout: 20_000 });
			const previewOrder = await page
				.locator("main [data-field-uuid]")
				.evaluateAll((elements) =>
					elements.map((element) => (element as HTMLElement).dataset.fieldUuid),
				);
			expect(previewOrder).toEqual([identity.noteUuid, identity.firstNameUuid]);
		});

		await test.step("returning to Always clears the reference cleanly", async () => {
			await page.getByRole("button", { name: "Back to edit" }).click();
			await page
				.getByRole("button", { name: "Form settings", exact: true })
				.click();
			await page.getByRole("button", { name: "Close Behavior" }).click();
			await waitForSavedMutation('"closeCondition":null', async () => {
				await page.getByRole("menuitem", { name: "Always" }).click();
			});
			await expect(page.getByPlaceholder("Search fields")).toHaveCount(0);
		});
	});

	test("after-submit links are authored in the builder and followed in Preview", async ({
		page,
	}, testInfo) => {
		test.setTimeout(120_000);
		const fixture = seed.formLinks[testInfo.retry];
		if (fixture === undefined) {
			throw new Error(
				`After-submit fixture missing for Playwright attempt ${testInfo.retry}`,
			);
		}
		const { visit, followUp } = FORM_LINKS_SEED;
		const condition = `#${FORM_LINKS_SEED.caseType}/${FORM_LINKS_SEED.property} = '${FORM_LINKS_SEED.linkingNote}'`;
		const main = page.locator("main");
		/* The condition editor is CodeMirror: one contenteditable surface,
		 * saved with Cmd/Ctrl+Enter. Replacing its text is select-all + type. */
		const conditionEditor = main.locator('.cm-content[contenteditable="true"]');
		const replaceCondition = async (text: string) => {
			await conditionEditor.click();
			await page.keyboard.press("ControlOrMeta+a");
			await page.keyboard.type(text);
			await page.keyboard.press("ControlOrMeta+Enter");
		};

		await test.step("the workspace opens with no links and the form's own destination", async () => {
			await page.goto(fixture.route);
			await expect(
				page.getByRole("heading", { name: "After submit", level: 1 }),
			).toBeVisible({ timeout: 20_000 });
			await expect(
				page.getByText("This form has no links yet", { exact: false }),
			).toBeVisible();
			const otherwise = page.locator("[data-form-link-otherwise]");
			await expect(otherwise).toContainText("After submit");
			await expect(otherwise).toContainText("Go to the app home");
		});

		await test.step("adding a conditional link lands on its detail with the editor open", async () => {
			await page.getByRole("button", { name: "Add a link" }).click();
			await page
				.getByRole("button", { name: /Go somewhere when a condition is true/ })
				.click();
			await page
				.getByRole("button", { name: `Go to “${followUp.formName}”` })
				.click();
			await expect(page).toHaveURL(
				new RegExp(`/${visit.formUuid}/links/[0-9a-f-]{36}$`),
			);
			await expect(
				page.getByRole("heading", {
					name: `Go to “${followUp.formName}”`,
					level: 1,
				}),
			).toBeVisible();
			await expect(conditionEditor).toBeVisible();
			// The destination loads a case, and this form opened one: it travels
			// automatically, and the workspace says which.
			await expect(
				page.getByRole("button", { name: /Carry it automatically/ }),
			).toHaveAttribute("aria-pressed", "true");
			await expect(
				page.getByText("The case this form opened travels with the person."),
			).toBeVisible();
		});

		await test.step("a condition that reads the form is refused in the editor's own words", async () => {
			await replaceCondition("#form/visit_note = 'x'");
			await expect(
				page
					.getByRole("alert")
					.filter({ hasText: "This runs after the form has closed" }),
			).toBeVisible();
			// The refused draft stays open; the real condition replaces it.
			await replaceCondition(condition);
			await expect(conditionEditor).toHaveCount(0);
			// The idle editor is a button; its case reference renders as a chip,
			// so the accessible name carries the property, not the `#patient/`.
			await expect(
				main.getByRole("button", { name: /last_note = 'Visited'/ }),
			).toBeVisible();
		});

		await test.step("the list reads the link as a sentence above the otherwise row", async () => {
			await page.goto(fixture.route);
			const rows = page
				.getByRole("list", { name: "Links in the order they are checked" })
				.getByRole("listitem");
			// The link, then the Otherwise row, which is the list's last item.
			await expect(rows).toHaveCount(2);
			await expect(rows.first()).toContainText(`Go to “${followUp.formName}”`);
			await expect(rows.first()).toContainText("When ");
			await expect(rows.first()).toContainText("last_note = 'Visited'");
			const otherwise = page.locator("[data-form-link-otherwise]");
			await expect(otherwise).toContainText("Otherwise");
			await expect(otherwise).toContainText("Go to the app home");
		});

		const submitVisit = async (note: string) => {
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			const noteField = main.getByRole("textbox", {
				name: visit.noteFieldLabel,
			});
			await expect(noteField).toBeVisible({ timeout: 20_000 });
			const submit = main.getByRole("button", { name: "Submit", exact: true });
			await expect(submit).toBeEnabled();
			await noteField.fill(note);
			await expect(noteField).toHaveValue(note);
			await submit.click();
		};

		await test.step("a submission the condition does not match goes where the form goes otherwise", async () => {
			// The note is stored on the case before the link is checked, so the
			// condition reads "Routine", not the seeded value, and does not hold.
			await submitVisit("Routine");
			await expect(
				main.getByRole("button", {
					name: new RegExp(`^${FORM_LINKS_SEED.moduleName}\\b`),
				}),
			).toBeVisible({ timeout: 20_000 });
		});

		await test.step("a submission the condition matches opens the linked form on the same case", async () => {
			await page.goto(fixture.route);
			await expect(
				page.getByRole("heading", { name: "After submit", level: 1 }),
			).toBeVisible({ timeout: 20_000 });
			await submitVisit(FORM_LINKS_SEED.linkingNote);
			await expect(
				main.getByRole("textbox", { name: followUp.noteFieldLabel }),
			).toBeVisible({ timeout: 20_000 });
			// The case "Visit" was on travelled with the person: the running
			// app's trail names it and the form it opened.
			const trail = page.getByRole("navigation", { name: "Page navigation" });
			await expect(trail).toContainText(FORM_LINKS_SEED.caseName);
			await expect(trail).toContainText(followUp.formName);
		});
	});

	test("a search-first module registers what a search could not find", async ({
		page,
	}, testInfo) => {
		test.setTimeout(120_000);
		const fixture = seed.searchFirst[testInfo.retry];
		if (fixture === undefined) {
			throw new Error(
				`Search-first fixture missing for Playwright attempt ${testInfo.retry}`,
			);
		}
		const { prompt, register, caseName, unmatchedName } = SEARCH_FIRST_SEED;
		const main = page.locator("main");
		const searchScreen = main.getByRole("search", { name: "Search" });
		const nameInput = searchScreen.getByRole("textbox", { name: prompt.label });
		const runSearch = searchScreen.getByRole("button", {
			name: "Search",
			exact: true,
		});
		const resultsTitle = main.locator("[data-results-title]");
		const resultRows = main
			.getByRole("list", { name: "Cases" })
			.getByRole("listitem");
		const registerAction = main.getByRole("button", {
			name: register.actionLabel,
			exact: true,
		});
		const search = async (text: string) => {
			await nameInput.fill(text);
			await runSearch.click();
		};

		await test.step("the Search canvas names the form Results offers, and the tree marks it", async () => {
			await page.goto(fixture.routes.searchConfig);
			await expect(
				page.getByRole("heading", { name: "Search", level: 1 }),
			).toBeVisible({ timeout: 20_000 });
			const setting = page.locator("[data-no-matches-setting]");
			await expect(
				setting.getByRole("heading", { name: "When no cases match", level: 2 }),
			).toBeVisible();
			await expect(
				setting.getByRole("radio", { name: "Offer a registration form" }),
			).toBeChecked();
			await expect(setting).toContainText(register.formName);
			await expect(
				page.locator("[data-no-matches-form]").first(),
			).toBeVisible();
		});

		await test.step("Preview opens on Search: no results, no register action", async () => {
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await expect(searchScreen).toBeVisible({ timeout: 20_000 });
			await expect(nameInput).toBeVisible();
			await expect(resultsTitle).toHaveCount(0);
			await expect(registerAction).toHaveCount(0);
		});

		await test.step("a blank search is refused with the prompt's own message", async () => {
			await runSearch.click();
			await expect(nameInput).toHaveAttribute("aria-invalid", "true");
			await expect(main.getByText(prompt.requiredMessage)).toBeVisible();
			await expect(resultsTitle).toHaveCount(0);
		});

		await test.step("a search that finds a case shows it, with no register action", async () => {
			await search("Ada");
			await expect(resultsTitle).toBeVisible({ timeout: 20_000 });
			await expect(resultRows).toHaveCount(1);
			await expect(resultRows.first()).toContainText(caseName);
			await expect(registerAction).toHaveCount(0);
		});

		await test.step("Search again returns to the Search screen", async () => {
			await main.getByRole("button", { name: "Search again" }).click();
			await expect(searchScreen).toBeVisible();
			await expect(resultsTitle).toHaveCount(0);
		});

		await test.step("an empty search offers the registration form", async () => {
			await search(unmatchedName);
			await expect(
				main.getByRole("heading", {
					name: "No cases match your search",
					level: 2,
				}),
			).toBeVisible({ timeout: 20_000 });
			await expect(resultRows).toHaveCount(0);
			await registerAction.click();
		});

		await test.step("the form opens with the search's answer and returns to Results showing the new case", async () => {
			// The running question is named "Question 1. Name"; the form's own
			// title input in the trail is "Form name".
			const formName = main.getByRole("textbox", {
				name: new RegExp(`${register.nameFieldLabel}$`),
			});
			await expect(formName).toBeVisible({ timeout: 20_000 });
			await expect(formName).toHaveValue(unmatchedName);
			await main.getByRole("button", { name: "Submit", exact: true }).click();
			await expect(resultsTitle).toBeVisible({ timeout: 20_000 });
			await expect(resultRows).toHaveCount(1);
			await expect(resultRows.first()).toContainText(unmatchedName);
			await expect(resultRows.first()).not.toContainText(caseName);
			await expect(registerAction).toHaveCount(0);
		});

		await test.step("the form refuses to open without an empty search behind it", async () => {
			await page.goto(fixture.routes.registerForm);
			await expect(page.getByTestId("editable-title")).toHaveValue(
				register.formName,
				{ timeout: 20_000 },
			);
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			const refusal = main.locator("[data-no-matches-refusal]");
			await expect(refusal).toBeVisible({ timeout: 20_000 });
			await expect(refusal).toContainText(
				"This form opens after a search finds no matches",
			);
			await refusal.getByRole("button", { name: "Go to Search" }).click();
			await expect(searchScreen).toBeVisible({ timeout: 20_000 });
			await expect(registerAction).toHaveCount(0);
		});
	});

	test("a sectioned form pages in Preview on the device's rules", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const { aboutYou, yourVisit } = FORM_SECTIONS_SEED;
		const main = page.locator("main");

		await test.step("the edit canvas shows every page, headed and counted", async () => {
			await page.goto(seed.formSections.route);
			await expect(
				main.getByText("Section 1 of 2", { exact: true }),
			).toBeVisible({ timeout: 20_000 });
			await expect(
				main.getByText("Section 2 of 2", { exact: true }),
			).toBeVisible();
			await expect(
				main.getByText(aboutYou.title, { exact: true }),
			).toBeVisible();
			await expect(
				main.getByText(yourVisit.title, { exact: true }),
			).toBeVisible();
		});

		const stepper = page.getByRole("navigation", { name: "Sections" });
		const step = (kicker: string) =>
			stepper.getByRole("button", { name: new RegExp(`^${kicker}`) });
		const nameField = main.getByRole("textbox", { name: aboutYou.nameLabel });
		const next = main.getByRole("button", { name: "Next", exact: true });

		await test.step("Preview opens on the first page with the stepper and Next", async () => {
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await expect(stepper).toBeVisible({ timeout: 20_000 });
			await expect(stepper.getByRole("button")).toHaveCount(2);
			await expect(step("Section 1 of 2")).toHaveAttribute(
				"aria-current",
				"step",
			);
			await expect(
				main.getByRole("heading", { name: aboutYou.title, level: 2 }),
			).toBeVisible();
			await expect(nameField).toBeVisible();
			await expect(next).toBeVisible();
			await expect(
				main.getByRole("button", { name: "Submit", exact: true }),
			).toHaveCount(0);
		});

		await test.step("Next refuses a blank required question and focuses it", async () => {
			await next.click();
			await expect(
				page
					.getByRole("alert")
					.filter({ hasText: "Review the highlighted question." }),
			).toBeVisible();
			await expect(nameField).toBeFocused();
			await expect(step("Section 1 of 2")).toHaveAttribute(
				"aria-current",
				"step",
			);
		});

		await test.step("an answered page turns, focuses the next heading, and offers Submit", async () => {
			await nameField.fill("Ada");
			await next.click();
			const heading = main.getByRole("heading", {
				name: yourVisit.title,
				level: 2,
			});
			await expect(heading).toBeVisible();
			await expect(heading).toBeFocused();
			await expect(step("Section 2 of 2")).toHaveAttribute(
				"aria-current",
				"step",
			);
			await expect(
				main.getByRole("button", { name: "Submit", exact: true }),
			).toBeVisible();
			await expect(next).toHaveCount(0);
		});

		await test.step("Back never validates and keeps the answer", async () => {
			await main.getByRole("button", { name: "Back", exact: true }).click();
			await expect(nameField).toHaveValue("Ada");
			await expect(step("Section 1 of 2")).toHaveAttribute(
				"aria-current",
				"step",
			);
		});

		await test.step("a flip back to editing opens on the page that was showing", async () => {
			await page
				.getByRole("button", { name: "Back to edit", exact: true })
				.click();
			await expect(
				main.getByText("Section 1 of 2", { exact: true }),
			).toBeVisible({ timeout: 20_000 });
		});
	});

	test("case changes add, retarget, preserve table lookups, and stay navigable to viewers", async ({
		page,
		browser,
		baseURL,
	}, testInfo) => {
		test.setTimeout(120_000);
		const caseChanges = seed.caseChanges[testInfo.retry];
		if (caseChanges === undefined) {
			throw new Error(
				`Case-changes fixture missing for Playwright attempt ${testInfo.retry}`,
			);
		}
		await page.goto(caseChanges.route);

		await expect(
			page.getByRole("heading", { name: "Case changes", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		// Lookup-backed expressions are intentionally read-only until their
		// Project definitions snapshot arrives. Wait for that explicit readiness
		// gate before sending keyboard mutations; otherwise a busy full-suite run
		// can correctly refuse the gesture while an isolated run happens to pass.
		await expect(
			page
				.getByRole("alert")
				.filter({ hasText: "Project data is still loading" }),
		).toHaveCount(0);

		// Rows read as sentences, in the order the runtime applies them.
		const list = page.getByRole("list", {
			name: "Case changes in the order they happen",
		});
		const rows = list.getByRole("listitem");
		await expect(rows).toHaveCount(CASE_CHANGES_SEQUENCE_LENGTH);
		await expect(rows.nth(0)).toContainText("Create a new referral case");
		await expect(rows.nth(3)).toContainText(
			`Update the archived referral case from \u201c${CASE_CHANGES_SEED.ids.create}\u201d`,
		);

		// The handle is the keyboard alternative to dragging, and its name
		// states where in the sequence this change is.
		const fileHandle = page.getByRole("button", {
			name: new RegExp(
				`^Move ${CASE_CHANGES_SEED.ids.file}\\. Runs 4 of ${CASE_CHANGES_SEQUENCE_LENGTH}`,
			),
		});
		await fileHandle.focus();

		// Home would put it ahead of the create whose case it changes. The
		// planner refuses, and the refusal NAMES the change it is about
		// rather than the key silently doing nothing.
		await page.keyboard.press("Home");
		const refusal = page
			.getByRole("alert")
			.filter({ hasText: `${CASE_CHANGES_SEED.ids.file} did not move` });
		await expect(refusal).toContainText(
			`${CASE_CHANGES_SEED.ids.file} did not move`,
		);
		// The moved change is the one whose reference would break, so the
		// sentence names what it DEPENDS on rather than naming it back.
		await expect(refusal).toContainText(
			`This change uses the case \u201c${CASE_CHANGES_SEED.ids.create}\u201d makes`,
		);
		// Nothing moved: the refusal came BEFORE the gesture, not after a
		// commit that had to be undone.
		await expect(rows.nth(0)).toContainText("Create a new referral case");
		await expect(rows.nth(3)).toContainText(
			`Update the archived referral case from \u201c${CASE_CHANGES_SEED.ids.create}\u201d`,
		);

		// The same keyboard path still moves a change nothing depends on.
		const noteHandle = page.getByRole("button", {
			name: new RegExp(
				`^Move ${CASE_CHANGES_SEED.ids.note}\\. Runs 3 of ${CASE_CHANGES_SEQUENCE_LENGTH}`,
			),
		});
		await noteHandle.focus();
		await page.keyboard.press("ArrowUp");
		await expect(
			page.getByRole("button", {
				name: new RegExp(
					`^Move ${CASE_CHANGES_SEED.ids.note}\\. Runs 2 of ${CASE_CHANGES_SEQUENCE_LENGTH}`,
				),
			}),
		).toBeVisible();

		await test.step("a change deep in the sequence states where it is and walks to its neighbours", async () => {
			// The list and the detail are mutually exclusive screens at every
			// width, so at twenty changes this is the whole of "where am I":
			// the detail's position and Previous / Next. Nothing here works by
			// reading the list, because the list is not on screen.
			const deep = CASE_CHANGES_ROUTINE.at(-1);
			const beforeDeep = CASE_CHANGES_ROUTINE.at(-2);
			if (deep === undefined || beforeDeep === undefined) {
				throw new Error("case-changes fixture: routine changes missing");
			}
			const deepPosition = CASE_CHANGES_SEQUENCE_LENGTH - 1;

			await page.locator(`[data-case-operation-select="${deep.uuid}"]`).click();
			await expect(
				page.getByText(`${deepPosition} of ${CASE_CHANGES_SEQUENCE_LENGTH}`),
			).toBeVisible();
			await expect(page.getByText(deep.id, { exact: true })).toBeVisible();

			await page.getByRole("button", { name: "Previous change" }).click();
			await expect(
				page.getByText(
					`${deepPosition - 1} of ${CASE_CHANGES_SEQUENCE_LENGTH}`,
				),
			).toBeVisible();
			await expect(
				page.getByText(beforeDeep.id, { exact: true }),
			).toBeVisible();

			// Two forward lands on the table-lookup change, which is last — so the
			// traversal ends rather than wrapping, and says so by going dead.
			const next = page.getByRole("button", { name: "Next change" });
			await next.click();
			await next.click();
			await expect(
				page.getByText(
					`${CASE_CHANGES_SEQUENCE_LENGTH} of ${CASE_CHANGES_SEQUENCE_LENGTH}`,
				),
			).toBeVisible();
			await expect(next).toBeDisabled();

			await page.getByRole("button", { name: "All case changes" }).click();
			await expect(rows).toHaveCount(CASE_CHANGES_SEQUENCE_LENGTH);
		});

		await test.step("retargeting across case types commits target and proven type together", async () => {
			await page
				.locator(
					`[data-case-operation-select="${CASE_CHANGES_SEED.operations.file}"]`,
				)
				.click();
			await expect(
				page.getByRole("heading", {
					name: new RegExp(
						`Update the archived referral case from .${CASE_CHANGES_SEED.ids.create}.`,
					),
					level: 1,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: "Connect to: A case found by a calculation",
				}),
			).toBeVisible();
			await expect(
				page.getByText("Work out the id of the case at the other end."),
			).toBeVisible();

			const target = page.getByRole("button", {
				name: new RegExp(
					`^Which case: The case from .${CASE_CHANGES_SEED.ids.create}.`,
				),
			});
			await target.click();
			await page
				.getByRole("menuitem", {
					name: /The case this form opened/,
				})
				.click();
			await expect(
				page.getByRole("button", { name: "Kind of case: Patient" }),
			).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: "Which case: The case this form opened",
				}),
			).toBeVisible();

			await page
				.getByRole("button", {
					name: "Which case: The case this form opened",
				})
				.click();
			await page
				.getByRole("menuitem", {
					name: new RegExp(`The case from .${CASE_CHANGES_SEED.ids.create}.`),
				})
				.click();
			await expect(
				page.getByRole("button", {
					name: "Kind of case: Archived referral",
				}),
			).toBeVisible();
		});

		await test.step("a persisted lookup-bearing change opens and stays editable", async () => {
			await page.getByRole("button", { name: "All case changes" }).click();
			await page
				.locator(
					`[data-case-operation-select="${CASE_CHANGES_SEED.operations.tableLookup}"]`,
				)
				.click();
			/* Reading a data table is ordinary expression vocabulary, not a
			 * reason to withdraw the editor: `planCaseOperationUpdate` states
			 * that no operation becomes read-only merely because one expression
			 * contains lookup-table logic. So there is no read-only note, and
			 * both pickers stay live. */
			await expect(
				page.getByRole("note").filter({ hasText: "lookup-table logic" }),
			).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: "Kind of case: Patient" }),
			).toBeEnabled();
			await expect(
				page.getByRole("button", {
					name: "Which case: The case this form opened",
				}),
			).toBeEnabled();

			await page.getByRole("button", { name: "All case changes" }).click();
			await expect(
				page.getByRole("button", {
					name: new RegExp(
						`^Move ${CASE_CHANGES_SEED.ids.tableLookup}\\. Runs ${CASE_CHANGES_SEQUENCE_LENGTH} of ${CASE_CHANGES_SEQUENCE_LENGTH}`,
					),
				}),
			).toBeVisible();
		});

		await test.step("a fresh link after an earlier retype adopts a prior create's rolling type atomically", async () => {
			await page.getByRole("button", { name: "Add a change" }).click();
			await page
				.getByRole("button", {
					name: "Update the case this form opened Save answers onto the case already in hand",
					exact: true,
				})
				.click();
			await expect(
				page.getByRole("heading", {
					name: "Update the case this form opened",
					level: 1,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Kind of case: Patient" }),
			).toBeVisible();
			await page.locator("[data-case-operation-add-link]").click();
			await expect(
				page.getByRole("button", {
					name: "Kind of case at the other end: Patient",
				}),
			).toBeVisible();

			await page
				.getByRole("button", {
					name: "Connect to: Remove this connection",
				})
				.click();
			await page
				.getByRole("menuitem", {
					name: new RegExp(`The case from .${CASE_CHANGES_SEED.ids.create}.`),
				})
				.click();
			await expect(
				page.getByRole("button", {
					name: "Kind of case at the other end: Archived referral",
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: new RegExp(
						`Connect to: The case from .${CASE_CHANGES_SEED.ids.create}.`,
					),
				}),
			).toBeVisible();

			// A calculated target has no honest persisted seed. Selecting it
			// opens a local draft in place while the stored link remains on the
			// prior create until the calculation becomes complete.
			await page
				.getByRole("button", {
					name: new RegExp(
						`Connect to: The case from .${CASE_CHANGES_SEED.ids.create}.`,
					),
				})
				.click();
			const calculatedTarget = page.getByRole("menuitem", {
				name: /^A case found by a calculation/,
			});
			await expect(calculatedTarget).toBeEnabled();
			await calculatedTarget.click();
			await expect(
				page.getByText("Work out the id of the case at the other end."),
			).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: new RegExp(
						`Connect to: The case from .${CASE_CHANGES_SEED.ids.create}.`,
					),
				}),
			).toBeVisible();
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(
				page.getByText("Work out the id of the case at the other end."),
			).not.toBeVisible();
			await expect(
				page.getByRole("button", {
					name: new RegExp(
						`Connect to: The case from .${CASE_CHANGES_SEED.ids.create}.`,
					),
				}),
			).toBeVisible();
		});

		await test.step("repairing the target submits real effects and the linked rows are visible", async () => {
			const removalSaved = page.waitForResponse(
				(response) =>
					response.request().method() === "PUT" &&
					new URL(response.url()).pathname === `/api/apps/${caseChanges.appId}`,
			);
			// The connection's Remove names which connection it removes, so a
			// screen-reader user hears more than "Remove" on a change that can
			// hold several.
			await page
				.getByRole("button", { name: "Remove the connection “parent”" })
				.click();
			expect((await removalSaved).ok()).toBe(true);

			// The button that did the removing unmounted with the row it
			// removed, so focus has to be handed forward or it falls to the
			// document body and the next Tab restarts at the top of the page.
			// That was the last connection, so the Add control is where the
			// rule (next, then previous, then Add) lands.
			await expect(
				page.locator("[data-case-operation-add-link]"),
			).toBeFocused();

			await page.getByRole("button", { name: "Preview", exact: true }).click();
			const relatedPatientCaseId = page.getByRole("textbox", {
				name: "Related patient case id",
			});
			await expect(relatedPatientCaseId).toBeVisible();
			const submit = page
				.locator("main")
				.getByRole("button", { name: "Submit", exact: true });
			await expect(submit).toBeEnabled();
			await relatedPatientCaseId.fill(caseChanges.caseId);
			await expect(relatedPatientCaseId).toHaveValue(caseChanges.caseId);
			await submit.click();

			const patientModule = page.locator("main").getByRole("button", {
				name: new RegExp(`^${CASE_CHANGES_SEED.moduleName}\\b`),
			});
			await expect(patientModule).toBeVisible({ timeout: 20_000 });
			await patientModule.click();
			await expect(
				page.getByRole("heading", {
					name: CASE_CHANGES_SEED.moduleName,
					level: 1,
				}),
			).toBeVisible();
			const patientRows = page
				.getByRole("list", { name: "Cases" })
				.getByRole("listitem");
			await expect(patientRows).toHaveCount(1);
			await expect(patientRows.first()).toContainText("Smoke patient");
			await expect(patientRows.first()).toContainText("Visited");

			await page.goBack();
			const archivedModule = page.locator("main").getByRole("button", {
				name: new RegExp(`^${CASE_CHANGES_SEED.archivedModuleName}\\b`),
			});
			await expect(archivedModule).toBeVisible();
			await archivedModule.click();
			// Archived referrals are child cases of Patients. Opening that module
			// therefore runs the existing parent-first selector before showing its
			// direct children. Pick the patient this submission linked, then continue
			// into the originally requested Results screen.
			await expect(
				page.getByRole("heading", {
					name: CASE_CHANGES_SEED.moduleName,
					level: 1,
				}),
			).toBeVisible();
			await page
				.getByRole("button", { name: /^View details for Smoke patient/ })
				.click();
			await expect(
				page.getByRole("heading", { name: "Smoke patient", level: 1 }),
			).toBeVisible();
			await page.getByRole("button", { name: "Continue", exact: true }).click();
			await expect(
				page.getByRole("heading", {
					name: CASE_CHANGES_SEED.archivedModuleName,
					level: 1,
				}),
			).toBeVisible();
			const archivedRows = page
				.getByRole("list", { name: "Cases" })
				.getByRole("listitem");
			await expect(archivedRows).toHaveCount(1);
			await expect(archivedRows.first()).toContainText("Referral");
			await expect(archivedRows.first()).toContainText("Filed");
			// The calculated Patient column traverses the persisted parent link.
			await expect(archivedRows.first()).toContainText("Smoke patient");

			await page.getByRole("button", { name: "Back to edit" }).click();
		});

		await test.step("a viewer can still open and inspect a case change", async () => {
			const viewerContext = await browser.newContext({
				baseURL: baseURL ?? undefined,
				storageState: caseChanges.viewerStateFile,
			});
			const viewerPage = await viewerContext.newPage();
			const viewerGuard = attachErrorGuard(viewerPage, baseURL);
			try {
				await viewerPage.goto(caseChanges.route);
				await expect(
					viewerPage.getByRole("heading", {
						name: "Case changes",
						level: 1,
					}),
				).toBeVisible({ timeout: 20_000 });
				await expect(
					viewerPage.getByRole("button", { name: /^Move / }),
				).toHaveCount(0);
				await expect(
					viewerPage.getByRole("button", { name: "Add a change" }),
				).toHaveCount(0);

				const openFile = viewerPage.locator(
					`[data-case-operation-select="${CASE_CHANGES_SEED.operations.file}"]`,
				);
				await expect(openFile).toBeVisible();
				await openFile.click();
				await expect(
					viewerPage.getByRole("heading", {
						name: new RegExp(
							`Update the archived referral case from .${CASE_CHANGES_SEED.ids.create}.`,
						),
						level: 1,
					}),
				).toBeVisible();
				await expect(
					viewerPage.getByRole("button", {
						name: "Kind of case: Archived referral",
					}),
				).toBeDisabled();
				await expect(
					viewerPage.getByRole("button", {
						name: "Connect to: A case found by a calculation",
					}),
				).toBeDisabled();
				await expect(
					viewerPage.getByText("Work out the id of the case at the other end."),
				).toBeVisible();
				viewerGuard.assertNoErrors();
			} finally {
				await viewerContext.close();
			}
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

	test("the header mark keeps its touch target and its home link on every surface", async ({
		page,
	}) => {
		/* One band serves the whole signed-in app, and this mark is its only
		 * home link — and the builder's only way out. It has to stay a real
		 * 44px target at every width, on both the lockup surface and the
		 * sphere-alone one. */
		const mark = page.locator("[data-app-header] a").first();

		for (const width of [1280, 380]) {
			await page.setViewportSize({ width, height: 800 });
			await page.goto("/");
			await expect(mark).toBeVisible({ timeout: 20_000 });
			const site = await mark.boundingBox();
			expect(site, `app list @${width}`).not.toBeNull();
			expect(site?.width, `app list @${width}`).toBeGreaterThanOrEqual(44);
			expect(site?.height, `app list @${width}`).toBeGreaterThanOrEqual(44);
			await expect(mark).toHaveAttribute("href", "/");

			await page.goto(`/build/${seed.openAppId}`);
			await expect(mark).toBeVisible({ timeout: 20_000 });
			const builder = await mark.boundingBox();
			expect(builder, `builder @${width}`).not.toBeNull();
			expect(builder?.width, `builder @${width}`).toBeGreaterThanOrEqual(44);
			expect(builder?.height, `builder @${width}`).toBeGreaterThanOrEqual(44);
			/* The band never moves between surfaces: that is the whole reason
			 * there is one of it. */
			expect(builder?.x, `builder @${width} x`).toBe(site?.x);
			expect(builder?.y, `builder @${width} y`).toBe(site?.y);
			await expect(mark).toHaveAttribute("href", "/");
		}
	});

	test("help is reachable from inside a build, through the account menu", async ({
		page,
	}) => {
		/* Docs and Give feedback used to be a "Help" dropdown among the band's own
		 * menus, which are the UNCLAIMED state — so they were gone for the whole
		 * of a build, which is exactly when someone reaches for the docs. They are
		 * rows in the account menu now, and the account control is on every
		 * signed-in surface. Drive the builder, because the site is the surface
		 * that already worked. */
		await page.goto(`/build/${seed.openAppId}`);

		const account = page.getByRole("button", { name: "Account menu" });
		await expect(account).toBeVisible({ timeout: 20_000 });
		await account.click();

		for (const name of ["Docs", "Give feedback"]) {
			const link = page.getByRole("link", { name, exact: true });
			await expect(link).toBeVisible();
			/* A new tab, and no handle back onto this one. */
			await expect(link).toHaveAttribute("target", "_blank");
			await expect(link).toHaveAttribute("rel", /noopener/);
		}

		/* And the band no longer carries a Help control of its own, on either
		 * surface. */
		await expect(
			page.locator("[data-app-header]").getByRole("button", { name: "Help" }),
		).toHaveCount(0);
		await page.goto("/");
		await expect(account).toBeVisible({ timeout: 20_000 });
		await expect(
			page.locator("[data-app-header]").getByRole("button", { name: "Help" }),
		).toHaveCount(0);
	});

	test("the from-scratch escape hatch mints the canonical starter and opens it (no LLM)", async ({
		page,
	}) => {
		await page.goto("/build/new");

		const startFromScratch = page.getByRole("button", {
			name: "Start with a blank app",
		});
		await expect(startFromScratch).toBeVisible({ timeout: 20_000 });

		// The chat owns the screen until an app exists, so the sidebar chrome is
		// absent here — this is the "centered, phase = Idle" state.
		await expect(
			page.getByRole("button", { name: "Collapse chat sidebar" }),
		).toHaveCount(0);

		// Stamp the live builder tree. Creation installs the app in place, so
		// this node has to survive it: a route change here would swap
		// `BuilderProvider`'s `key={buildId}` and rebuild everything under it,
		// which is what the SPA path exists to avoid. It has to be a node the
		// BUILDER owns — the header is mounted above both route groups and
		// survives a route change either way, so stamping it proves nothing.
		await page.locator("[data-builder-tree]").evaluate((el) => {
			el.dataset.e2eBuilderGeneration = "before-create";
		});

		await startFromScratch.click();

		// The real createStarterApp Server Action → createApp → the client
		// installs the returned receipt and promotes the URL through the
		// builder's own History API path.
		await page.waitForURL(/\/build\/(?!new)[\w-]+$/, { timeout: 30_000 });
		await expect(
			page.locator("[data-builder-tree][data-e2e-builder-generation]"),
		).toHaveCount(1);

		// The chat DOCKED, which only happens once `docHasData` (moduleOrder is
		// non-empty). That is the load-bearing assertion: the from-scratch path
		// opens the canonical starter rather than reconstructing a zero-module app.
		await expect(
			page.getByRole("button", { name: "Collapse chat sidebar" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(startFromScratch).toHaveCount(0);
	});

	test("a scripted reviewed build stays plain-language and read-only until every workflow finishes", async ({
		page,
	}) => {
		const activation = seed.designBuildActivation;
		await stubDesignBuildJourney(page, activation);
		await page.goto("/build/new");

		await page
			.getByPlaceholder("Describe your app")
			.fill("Build a small referral tracker with intake and follow-up");
		await page.getByRole("button", { name: "Send" }).click();

		/* The first pause shows the reviewed design in human terms. Internal
		 * design tools and their model-facing receipts never become chat UI. */
		await expect(
			page
				.locator('[data-question-card="waiting"]')
				.getByText("How quickly should follow-up begin?"),
		).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText("Reviewed design")).toBeVisible();
		await expect(
			page.getByText("Type your answer below", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("or type your answer below", { exact: true }),
		).toHaveCount(0);
		for (const internalName of [
			"finishDesign",
			"requestReview",
			"updateFindingDispositions",
			"submitPlan",
		]) {
			await expect(page.getByText(internalName, { exact: true })).toHaveCount(
				0,
			);
		}
		await expect(page).toHaveURL(
			new RegExp(`/build/new\\?design=${activation.designSessionId}$`),
		);

		/* The one truthful status line is the final row immediately above the
		 * composer, not stranded above the outline or elsewhere in the log. */
		const firstStatus = page
			.getByRole("status")
			.filter({ hasText: "Waiting on your answer" });
		await expect(firstStatus).toBeVisible();
		const firstComposer = page.getByPlaceholder(
			"What would you like to change?",
		);
		const [firstStatusBox, firstComposerBox] = await Promise.all([
			firstStatus.boundingBox(),
			firstComposer.boundingBox(),
		]);
		expect(firstStatusBox).not.toBeNull();
		expect(firstComposerBox).not.toBeNull();
		expect(
			(firstStatusBox?.y ?? 0) + (firstStatusBox?.height ?? 0),
		).toBeLessThanOrEqual(firstComposerBox?.y ?? 0);

		await firstComposer.fill("Within two days");
		await page.getByRole("button", { name: "Send" }).click();

		/* Genesis activates the real tree, but the initial-build latch keeps every
		 * direct editor locked and the center canvas on progress. */
		await page.waitForURL(`/build/${activation.appId}`, { timeout: 20_000 });
		await expect(
			page.getByText("Who should see the follow-up queue?"),
		).toBeVisible();
		await expect(page.locator("[data-generation-progress-card]")).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: "Find in app" }),
		).toBeDisabled();
		await expect(page.getByRole("button", { name: "Add module" })).toHaveCount(
			0,
		);
		await expect(
			page.getByText("or type your answer below", { exact: true }),
		).toBeVisible();

		await page
			.getByRole("button", { name: "Follow-up coordinators", exact: true })
			.click();

		/* Completion releases the same store latch: progress leaves the canvas
		 * and the ordinary authoring controls become available without a reload. */
		await expect(
			page.getByText("Your referral app is ready to try."),
		).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.locator("[data-generation-progress-card]")).toHaveCount(
			0,
		);
		await expect(
			page.getByRole("textbox", { name: "Find in app" }),
		).toBeEnabled();
		await expect(
			page.getByRole("button", { name: "Add module" }),
		).toBeVisible();
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
			page.getByText("Your conversation with Nova appears here"),
		).toBeVisible();

		// The old conversation is one list-click away — nothing was lost.
		await page.getByRole("button", { name: "History" }).click();
		await page.getByText(seed.threadUserText).click();
		await expect(page.getByText(seed.threadAssistantText)).toBeVisible({
			timeout: 10_000,
		});
	});

	test("assistant text can be selected without unmounting the chat shell", async ({
		page,
	}) => {
		await page.goto(`/build/${seed.threadsAppId}`);

		const assistantMessage = page.getByText(seed.threadAssistantText);
		await expect(assistantMessage).toBeVisible({ timeout: 20_000 });
		const chatPanel = page.locator("[data-builder-chat-panel]");
		const panelBeforeDrag = await chatPanel.boundingBox();
		expect(panelBeforeDrag).not.toBeNull();
		const messageBox = await assistantMessage.boundingBox();
		expect(messageBox).not.toBeNull();
		if (!messageBox) return;

		const y = messageBox.y + Math.min(messageBox.height / 2, 12);
		await page.mouse.move(messageBox.x + 4, y);
		await page.mouse.down();
		await page.mouse.move(
			messageBox.x + Math.min(messageBox.width - 4, 180),
			y,
			{
				steps: 8,
			},
		);

		/* Drawer.Popup without Drawer.Content interpreted this ordinary selection
		 * as a dismiss swipe and translated the whole chat surface away. DOM-only
		 * visibility still passed, so assert its painted viewport geometry while
		 * the pointer remains held. */
		await expect(page.locator("[data-app-header]")).toBeVisible();
		await expect(page.getByRole("log")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Collapse chat sidebar" }),
		).toBeVisible();
		const panelDuringDrag = await chatPanel.boundingBox();
		expect(panelDuringDrag).not.toBeNull();
		expect(panelDuringDrag?.x).toBeCloseTo(panelBeforeDrag?.x ?? 0, 0);

		const selectedText = await page.evaluate(
			() => window.getSelection()?.toString() ?? "",
		);
		expect(selectedText.trim().length).toBeGreaterThan(0);
		await page.mouse.up();
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

		const composer = page.getByPlaceholder("What would you like to change?");
		const submit = page.getByRole("button", { name: "Send" });

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
		const composer = page.getByPlaceholder("What would you like to change?");
		await composer.fill("The community team handles it");
		await page.getByRole("button", { name: "Send" }).click();
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
		// Layout/transforms can report 43.999969px for a 44px target. Compare
		// rendered pixel sizes, not incidental floating-point subtraction noise.
		expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(44);
		expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);

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
		browser,
		baseURL,
	}) => {
		test.setTimeout(300_000);

		// 1. The workspace lists the Project's tables, and says they are shared.
		await page.goto(seed.caseWorkspace.routes.projectData);
		await expect(
			page.getByRole("heading", { name: "Data tables", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByText("shared with every app in this Project", { exact: false }),
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
		const emptyLookupTablePath = new URL(page.url()).pathname;
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
		const populatedLookupTablePath = new URL(page.url()).pathname;
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

		// Ordering is an ordinary, revision-fenced table edit. Exercise both
		// directions and restore the seed order so retries remain independent.
		await page
			.getByRole("button", {
				name: new RegExp(CASE_WORKSPACE_SEED.lookupLabelColumnLabel),
			})
			.first()
			.click();
		const moveColumnLeft = page.getByRole("button", { name: "Move left" });
		await expect(moveColumnLeft).toBeEnabled();
		await moveColumnLeft.click();
		await expect(
			page.getByRole("status").filter({ hasText: "Column moved earlier." }),
		).toBeVisible();
		const moveColumnRight = page.getByRole("button", { name: "Move right" });
		await expect(moveColumnRight).toBeEnabled();
		await moveColumnRight.click();
		await expect(
			page.getByRole("status").filter({ hasText: "Column moved later." }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Close properties", exact: true })
			.click();

		// Table identity changes in the URL synchronously. Sampling the first
		// two animation frames catches the former A-under-B paint; browser
		// Back/Forward then proves the same fence is not limited to button
		// navigation.
		const headingsDuringDirectNavigation = await page.evaluate(async (path) => {
			window.history.pushState(window.history.state, "", path);
			window.dispatchEvent(new PopStateEvent("popstate"));
			const headings: Array<string | null> = [];
			for (let frame = 0; frame < 2; frame += 1) {
				await new Promise<void>((resolve) =>
					window.requestAnimationFrame(() => resolve()),
				);
				headings.push(
					document
						.querySelector("#project-data-table-heading")
						?.textContent?.trim() ?? null,
				);
			}
			return headings;
		}, emptyLookupTablePath);
		expect(headingsDuringDirectNavigation).not.toContain(
			CASE_WORKSPACE_SEED.lookupTableName,
		);
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.emptyLookupTableName,
				level: 1,
			}),
		).toBeVisible();
		await page.goBack();
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.lookupTableName,
				level: 1,
			}),
		).toBeVisible();
		await page.goForward();
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.emptyLookupTableName,
				level: 1,
			}),
		).toBeVisible();
		await page.evaluate((path) => {
			window.history.pushState(window.history.state, "", path);
			window.dispatchEvent(new PopStateEvent("popstate"));
		}, populatedLookupTablePath);
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.lookupTableName,
				level: 1,
			}),
		).toBeVisible();

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
			page.getByText(
				"One retained row draft or decision is kept in this table.",
			),
		).toBeVisible();
		await page.getByRole("button", { name: "Review row work" }).click();
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
		await page.getByRole("button", { name: "Review row work" }).click();
		await expect(destination).toHaveValue("  District hospital  ");

		await page.getByRole("button", { name: "All data tables" }).click();
		const recovery = page.getByRole("region", {
			name: "Row work to review",
		});
		await expect(recovery).toBeVisible();
		await expect(
			recovery.getByText(CASE_WORKSPACE_SEED.lookupTableName, {
				exact: true,
			}),
		).toBeVisible();
		await recovery.getByRole("button", { name: /Review unsaved row/ }).click();
		await expect(destination).toHaveValue("  District hospital  ");

		await page.getByRole("button", { name: "Add row" }).focus();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "Close properties", exact: true }),
		).toBeHidden();
		await expect(openedRow).toBeFocused();
		await page.getByRole("button", { name: "Review row work" }).click();
		await expect(destination).toHaveValue("  District hospital  ");

		// The origin survives selection teardown at every shell width. Narrow
		// Close returns to the exact column header; handset Escape returns to
		// the exact row Open control through Base UI's deferred finalFocus.
		await page.setViewportSize({ width: 800, height: 800 });
		await page
			.getByRole("button", { name: "Close properties", exact: true })
			.click();
		await expect(openedRow).toBeFocused();
		const destinationColumn = page
			.getByRole("button", {
				name: new RegExp(CASE_WORKSPACE_SEED.lookupLabelColumnLabel),
			})
			.first();
		await destinationColumn.click();
		await expect(
			page.getByRole("heading", {
				name: CASE_WORKSPACE_SEED.lookupLabelColumnLabel,
				level: 2,
			}),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Close properties", exact: true })
			.click();
		await expect(destinationColumn).toBeFocused();
		await page.getByRole("button", { name: "Review row work" }).click();

		await page.setViewportSize({ width: 500, height: 780 });
		await destination.focus();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "Close properties", exact: true }),
		).toBeHidden();
		await expect(openedRow).toBeFocused();

		await page.setViewportSize({ width: 1280, height: 900 });
		await page.getByRole("button", { name: "Review row work" }).click();
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
		const moveRowUp = page.getByRole("button", { name: "Move up" });
		await expect(moveRowUp).toBeEnabled();
		await moveRowUp.click();
		await expect(
			page.getByRole("status").filter({ hasText: "Row moved earlier." }),
		).toBeVisible();
		const moveRowDown = page.getByRole("button", { name: "Move down" });
		await expect(moveRowDown).toBeEnabled();
		await moveRowDown.click();
		await expect(
			page.getByRole("status").filter({ hasText: "Row moved later." }),
		).toBeVisible();

		// 4. The gesture the unit is for: bind a question's choices to a column.
		await page.goto(seed.caseWorkspace.routes.selectField);
		const source = page.getByRole("combobox", {
			name: "Where the choices come from",
		});
		await expect(source).toBeVisible({ timeout: 20_000 });
		// It starts on the field's one committed inline source.
		await expect(source).toHaveText("Options in this question");

		await source.click();
		await page
			.getByRole("option", { name: CASE_WORKSPACE_SEED.lookupTableName })
			.click();

		/* Choosing a table starts a local draft. Nova does not auto-bind either
		 * column and does not replace the committed inline source until the
		 * author completes and confirms the whole lookup source. */
		const savedValue = page.getByRole("combobox", {
			name: "Value that gets saved",
		});
		const shownValue = page.getByRole("combobox", {
			name: "Value people see",
		});
		await expect(savedValue).toBeVisible({ timeout: 20_000 });
		await expect(shownValue).toBeVisible();
		await expect(source).toHaveText(CASE_WORKSPACE_SEED.lookupTableName);
		await expect(savedValue).toHaveText("Choose a column");
		await expect(shownValue).toHaveText("Choose a column");
		const useTable = page.getByRole("button", { name: "Use this table" });
		await expect(useTable).toBeDisabled();

		await savedValue.click();
		await page
			.getByRole("option", {
				name: CASE_WORKSPACE_SEED.lookupValueColumnLabel,
			})
			.click();
		/* Wait for the first picker to commit and its popup to leave before
		 * opening the second. Both list the SAME table's columns, so while a
		 * closing popup is still mounted for its exit animation every column
		 * name matches twice and the next click is ambiguous. Asserting the
		 * committed value and an empty listbox says exactly that, rather than
		 * hoping the animation lost the race. */
		await expect(savedValue).toHaveText(
			CASE_WORKSPACE_SEED.lookupValueColumnLabel,
		);
		await expect(page.getByRole("listbox")).toHaveCount(0);

		await shownValue.click();
		await page
			.getByRole("option", {
				name: CASE_WORKSPACE_SEED.lookupLabelColumnLabel,
			})
			.click();
		await expect(shownValue).toHaveText(
			CASE_WORKSPACE_SEED.lookupLabelColumnLabel,
		);
		await expect(useTable).toBeEnabled();
		await useTable.click();
		await expect(useTable).toBeHidden({ timeout: 20_000 });
		await expect(source).toHaveText(CASE_WORKSPACE_SEED.lookupTableName);

		// 5. Switching back stages a fresh, complete inline source too. There is
		// no dormant lookup receiver and no retained inline fallback.
		await source.click();
		await page
			.getByRole("option", { name: "Options in this question" })
			.click();
		const useInline = page.getByRole("button", {
			name: "Use these options",
		});
		await expect(useInline).toBeVisible();
		await expect(source).toHaveText("Options in this question");
		await expect(useInline).toBeEnabled();
		await useInline.click();
		await expect(useInline).toBeHidden({ timeout: 20_000 });
		await expect(
			page.getByRole("combobox", { name: "Value that gets saved" }),
		).toBeHidden();

		// 6. Retype conflicts keep raw temporal text visible until a deliberate
		// replacement, and a table deleted in another browser upgrades BOTH a
		// dirty save conflict and a pristine delete conflict while this tab is
		// looking elsewhere.
		const appStream = "**/api/apps/*/stream*";
		const recoveryContext = await browser.newContext({
			storageState: await page.context().storageState(),
		});
		/* Install the route before this context creates its first EventSource.
		 * That makes the optimistic conflict deterministic without taking the
		 * whole page offline (which would also fail the table read). */
		await recoveryContext.route(appStream, (route) =>
			route.abort("blockedbyclient"),
		);
		const recoveryPage = await recoveryContext.newPage();
		const recoveryGuard = attachErrorGuard(recoveryPage, baseURL);
		await recoveryPage.goto(seed.caseWorkspace.routes.projectData);
		const temporalTableName = `Smoke temporal recovery ${Date.now()}`;
		await recoveryPage.getByRole("button", { name: "New data table" }).click();
		const createTable = recoveryPage.getByRole("dialog", {
			name: "Create a data table",
		});
		await createTable
			.getByRole("textbox", { name: "Table name" })
			.fill(temporalTableName);
		/* `exact` because every column carries a "Name in exports and CSV" field
		 * that a substring match would also pick up. */
		await createTable
			.getByRole("textbox", { name: "Name in exports", exact: true })
			.fill(`smoke_${Date.now().toString(36)}`);
		/* Each column is its own fieldset, legend "Column N" — that grouping is
		 * what tells the fields apart now that they carry ordinary visible
		 * labels instead of per-column aria-labels. */
		await createTable
			.getByRole("group", { name: "Column 1" })
			.getByRole("textbox", { name: "Name people see" })
			.fill("Visit date");
		await createTable
			.getByRole("button", { name: "Add another column" })
			.click();
		await createTable
			.getByRole("group", { name: "Column 2" })
			.getByRole("textbox", { name: "Name people see" })
			.fill("Visit moment");
		await createTable.getByRole("button", { name: "Create table" }).click();
		await expect(
			recoveryPage.getByRole("heading", {
				name: temporalTableName,
				level: 1,
			}),
		).toBeVisible({ timeout: 20_000 });
		const temporalTablePath = new URL(recoveryPage.url()).pathname;

		const addTemporalRow = async (dateText: string, dateTimeText: string) => {
			await recoveryPage.getByRole("button", { name: "Add row" }).click();
			await recoveryPage
				.getByRole("textbox", { name: /^Visit date/ })
				.fill(dateText);
			await recoveryPage
				.getByRole("textbox", { name: /^Visit moment/ })
				.fill(dateTimeText);
			await recoveryPage.getByRole("button", { name: "Save row" }).click();
			await expect(
				recoveryPage.getByRole("status").filter({ hasText: "Saved." }),
			).toBeVisible();
			await recoveryPage
				.getByRole("button", { name: "Close properties", exact: true })
				.click();
		};
		await addTemporalRow("2026-01-01", "2026-01-01T10:00:00Z");
		await addTemporalRow("2026-02-02", "2026-02-02T11:00:00Z");

		const firstTemporalRow = recoveryPage.getByRole("row", {
			name: /2026-01-01/,
		});
		await firstTemporalRow.getByRole("button", { name: /^Open row/ }).click();
		await recoveryPage
			.getByRole("textbox", { name: /^Visit date/ })
			.fill("not-a-date");
		await recoveryPage
			.getByRole("textbox", { name: /^Visit moment/ })
			.fill("not-a-datetime");

		const peerContext = await browser.newContext({
			storageState: await recoveryContext.storageState(),
		});
		const peerPage = await peerContext.newPage();
		const peerGuard = attachErrorGuard(peerPage, baseURL);
		await peerPage.goto(temporalTablePath);
		await expect(
			peerPage.getByRole("heading", {
				name: temporalTableName,
				level: 1,
			}),
		).toBeVisible({ timeout: 20_000 });

		const retypeColumn = async (
			label: string,
			nextType: "Date" | "Date and time",
		) => {
			await peerPage
				.getByRole("columnheader", { name: new RegExp(label) })
				.getByRole("button")
				.click();
			const type = peerPage.getByRole("combobox", {
				name: "Type of value",
			});
			await type.click();
			await peerPage
				.getByRole("option", { name: nextType, exact: true })
				.click();
			const confirmation = peerPage.getByRole("alertdialog");
			await expect(
				confirmation.getByText("No app in this Project uses it right now."),
			).toBeVisible();
			await confirmation.getByRole("button", { name: "Change type" }).click();
			await expect(confirmation).toBeHidden();
		};
		await retypeColumn("Visit date", "Date");
		await retypeColumn("Visit moment", "Date and time");

		await recoveryPage.getByRole("button", { name: "Save row" }).click();
		await expect(
			recoveryPage.getByRole("heading", { name: "Not saved", level: 2 }),
		).toBeVisible();
		await expect(
			recoveryPage.getByText("not-a-date", { exact: true }),
		).toBeVisible();
		await expect(
			recoveryPage.getByText("not-a-datetime", { exact: true }),
		).toBeVisible();
		await recoveryPage
			.getByRole("button", { name: "Keep my reconciled row" })
			.click();
		await expect(
			recoveryPage.locator('[data-slot="date-picker"][aria-invalid="true"]'),
		).toHaveCount(2);
		const reconciledMomentTime = recoveryPage.getByRole("textbox", {
			name: "Visit moment time",
		});
		await expect(reconciledMomentTime).toHaveAttribute("aria-invalid", "true");
		await reconciledMomentTime.fill("3:15 PM");
		await expect(
			recoveryPage.getByText("not-a-datetimeT3:15 PM", { exact: true }),
		).toBeVisible();
		await recoveryPage
			.getByRole("button", { name: "Close properties", exact: true })
			.click();

		// Open row two with no local edit. This context's stream was blocked
		// before its first navigation, so the peer write leaves this exact
		// snapshot stale and Delete produces a conflict with NO row-edit session.
		const secondTemporalRow = recoveryPage.getByRole("row", {
			name: /2026-02-02/,
		});
		await secondTemporalRow.getByRole("button", { name: /^Open row/ }).click();

		const peerSecondRow = peerPage.getByRole("row", {
			name: /2026-02-02/,
		});
		await peerSecondRow.getByRole("button", { name: /^Open row/ }).click();
		await peerPage
			.getByRole("textbox", { name: "Visit moment time" })
			.fill("12:00 PM");
		await peerPage.getByRole("button", { name: "Save row" }).click();
		await expect(
			peerPage.getByRole("status").filter({ hasText: "Saved." }),
		).toBeVisible();

		await recoveryPage.getByRole("button", { name: "Delete row" }).click();
		await expect(recoveryPage.getByText("Delete this row?")).toBeVisible();
		await recoveryPage.getByRole("button", { name: "Delete row" }).click();
		await expect(
			recoveryPage.getByText("This row wasn't deleted"),
		).toBeVisible();

		// Leave the conflicted table, reconnect this page's stream, and delete
		// the table from the other browser. The table-list recovery section is
		// the only honest discovery surface for both retained rows.
		await recoveryPage.getByRole("button", { name: "All data tables" }).click();
		await recoveryPage
			.getByRole("button", {
				name: new RegExp(`^${CASE_WORKSPACE_SEED.emptyLookupTableName}`),
			})
			.click();
		await recoveryContext.unroute(appStream);
		await peerPage.getByRole("button", { name: "Delete table" }).click();
		const peerDeleteTable = peerPage.getByRole("alertdialog");
		await expect(
			peerDeleteTable.getByText("No app in this Project uses it right now."),
		).toBeVisible();
		await peerDeleteTable.getByRole("button", { name: "Delete table" }).click();
		await expect(
			peerPage.getByRole("heading", { name: "Data tables", level: 1 }),
		).toBeVisible();
		peerGuard.assertNoErrors();
		await peerContext.close();

		await recoveryPage.getByRole("button", { name: "All data tables" }).click();
		const deletedTableRecovery = recoveryPage.getByRole("region", {
			name: "Row work to review",
		});
		await expect(
			deletedTableRecovery.getByText(temporalTableName, { exact: true }),
		).toHaveCount(2, { timeout: 40_000 });
		await expect(
			deletedTableRecovery.getByText(
				"Original table unavailable. Copy or discard this local row",
				{ exact: true },
			),
		).toHaveCount(2);

		const deletedTableReviews = deletedTableRecovery.getByRole("button", {
			name: /Review original table unavailable/,
		});
		await deletedTableReviews.first().click();
		await expect(
			recoveryPage.getByRole("heading", {
				name: "Local row copy recovered",
				level: 2,
			}),
		).toBeVisible();
		await expect(
			recoveryPage.getByText("not-a-date", { exact: true }),
		).toBeVisible();
		await expect(
			recoveryPage.getByText("not-a-datetimeT3:15 PM", { exact: true }),
		).toBeVisible();
		await recoveryPage
			.getByRole("button", { name: "Discard local copy" })
			.click();

		await recoveryPage.getByRole("button", { name: "All data tables" }).click();
		await recoveryPage
			.getByRole("region", { name: "Row work to review" })
			.getByRole("button", {
				name: /Review original table unavailable/,
			})
			.click();
		await expect(
			recoveryPage.getByText("2026-02-02", { exact: true }),
		).toBeVisible();
		await expect(
			recoveryPage.getByText("2026-02-02T11:00:00Z", { exact: true }),
		).toBeVisible();
		await recoveryPage
			.getByRole("button", { name: "Discard local copy" })
			.click();

		// 7. A self-delete follows the same contract immediately, before a
		// realtime round trip: the dirty row remains discoverable on the list,
		// and only its explicit local discard removes it.
		await recoveryPage.getByRole("button", { name: "All data tables" }).click();
		await recoveryPage
			.getByRole("button", {
				name: new RegExp(`^${CASE_WORKSPACE_SEED.emptyLookupTableName}`),
			})
			.click();
		await recoveryPage.getByRole("button", { name: "Add row" }).click();
		await recoveryPage
			.getByRole("textbox", {
				name: new RegExp(`^${CASE_WORKSPACE_SEED.emptyLookupColumnLabel}`),
			})
			.fill("self-delete local draft");
		await recoveryPage.getByRole("button", { name: "Delete table" }).click();
		const selfDeleteTable = recoveryPage.getByRole("alertdialog");
		await expect(
			selfDeleteTable.getByText(
				"Nova will keep the one local row draft or decision",
				{ exact: false },
			),
		).toBeVisible();
		await expect(
			selfDeleteTable.getByText("No app in this Project uses it right now."),
		).toBeVisible();
		await selfDeleteTable.getByRole("button", { name: "Delete table" }).click();
		const selfDeleteRecovery = recoveryPage.getByRole("region", {
			name: "Row work to review",
		});
		await expect(selfDeleteRecovery).toBeVisible();
		await selfDeleteRecovery
			.getByRole("button", {
				name: /Review original table unavailable/,
			})
			.click();
		await expect(
			recoveryPage.getByText("self-delete local draft", { exact: true }),
		).toBeVisible();
		await recoveryPage
			.getByRole("button", { name: "Discard local copy" })
			.click();
		await recoveryPage.getByRole("button", { name: "All data tables" }).click();
		await expect(
			recoveryPage.getByRole("region", { name: "Row work to review" }),
		).toBeHidden();
		recoveryGuard.assertNoErrors();
		await recoveryContext.close();
	});
});
