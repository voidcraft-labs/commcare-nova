import { resolve } from "node:path";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

test("pending edits survive reload and expose deliberate continue, discard and stale restart", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/pending-chat-work-client.tsx", [], {
		"@/app/(app)/build/work-actions": resolve(
			"e2e/lib/pending-chat-work-boundary.ts",
		),
	});
	let stale = false;
	let readFailed = true;
	let discarded = false;
	const requests: Array<{ requestId: string }> = [];
	await page.route("**/native/work/read", (route) =>
		route.fulfill({
			json: readFailed
				? { success: false, error: "Nova could not check pending changes." }
				: {
						success: true,
						work: discarded
							? null
							: {
									workId: "22222222-2222-4222-8222-222222222222",
									revision: "candidate:2",
									pendingChanges: 2,
									stale,
								},
					},
		}),
	);
	await page.route("**/native/work/discard", async (route) => {
		requests.push(route.request().postDataJSON());
		if (requests.length === 1) {
			await route.fulfill({
				json: { success: false, error: "Wait for the active run to finish." },
			});
			return;
		}
		discarded = true;
		await route.fulfill({ json: { success: true } });
	});
	try {
		await page.goto(peer.origin);
		await expect(page.getByRole("alert")).toContainText("could not check");
		readFailed = false;
		await page.getByRole("button", { name: "Try again" }).click();
		await expect(page.getByText("Changes waiting to be saved")).toBeVisible();
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Continue", exact: true }),
		).toBeEnabled();
		await page.getByRole("button", { name: "Start run" }).click();
		await expect(
			page.getByRole("button", { name: "Discard", exact: true }),
		).toBeDisabled();
		await page.getByRole("button", { name: "Finish run" }).click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(page.getByLabel("Sent requests")).toContainText(
			"preserved private work",
		);
		stale = true;
		await page.getByRole("button", { name: "Receive saved revision" }).click();
		await expect(
			page.getByRole("button", { name: "Restart from saved app" }),
		).toBeVisible();
		await page.getByRole("button", { name: "Discard", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText(
			"Wait for the active run",
		);
		await expect(page.getByText("Changes waiting to be saved")).toBeVisible();
		await page.getByRole("button", { name: "Discard", exact: true }).click();
		await expect(
			page.getByText("Changes waiting to be saved"),
		).not.toBeVisible();
		expect(requests[0].requestId).toBe(requests[1].requestId);
		discarded = false;
		stale = true;
		await page.reload();
		await expect(
			page.getByText("Restart discards these pending changes", {
				exact: false,
			}),
		).toBeVisible();
		await page.screenshot({ path: "e2e/test-results/pending-chat-work.png" });
		await page.getByRole("button", { name: "Restart from saved app" }).click();
		await expect(page.getByLabel("Sent requests")).toContainText(
			"previous pending changes were discarded",
		);
		expect(discarded).toBe(true);
	} finally {
		await page.goto("about:blank");
		await peer.close();
	}
});

test("switching conversations suppresses a late restart response", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/pending-chat-work-client.tsx", [], {
		"@/app/(app)/build/work-actions": resolve(
			"e2e/lib/pending-chat-work-boundary.ts",
		),
	});
	let release: () => void = () => {};
	const responseReady = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = false;
	let entered: () => void = () => {};
	const requestEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let completed: () => void = () => {};
	const requestCompleted = new Promise<void>((resolve) => {
		completed = resolve;
	});
	await page.route("**/native/work/read", (route) =>
		route.fulfill({
			json: {
				success: true,
				work: {
					workId: "22222222-2222-4222-8222-222222222222",
					revision: "candidate:2",
					pendingChanges: 2,
					stale: true,
				},
			},
		}),
	);
	await page.route("**/native/work/discard", async (route) => {
		started = true;
		entered();
		try {
			await responseReady;
			await route.fulfill({ json: { success: true } });
		} finally {
			completed();
		}
	});
	try {
		await page.goto(peer.origin);
		await page.getByRole("button", { name: "Restart from saved app" }).click();
		await requestEntered;
		await page.getByRole("button", { name: "Switch conversation" }).click();
		release();
		await requestCompleted;
		await expect(page.getByLabel("Sent requests")).toHaveText("");
	} finally {
		release();
		if (started) await requestCompleted;
		await page.goto("about:blank");
		await peer.close();
	}
});
