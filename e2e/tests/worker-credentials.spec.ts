import { globSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { expect, test } from "../lib/fixtures";

test("credential panels copy every uncertain candidate, preserve them on remount and dismiss only the selected row", async ({
	page,
	context,
}) => {
	const bundle = await build({
		entryPoints: ["e2e/lib/worker-credentials-client.tsx"],
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	// Use the normal production CSS and font assets, not test-authored dimensions.
	const files = globSync([".next/static/chunks/*.css", ".next/static/media/*"]);
	const assets = new Map(
		files.map((file) => [
			file.slice(".next/static".length),
			readFileSync(file),
		]),
	);
	const css = files.filter((file) => file.endsWith(".css"));
	expect(css.length).toBeGreaterThan(0);
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path === "/client.js") {
			response.setHeader("content-type", "text/javascript");
			response.end(bundle.outputFiles[0].text);
			return;
		}
		const asset = assets.get(path);
		if (asset) {
			response.setHeader(
				"content-type",
				path.endsWith(".css") ? "text/css" : "font/woff2",
			);
			response.end(asset);
			return;
		}
		if (path === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		response.setHeader("content-type", "text/html");
		response.end(
			`<!doctype html><html class="dark"><head><title>Worker credentials</title>${css.map((file) => `<link rel="stylesheet" href="${file.slice(".next/static".length)}">`).join("")}</head><body><main id="root" style="max-width:560px;margin:24px auto;padding:16px"></main><script type="module" src="/client.js"></script></body></html>`,
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing peer port");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin,
		});
		await page.goto(origin);
		const us = page.getByRole("region", { name: "US", exact: true }),
			india = page.getByRole("region", { name: "India", exact: true });
		await expect(us).toContainText("us-first");
		await expect(us).not.toContainText("india-only");
		await expect(india).not.toContainText("us-first");
		await us.getByRole("button", { name: "Copy all", exact: true }).click();
		await expect(
			us.getByRole("button", { name: "Copied", exact: true }),
		).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			"amina@clinic.commcarehq.org\tus-first\tAccount unconfirmed",
		);
		await page.getByRole("button", { name: "Add uncertain US retry" }).click();
		await expect(
			us.getByRole("button", { name: "Copy all", exact: true }),
		).toBeVisible();
		await expect(us.getByRole("listitem")).toHaveCount(2);
		await us.getByRole("button", { name: "Copy all", exact: true }).click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			"amina@clinic.commcarehq.org\tus-first\tAccount unconfirmed\namina@clinic.commcarehq.org\tus-second\tAccount unconfirmed",
		);
		await page.getByRole("button", { name: "Hide panels" }).click();
		await expect(us).not.toBeVisible();
		await page.getByRole("button", { name: "Show panels" }).click();
		await expect(us.getByRole("listitem")).toHaveCount(2);
		const dismiss = us
			.getByRole("listitem")
			.filter({ hasText: "us-first" })
			.getByRole("button", { name: "I have this" });
		expect((await dismiss.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		await dismiss.click();
		await expect(us).not.toContainText("us-first");
		await expect(us).toContainText("us-second");
		await expect(india).toContainText("india-only");
		await page.screenshot({
			path: "e2e/test-results/worker-credentials.png",
			fullPage: true,
		});
	} finally {
		await page.goto("about:blank");
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
