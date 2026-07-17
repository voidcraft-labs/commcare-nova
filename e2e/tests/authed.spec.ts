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
	caseWorkspace: {
		routes: {
			results: string;
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

async function bottomGap(page: Page): Promise<number> {
	return page
		.getByRole("log")
		.evaluate((el) =>
			Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
		);
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
	const caseData = page.getByRole("button", { name: /^Case data,/ });
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
				page.getByRole("button", { name: "Close inspector" }),
			).toBeInViewport({ ratio: 0.9 });
			await expectSecondaryHeadersAligned(page, [
				"structure",
				"breadcrumb",
				"inspector",
			]);
			await expectCaseDataClearance(page);
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
