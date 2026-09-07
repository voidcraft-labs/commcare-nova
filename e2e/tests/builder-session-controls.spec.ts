import { resolve } from "node:path";
import type { Route } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer(
		"e2e/lib/builder-session-controls-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": resolve(
				"e2e/lib/builder-session-controls-boundary.ts",
			),
		},
	);
});
test.afterAll(async () => {
	await peer?.close();
});

test("native persona removal waits for its count, restores cancel focus, retries transport loss, and removes through the real gate", async ({
	page,
}) => {
	let held: Route | undefined;
	let completed = false;
	let calls = 0;
	await page.route("**/persona-count", async (route) => {
		calls += 1;
		if (calls === 1) {
			held = route;
			return;
		}
		await route.fulfill({ json: { kind: "count", count: 3 } });
	});
	try {
		await page.goto(peer.origin);
		await page
			.getByRole("button", { name: "Remove persona", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Remove", exact: true }),
		).toBeDisabled();
		await expect.poll(() => held !== undefined).toBe(true);
		const pending = held;
		if (!pending) throw new Error("Missing actual count request");
		expect(pending.request().postDataJSON()).toMatchObject({
			appId: "native-session",
			personaUuid: "10000000-0000-4000-8000-000000007100",
		});
		await pending.abort("failed");
		completed = true;
		await expect(
			page.getByText(
				"Nova couldn't verify every case this persona owns. Try again before removing them.",
				{ exact: true },
			),
		).toBeVisible();
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		await expect(
			page.getByText(/Asha owns 3 cases, including any in retired case types/),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Remove", exact: true }),
		).toBeEnabled();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Remove persona", exact: true }),
		).toBeFocused();
		await page
			.getByRole("button", { name: "Remove persona", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Remove", exact: true }),
		).toBeEnabled();
		await page.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(page.getByLabel("Saved personas")).toHaveText("[]");
		await expect(
			page.getByRole("button", { name: "Persona list", exact: true }),
		).toBeFocused();
	} finally {
		if (held && !completed) await held.abort("failed");
	}
});

test("native preview identity radio choices update the real session and retain missing saved identity", async ({
	page,
}) => {
	await page.goto(peer.origin);
	await expect(page.getByRole("button", { name: /^Running as/ })).toHaveCount(
		0,
	);
	await page
		.getByRole("button", { name: "Toggle Preview", exact: true })
		.click();
	await page.getByRole("button", { name: /^Running as/ }).click();
	const me = page.getByRole("menuitemradio", { name: /Preview as me/ });
	await expect(me).toBeChecked();
	await page
		.getByRole("menuitemradio", { name: "Preview as Asha", exact: true })
		.click();
	await expect(page.getByLabel("Selected persona")).toHaveText(
		"10000000-0000-4000-8000-000000007100",
	);
	await expect(
		page.getByRole("button", { name: /^Running as Asha/ }),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Peer removes persona", exact: true })
		.click();
	await page
		.getByRole("button", { name: /^Running as Selected persona unavailable/ })
		.click();
	await expect(
		page.getByRole("menuitemradio", { name: /Selected persona unavailable/ }),
	).toBeDisabled();
	await me.click();
	await expect(page.getByLabel("Selected persona")).toHaveText("me");
	await page
		.getByRole("button", { name: "Toggle Preview", exact: true })
		.click();
	await expect(page.getByRole("button", { name: /^Running as/ })).toHaveCount(
		0,
	);
});

test("native Builder shortcuts traverse current field identity and perform real duplicate, reorder, undo, and deletion", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=shortcuts`);
	const saved = page.getByLabel("Saved fields");
	const original = await saved.innerText();
	const modifier = await page.evaluate(() =>
		/Mac|iPod|iPhone|iPad/.test(navigator.userAgent) ? "Meta" : "Control",
	);
	const selected = page.getByLabel("Selected location");
	await page
		.getByRole("region", { name: "Shortcut canvas", exact: true })
		.click();
	await page.keyboard.press("Tab");
	await expect(selected).toContainText("10000000-0000-4000-8000-000000007102");
	await page.keyboard.press("Shift+Tab");
	await expect(selected).toContainText("10000000-0000-4000-8000-000000007101");
	await page.keyboard.press(`${modifier}+d`);
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).length)
		.toBe(4);
	const afterDuplicate = await saved.innerText();
	await page.keyboard.press(`${modifier}+z`);
	await expect(saved).toHaveText(original);
	await page.keyboard.press(`${modifier}+Shift+z`);
	await expect(saved).toHaveText(afterDuplicate);
	await page
		.getByRole("button", { name: "Select first field", exact: true })
		.click();
	await page.keyboard.press("ArrowDown");
	await expect
		.poll(async () => JSON.parse(await saved.innerText())[1].uuid)
		.toBe("10000000-0000-4000-8000-000000007101");
	await page.keyboard.press("Delete");
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).length)
		.toBe(3);
	await expect(saved).not.toContainText("10000000-0000-4000-8000-000000007101");
});

test("native Builder shortcuts leave input Tab alone, retain viewer navigation, and stop during access refresh", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=shortcuts`);
	const saved = page.getByLabel("Saved fields");
	const original = await saved.innerText();
	const modifier = await page.evaluate(() =>
		/Mac|iPod|iPhone|iPad/.test(navigator.userAgent) ? "Meta" : "Control",
	);
	const input = page.getByRole("textbox", { name: "Local input", exact: true });
	await input.fill("p");
	await expect(page.getByLabel("Preview active")).toHaveText("false");
	await input.press("Tab");
	await expect(
		page.getByRole("button", { name: "Native Tab target", exact: true }),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Viewer access", exact: true })
		.click();
	await page.keyboard.press("Delete");
	await page.keyboard.press(`${modifier}+d`);
	await page.keyboard.press("ArrowDown");
	await expect(saved).toHaveText(original);
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Selected location")).toContainText(
		"10000000-0000-4000-8000-000000007102",
	);
	await page.keyboard.press("p");
	await expect(page.getByLabel("Preview active")).toHaveText("true");
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("Preview active")).toHaveText("false");
	await page
		.getByRole("button", { name: "Refresh access", exact: true })
		.click();
	await page.keyboard.press("p");
	await page.keyboard.press("Delete");
	await expect(page.getByLabel("Preview active")).toHaveText("false");
	await expect(saved).toHaveText(original);
});
