import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";

async function committedFrame(page: Page) {
	await page.evaluate(async () => {
		await window.previewGeopointAudit.settle();
		await new Promise<void>((done) =>
			requestAnimationFrame(() => requestAnimationFrame(() => done())),
		);
	});
}

const geopoint = test.extend<{
	google: {
		hold(path: string): void;
		release(path: string): void;
		requested(path: string): number;
	};
}>({
	google: async ({ page }, use) => {
		const peer = await componentPeer(
			"e2e/lib/preview-geopoint-client.tsx",
			[],
			{
				"@googlemaps/js-api-loader": resolve(
					"e2e/lib/preview-geopoint-google-peer.ts",
				),
			},
			{
				"process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY":
					'"synthetic-public-browser-key"',
				"process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID": '"synthetic-map"',
			},
		);
		const held = new Map<
			string,
			ReturnType<typeof Promise.withResolvers<void>>
		>();
		const requests = new Map<string, number>();
		await page.route(`${peer.origin}/geopoint-peer/**`, async (route) => {
			const url = new URL(route.request().url());
			const path = `${url.pathname.split("/").at(-1)}${url.search}`;
			requests.set(path, (requests.get(path) ?? 0) + 1);
			await held.get(path)?.promise;
			const query = url.searchParams.get("query") ?? "";
			const place = url.searchParams.get("place");
			const json = url.pathname.endsWith("suggestions")
				? [{ id: query, label: `${query} address` }]
				: url.pathname.endsWith("details")
					? {
							lat: place === "Fresh" ? 41 : 40,
							lng: place === "Fresh" ? -75 : -74,
							label: `${place} address`,
						}
					: [
							{
								formatted_address: `Coordinates ${url.searchParams.get("lat")}`,
							},
						];
			await route.fulfill({ json });
		});
		try {
			await page.goto(peer.origin);
			await expect(page.getByRole("combobox")).toBeVisible();
			await use({
				hold(path) {
					held.set(path, Promise.withResolvers<void>());
				},
				release(path) {
					held.get(path)?.resolve();
					held.delete(path);
				},
				requested(path) {
					return requests.get(path) ?? 0;
				},
			});
		} finally {
			for (const gate of held.values()) gate.resolve();
			try {
				await page.evaluate(async () => {
					window.nativeGeolocationDelivery?.release();
					await window.previewGeopointAudit?.dispose();
				});
			} finally {
				try {
					await page.unrouteAll({ behavior: "wait" });
					await page.close();
				} finally {
					await peer.close();
				}
			}
		}
	},
});

geopoint(
	"native location ignores an old delivery after refresh and accepts a fresh browser location",
	async ({ page, context, google }) => {
		// The barrier holds a position Chromium actually produced; it does not
		// fabricate coordinates or replace Nova's requestGeolocation adapter.
		await context.grantPermissions(["geolocation"]);
		await context.setGeolocation({ latitude: 40, longitude: -74, accuracy: 4 });
		await page.evaluate(() => {
			const native = navigator.geolocation.getCurrentPosition.bind(
				navigator.geolocation,
			);
			const held: Array<() => void> = [];
			let first = true;
			navigator.geolocation.getCurrentPosition = (success, error, options) => {
				const hold = first;
				first = false;
				native(
					(position) => {
						if (hold) held.push(() => success(position));
						else success(position);
					},
					error,
					options,
				);
			};
			window.nativeGeolocationDelivery = {
				held: () => held.length,
				release() {
					for (const deliver of held.splice(0)) deliver();
				},
			};
		});
		await page
			.getByRole("button", { name: "My location", exact: true })
			.click();
		await expect
			.poll(() => page.evaluate(() => window.nativeGeolocationDelivery.held()))
			.toBe(1);
		await expect(
			page.getByRole("button", { name: "Locating", exact: true }),
		).toBeDisabled();
		await page.evaluate(() => window.previewGeopointAudit.refresh());
		await expect(
			page.getByRole("button", { name: "My location", exact: true }),
		).toBeEnabled();
		await page.evaluate(() => window.previewGeopointAudit.authorize());
		await committedFrame(page);
		// Deliver before any new request: a newer request counter must not be
		// what hides a missing reset fence.
		await page.evaluate(() => window.nativeGeolocationDelivery.release());
		await committedFrame(page);
		expect(
			await page.evaluate(() => window.previewGeopointAudit.answer()),
		).toBe("");
		await context.setGeolocation({ latitude: 41, longitude: -75, accuracy: 3 });
		await page
			.getByRole("button", { name: "My location", exact: true })
			.click();
		await expect
			.poll(() => page.evaluate(() => window.previewGeopointAudit.answer()))
			.toBe("41 -75 0 3");
		await committedFrame(page);
		expect(
			await page.evaluate(() => window.previewGeopointAudit.toasts()),
		).toEqual([]);
		await expect.poll(() => google.requested("reverse?lat=41")).toBe(1);
		await expect(page.getByRole("combobox")).toHaveValue("Coordinates 41");
	},
);

geopoint(
	"native Places popup retains RTL, drops a cleared query response, and clears results during refresh",
	async ({ page, google }) => {
		google.hold("suggestions?query=Old");
		const input = page.getByRole("combobox");
		await input.fill("Old");
		await expect.poll(() => google.requested("suggestions?query=Old")).toBe(1);
		await input.fill("");
		google.release("suggestions?query=Old");
		await committedFrame(page);
		await input.press("ArrowDown");
		await expect(page.getByRole("option", { name: "Old address" })).toHaveCount(
			0,
		);
		await expect(input).toHaveValue("");
		await input.fill("Source");
		const source = page.getByRole("option", { name: "Source address" });
		await expect(source).toBeVisible();
		expect(
			await source.evaluate((node) => ({
				dir: getComputedStyle(node).direction,
				portaled: !document.getElementById("root")?.contains(node),
			})),
		).toEqual({ dir: "rtl", portaled: true });
		await page.evaluate(() => window.previewGeopointAudit.refresh());
		await expect(source).toHaveCount(0);
		await page.evaluate(() => window.previewGeopointAudit.authorize());
		await committedFrame(page);
		await input.fill("Fresh");
		await expect(
			page.getByRole("option", { name: "Fresh address" }),
		).toBeVisible();
		await input.press("ArrowDown");
		await input.press("Enter");
		await expect
			.poll(() => page.evaluate(() => window.previewGeopointAudit.answer()))
			.toBe("41 -75 0 0");
	},
);

geopoint(
	"held Places details cannot revive after reset or write after owner unmount",
	async ({ page, google }) => {
		google.hold("details?place=Old");
		const input = page.getByRole("combobox");
		await input.fill("Old");
		await page.getByRole("option", { name: "Old address" }).click();
		await expect.poll(() => google.requested("details?place=Old")).toBe(1);
		await page.evaluate(() => window.previewGeopointAudit.refresh());
		await committedFrameWithoutPeer(page);
		await page.evaluate(() => window.previewGeopointAudit.authorize());
		await committedFrameWithoutPeer(page);
		// Complete the stale detail before starting a newer detail request, so
		// this observes the reset generation fence itself.
		google.release("details?place=Old");
		await committedFrame(page);
		expect(
			await page.evaluate(() => window.previewGeopointAudit.answer()),
		).toBe("");
		await input.fill("Fresh");
		await page.getByRole("option", { name: "Fresh address" }).click();
		await expect
			.poll(() => page.evaluate(() => window.previewGeopointAudit.answer()))
			.toBe("41 -75 0 0");
		await committedFrame(page);
		await expect(input).toHaveValue("Fresh address");
		google.hold("details?place=Unmounted");
		await input.fill("Unmounted");
		await page.getByRole("option", { name: "Unmounted address" }).click();
		await expect
			.poll(() => google.requested("details?place=Unmounted"))
			.toBe(1);
		await page.evaluate(() => window.previewGeopointAudit.unmount());
		google.release("details?place=Unmounted");
		await committedFrame(page);
		expect(
			await page.evaluate(() => window.previewGeopointAudit.answer()),
		).toBe("41 -75 0 0");
	},
);

async function committedFrameWithoutPeer(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((done) =>
				requestAnimationFrame(() => requestAnimationFrame(() => done())),
			),
	);
}
