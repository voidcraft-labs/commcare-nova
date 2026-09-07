import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { test as base, expect } from "../lib/fixtures";

let component: Awaited<ReturnType<typeof componentPeer>>;

/** Actual resource/mutation hooks call this controlled HTTP transport peer.
 * Held routes stay owned until fulfillment/abort, including assertion failures. */
class CaseDataPeer {
	count = 0;
	countError = false;
	requests: { method: string; args: unknown[] }[] = [];
	private writes: Route[] = [];
	private owned = new Set<Route>();
	constructor(private page: Page) {}
	async install() {
		await this.page.route("**/native/case-data/*", async (route) => {
			const method = new URL(route.request().url()).pathname.split("/").at(-1);
			if (!method) throw new Error("Missing action method");
			const args: unknown[] = route.request().postDataJSON();
			this.requests.push({ method, args });
			if (method === "loadCaseCountAction") {
				await route.fulfill({
					json: this.countError
						? {
								kind: "error",
								message: "password authentication failed for database nova",
							}
						: { kind: "count", count: this.count },
				});
			} else if (method === "loadParkedValuesAction") {
				await route.fulfill({ json: { kind: "entries", entries: [] } });
			} else if (
				method === "populateSampleCasesAction" ||
				method === "resetSampleCasesAction"
			) {
				this.owned.add(route);
				this.writes.push(route);
			} else {
				await route.fulfill({
					status: 500,
					body: `Unexpected action ${method}`,
				});
			}
		});
	}
	async nextWrite() {
		await expect.poll(() => this.writes.length).toBeGreaterThan(0);
		const route = this.writes.shift();
		if (!route) throw new Error("No pending write");
		return route;
	}
	async finish(route: Route, result: unknown) {
		try {
			await route.fulfill({ json: result });
		} finally {
			this.owned.delete(route);
		}
	}
	async close() {
		await Promise.allSettled([...this.owned].map((route) => route.abort()));
		this.owned.clear();
		await this.page.unrouteAll({ behavior: "wait" });
	}
}
const test = base.extend<{ data: CaseDataPeer }>({
	data: async ({ page }, use) => {
		const data = new CaseDataPeer(page);
		await data.install();
		try {
			await use(data);
		} finally {
			await data.close();
		}
	},
});
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	component = await componentPeer("e2e/lib/builder-data-client.tsx", [], {
		"@/lib/preview/engine/caseDataBinding": resolve(
			"e2e/lib/builder-data-boundary.ts",
		),
		"@/lib/preview/engine/casePropertyRenamePreflight": resolve(
			"e2e/lib/builder-data-boundary.ts",
		),
	});
});
test.afterAll(async () => {
	await component?.close();
});
async function openData(page: Page) {
	const trigger = page.getByRole("button", { name: /^Case data for Patient/ });
	await trigger.click();
	await expect(
		page.getByRole("heading", { name: "Case data", exact: true }),
	).toBeFocused();
	return trigger;
}

test("native sample creation holds its scope and focus until the result, then retries through the real hook", async ({
	page,
	data,
}) => {
	await page.goto(component.origin);
	const trigger = await openData(page);
	await page
		.getByRole("button", { name: "Add sample cases", exact: true })
		.click();
	const write = await data.nextWrite();
	expect(write.request().postDataJSON()).toMatchObject([
		"native-case-data",
		{ name: "patient" },
		null,
	]);
	const title = page.getByRole("heading", { name: "Case data", exact: true });
	await expect(title).toBeFocused();
	await expect(
		page.getByRole("status").filter({ hasText: "Adding sample cases…" }),
	).toBeAttached();
	await expect(
		page.getByRole("combobox", { name: "Case type", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Manage case properties" }),
	).toBeDisabled();
	await page.keyboard.press("Tab");
	await expect(title).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(title).toBeFocused();
	await page.mouse.click(10, 10);
	await expect(title).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(title).toBeFocused();
	await data.finish(write, {
		kind: "error",
		message: "database internal_constraint_42",
	});
	await expect(page.getByRole("alert")).toHaveText(
		"Nova couldn't add sample cases. Try again.",
	);
	await expect(page.getByText(/internal_constraint_42/)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Case data" })).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await openData(page);
	await page
		.getByRole("button", { name: "Add sample cases", exact: true })
		.click();
	const retry = await data.nextWrite();
	data.count = 1;
	await data.finish(retry, { kind: "ok", inserted: 1 });
	await expect(
		page.getByText("Sample cases created", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("1 case is ready to use in Preview", { exact: true }),
	).toBeVisible();
	await expect(trigger).toHaveAccessibleName(/1 case\./);
	expect(
		data.requests.filter((x) => x.method === "loadCaseCountAction").length,
	).toBeGreaterThan(1);
});

test("native replacement requires confirmation and keeps progress focused until failure or success", async ({
	page,
	data,
}) => {
	data.count = 7;
	await page.goto(component.origin);
	const trigger = await openData(page);
	await page
		.getByRole("button", { name: "Replace case data", exact: true })
		.click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText(
		"All “Patient” cases will be replaced throughout the app",
	);
	await expect(dialog).toContainText(
		"Linked cases will stay, but they'll lose their links",
	);
	await expect(dialog).toContainText("You can't undo this.");
	await expect(
		dialog.getByRole("button", { name: "Cancel", exact: true }),
	).toBeFocused();
	expect(
		data.requests.filter((x) => x.method === "resetSampleCasesAction"),
	).toHaveLength(0);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await openData(page);
	await page
		.getByRole("button", { name: "Replace case data", exact: true })
		.click();
	await dialog.getByRole("button", { name: "Replace", exact: true }).click();
	const write = await data.nextWrite();
	expect(write.request().postDataJSON()).toMatchObject([
		"native-case-data",
		{ name: "patient" },
		null,
	]);
	const title = dialog.getByRole("heading", { name: "Replace all 7 cases?" });
	await expect(title).toBeFocused();
	await expect(dialog).toHaveAttribute("aria-busy", "true");
	await page.keyboard.press("Tab");
	await expect(title).toBeFocused();
	await page.mouse.click(10, 10);
	await page.keyboard.press("Escape");
	await expect(title).toBeFocused();
	await data.finish(write, {
		kind: "error",
		message: "database internal_constraint_42",
	});
	await expect(dialog.getByRole("alert")).toHaveText(
		"Your current cases weren't changed. Nova couldn't replace the case data. Try again.",
	);
	await expect(page.getByText(/internal_constraint_42/)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await openData(page);
	await page
		.getByRole("button", { name: "Replace case data", exact: true })
		.click();
	await dialog.getByRole("button", { name: "Replace", exact: true }).click();
	const retry = await data.nextWrite();
	data.count = 30;
	await data.finish(retry, { kind: "ok", inserted: 30 });
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAccessibleName(/30 cases/);
	await expect(
		page.getByText("30 cases are ready to use in Preview", { exact: true }),
	).toBeVisible();
});

test("native count errors retry without server diagnostics and viewers cannot write", async ({
	page,
	data,
}) => {
	data.countError = true;
	await page.goto(component.origin);
	const trigger = await openData(page);
	await expect(trigger).toHaveAccessibleName(/Case count unavailable/);
	await expect(page.getByRole("alert")).toContainText("Case data didn't load");
	await expect(page.getByText(/password authentication/)).toHaveCount(0);
	data.countError = false;
	data.count = 7;
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(trigger).toHaveAccessibleName(/7 cases/);
	await expect(
		page.getByRole("heading", { name: "Case data", exact: true }),
	).toBeFocused();
	await page.goto(`${component.origin}?scenario=viewer`);
	await openData(page);
	await expect(
		page.getByText("You can view case data, but you can't add or replace it", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Replace case data", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Add sample cases", exact: true }),
	).toHaveCount(0);
	expect(
		data.requests.filter((x) => /SampleCasesAction$/.test(x.method)),
	).toHaveLength(0);
});

test("native access refresh masks pending case-data work and drops its later notification", async ({
	page,
	data,
}) => {
	await page.goto(component.origin);
	await openData(page);
	await page
		.getByRole("button", { name: "Add sample cases", exact: true })
		.click();
	const write = await data.nextWrite();
	await page.evaluate(() =>
		window.dispatchEvent(new Event("native-refresh-access")),
	);
	await expect(page.getByRole("dialog", { name: "Case data" })).toHaveCount(0);
	await data.finish(write, { kind: "ok", inserted: 12 });
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await expect(
		page.getByText("Sample cases created", { exact: true }),
	).toHaveCount(0);
});
