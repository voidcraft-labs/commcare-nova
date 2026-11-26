import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

test("a saved menu badge follows the worker's platform in Preview", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, caseWorkspace.routes.tileModule);
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const label = page.getByRole("textbox", { name: "Badge text" });
	await label.fill("1234");
	const saved = page.waitForResponse((response) => {
		const request = response.request();
		return (
			request.method() === "PUT" &&
			new URL(response.url()).pathname === `/api/apps/${caseWorkspace.appId}` &&
			(request.postData() ?? "").includes('"text":"1234"')
		);
	});
	await label.press("Enter");
	expect((await saved).ok()).toBe(true);

	await openBuilder(page, `/build/${caseWorkspace.appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const main = page.locator("main");
	const module = main.getByRole("button", { name: /^Patient tile/ });
	await expect(module.getByText("1234", { exact: true })).toBeVisible({
		timeout: 20_000,
	});
	const identity = page.getByRole("button", { name: /^Running as / });
	await identity.click();
	await page.getByRole("menuitemradio", { name: /^Android/ }).click();
	await expect(identity).toHaveAccessibleName(/ on Android\. /);
	await main.getByRole("button", { name: "Start", exact: true }).click();
	await expect(module.getByText("999+", { exact: true })).toBeVisible();
});
