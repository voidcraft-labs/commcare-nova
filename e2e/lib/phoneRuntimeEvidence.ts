import { writeFile } from "node:fs/promises";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";

/** Default admission is reads from the owning ephemeral peer. A spec may
 * intercept one exact loopback transport itself before this fallback, recording
 * its controlled boundary. Every other refusal fails the owning test. */
export async function refuseOutsidePhonePeer(
	context: BrowserContext,
	origin: string,
) {
	if (new URL(origin).hostname !== "127.0.0.1")
		throw new Error("Phone runtime evidence requires a loopback peer");
	const refused: string[] = [];
	await context.route("**/*", async (route) => {
		const request = route.request();
		if (
			new URL(request.url()).origin !== origin ||
			!["GET", "HEAD"].includes(request.method())
		) {
			refused.push(`${request.method()} ${request.url()}`);
			await route.abort("blockedbyclient");
			return;
		}
		await route.continue();
	});
	await context.routeWebSocket("**/*", async (route) => {
		refused.push(`WEBSOCKET ${route.url()}`);
		await route.close();
	});
	return refused;
}

/** Capture before contract assertions so the first failure remains reviewable.
 * ARIA is a browser tree observation, not a physical screen-reader result. */
export async function capturePhoneRuntime(
	page: Page,
	testInfo: TestInfo,
	name: string,
	observation: unknown,
) {
	const ariaPath = testInfo.outputPath(`${name}.aria.txt`);
	const jsonPath = testInfo.outputPath(`${name}.json`);
	const imagePath = testInfo.outputPath(`${name}.png`);
	await writeFile(ariaPath, await page.locator("body").ariaSnapshot());
	await writeFile(jsonPath, `${JSON.stringify(observation, null, 2)}\n`);
	await page.screenshot({
		path: imagePath,
		fullPage: true,
		animations: "disabled",
	});
	for (const [path, contentType] of [
		[ariaPath, "text/plain"],
		[jsonPath, "application/json"],
		[imagePath, "image/png"],
	] as const)
		await testInfo.attach(`${name}-${contentType}`, { path, contentType });
}

export async function selectWorkerLanguage(
	page: Page,
	label: "English" | "Español",
) {
	await page.getByRole("button", { name: /^Worker language:/ }).click();
	await page.getByRole("menuitemradio", { name: label, exact: true }).click();
	await page.getByRole("menu").waitFor({ state: "hidden" });
}
