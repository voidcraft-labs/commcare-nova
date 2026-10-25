import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import {
	capturePhoneRuntime,
	refuseOutsidePhonePeer,
	selectWorkerLanguage,
} from "../../lib/phoneRuntimeEvidence";
import type {} from "../../lib/preview-geopoint-client";
import { removableRoutes } from "../../lib/routes";

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

/* Web Apps' location question is the map and address search; Android's is
 * Record location, which reads the browser's position (`?android`). */
const gps = test.extend<{
	runsOn: "web-apps" | "android";
	google: {
		hold(path: string): void;
		release(path: string): void;
		requested(path: string): number;
	};
}>({
	runsOn: ["web-apps", { option: true }],
	google: [
		async ({ page, context, runsOn }, use, testInfo) => {
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
			const peerRoutes = removableRoutes(page);
			try {
				const guard = await attachErrorGuard(page, peer.origin);
				const refused = await refuseOutsidePhonePeer(context, peer.origin);
				try {
					await peerRoutes.route(
						`${peer.origin}/geopoint-peer/**`,
						async (route) => {
							if (route.request().method() !== "GET") {
								refused.push(
									`${route.request().method()} ${route.request().url()}`,
								);
								await route.abort("blockedbyclient");
								return;
							}
							const url = new URL(route.request().url());
							const path = `${url.pathname.split("/").at(-1)}${url.search}`;
							requests.set(path, (requests.get(path) ?? 0) + 1);
							await held.get(path)?.promise;
							if (url.pathname.endsWith("suggestions"))
								await route.fulfill({ json: [] });
							else if (url.pathname.endsWith("reverse"))
								await route.fulfill({
									json: [
										{
											formatted_address: `Coordinates ${url.searchParams.get("lat")}`,
										},
									],
								});
							else {
								refused.push(`Unexpected controlled Places request: ${path}`);
								await route.abort("blockedbyclient");
							}
						},
					);
					await page.setViewportSize({ width: 390, height: 720 });
					if (runsOn === "android") {
						await page.goto(`${peer.origin}/?language-audit=1&android=1`);
						await expect(
							page.getByRole("button", {
								name: "Record location",
								exact: true,
							}),
						).toBeVisible();
					} else {
						await page.goto(`${peer.origin}/?language-audit=1`);
						await expect(page.getByRole("combobox")).toBeVisible();
					}
					try {
						await use({
							hold(path) {
								if (held.has(path))
									throw new Error("Places response is already held");
								held.set(path, Promise.withResolvers<void>());
							},
							release(path) {
								held.get(path)?.resolve();
								held.delete(path);
							},
							requested: (path) => requests.get(path) ?? 0,
						});
					} catch (error) {
						if (!page.isClosed())
							await capturePhoneRuntime(page, testInfo, "failure", {
								observation: await page.evaluate(() =>
									window.previewGeopointAudit?.observation(),
								),
								requests: [...requests],
								refused,
							});
						throw error;
					}
				} finally {
					for (const gate of held.values()) gate.resolve();
					try {
						if (!page.isClosed())
							await page.evaluate(async () => {
								window.phoneGeolocation?.release();
								window.phoneGeolocation?.restore();
								await window.previewGeopointAudit?.dispose();
							});
					} finally {
						try {
							await peerRoutes.removeAll();
							await closePageWithUnload(page);
						} finally {
							await guard.assertNoErrors();
							expect(refused).toEqual([]);
						}
					}
				}
			} finally {
				await peer.close();
			}
		},
		{ auto: true },
	],
});

/** Android's Record location button, in either language and either state. */
function recordButton(page: Page) {
	return page.getByRole("button", {
		name: /^(Record location|Replace location|Registrar ubicación|Reemplazar ubicación)$/,
	});
}

for (const width of [320, 390]) {
	gps(
		`configured location owned copy follows Spanish at ${width}px`,
		async ({ page, google }, testInfo) => {
			await page.setViewportSize({ width, height: 720 });
			const before = await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			);
			await selectWorkerLanguage(page, "Español");
			const input = page.getByRole("combobox");
			await expect(
				page.getByRole("button", { name: "Worker language: Spanish" }),
			).toBeVisible();
			await capturePhoneRuntime(
				page,
				testInfo,
				"spanish-initial",
				await page.evaluate(() => window.previewGeopointAudit.observation()),
			);
			expect.soft(await input.ariaSnapshot()).toMatch(/combobox .*dirección/i);
			expect
				.soft(await input.getAttribute("placeholder"))
				.toMatch(/dirección.*lugar/i);
			// Web Apps offers no way to use the browser's location.
			expect.soft(await recordButton(page).count()).toBe(0);
			expect
				.soft(await page.locator("body").innerText())
				.toMatch(/buscar.*dirección.*mapa/i);

			await input.click();
			await input.fill("ab");
			await input.press("ArrowDown");
			await expect(
				page.getByText(/Type at least 3 characters|3 caracteres/i),
			).toBeVisible();
			await capturePhoneRuntime(
				page,
				testInfo,
				"spanish-short-query",
				await page.evaluate(() => window.previewGeopointAudit.observation()),
			);
			expect
				.soft(await page.locator("body").innerText())
				.toMatch(/3 caracteres/i);
			expect(google.requested("suggestions?query=ab")).toBe(0);

			google.hold("suggestions?query=Nothing");
			await input.fill("Nothing");
			await expect
				.poll(() => google.requested("suggestions?query=Nothing"))
				.toBe(1);
			await capturePhoneRuntime(
				page,
				testInfo,
				"spanish-searching",
				await page.evaluate(() => window.previewGeopointAudit.observation()),
			);
			expect.soft(await page.locator("body").innerText()).toMatch(/Buscando/);
			google.release("suggestions?query=Nothing");
			await expect(
				page.getByText(/No matching places|No.*lugares/),
			).toBeVisible();
			await capturePhoneRuntime(
				page,
				testInfo,
				"spanish-no-results",
				await page.evaluate(() => window.previewGeopointAudit.observation()),
			);
			expect
				.soft(await page.locator("body").innerText())
				.toMatch(/No.*lugares/);
			const after = await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			);
			expect(after.entryKey).toBe(before.entryKey);
			expect(after.answer).toBe(before.answer);
			expect(after.document).toBe(before.document);
		},
	);
}

gps.describe("on Android", () => {
	gps.use({ runsOn: "android" });

	gps(
		"held Chromium location localizes Record location's wait and preserves exact coordinates",
		async ({ page, context }, testInfo) => {
			await context.grantPermissions(["geolocation"]);
			await context.setGeolocation({
				latitude: 41,
				longitude: -75,
				accuracy: 3,
			});
			await page.evaluate(() => {
				const api = navigator.geolocation;
				const original = api.watchPosition;
				const held: Array<() => void> = [];
				const optionsSeen: PositionOptions[] = [];
				api.watchPosition = (success, error, options) => {
					optionsSeen.push(options ?? {});
					return original.call(
						api,
						(position) => held.push(() => success(position)),
						error,
						options,
					);
				};
				window.phoneGeolocation = {
					pending: () => held.length,
					options: () => optionsSeen,
					release() {
						for (const deliver of held.splice(0)) deliver();
					},
					restore() {
						api.watchPosition = original;
					},
				};
			});
			// The dialog is modal, so the language is chosen before it opens.
			await selectWorkerLanguage(page, "Español");
			await expect(recordButton(page)).toHaveText("Registrar ubicación");
			await recordButton(page).click();
			await expect
				.poll(() => page.evaluate(() => window.phoneGeolocation?.pending()))
				.toBe(1);
			const dialog = page.getByRole("dialog", { name: "Buscando ubicación" });
			await expect(dialog).toBeVisible();
			await expect(
				dialog.getByRole("button", { name: "Cancelar", exact: true }),
			).toBeVisible();
			await capturePhoneRuntime(page, testInfo, "spanish-finding-native-held", {
				observation: await page.evaluate(() =>
					window.previewGeopointAudit.observation(),
				),
				options: await page.evaluate(() => window.phoneGeolocation?.options()),
			});
			expect(
				await page.evaluate(() => window.phoneGeolocation?.options()),
			).toEqual([{ enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }]);
			await page.evaluate(() => window.phoneGeolocation?.release());
			// A fix of 5 metres or better is taken at once.
			await expect
				.poll(() => page.evaluate(() => window.previewGeopointAudit.answer()))
				.toBe("41.0 -75.0 0.0 3.0");
			await expect(dialog).toHaveCount(0);
			await expect(recordButton(page)).toHaveText("Reemplazar ubicación");
			await expect(page.getByText(/Latitud: N 41°0'0"/)).toBeVisible();
			await expect(page.getByText(/Precisión: 3m/)).toBeVisible();
			await capturePhoneRuntime(
				page,
				testInfo,
				"spanish-native-value",
				await page.evaluate(() => window.previewGeopointAudit.observation()),
			);
			expect(
				await page.evaluate(() => window.previewGeopointAudit.toasts()),
			).toEqual([]);
		},
	);

	gps(
		"a browser that refuses its location keeps Record location's dialog open and writes nothing",
		async ({ page }, testInfo) => {
			await selectWorkerLanguage(page, "Español");
			const before = await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			);
			// Only the browser API failure is controlled; Nova's production
			// watchGeolocation adapter still classifies it.
			await page.evaluate(() => {
				const api = navigator.geolocation;
				const original = api.watchPosition;
				api.watchPosition = (_success, error) => {
					if (!error)
						throw new Error(
							"The production adapter must own an error callback",
						);
					queueMicrotask(() =>
						error({
							code: 1,
							message: "Controlled browser API failure",
							PERMISSION_DENIED: 1,
							POSITION_UNAVAILABLE: 2,
							TIMEOUT: 3,
						}),
					);
					return 7;
				};
				window.phoneGeolocation = {
					pending: () => 0,
					options: () => [],
					release() {},
					restore() {
						api.watchPosition = original;
					},
				};
			});
			await recordButton(page).click();
			const dialog = page.getByRole("dialog", { name: "Buscando ubicación" });
			await expect(
				dialog.getByText("Your browser isn't sharing its location", {
					exact: true,
				}),
			).toBeVisible();
			await capturePhoneRuntime(
				page,
				testInfo,
				"spanish-refused",
				await page.evaluate(() => window.previewGeopointAudit.observation()),
			);
			// Cancel closes it with Android's toast, in the worker's language.
			await dialog
				.getByRole("button", { name: "Cancelar", exact: true })
				.click();
			await expect(dialog).toHaveCount(0);
			await expect
				.poll(() => page.evaluate(() => window.previewGeopointAudit.toasts()))
				.toEqual(["Captura de ubicación cancelada"]);
			const after = await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			);
			expect(after.answer).toBe(before.answer);
			expect(after.document).toBe(before.document);
		},
	);
});

declare global {
	interface Window {
		phoneGeolocation?: {
			pending(): number;
			options(): PositionOptions[];
			release(): void;
			restore(): void;
		};
	}
}
