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

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

const gps = test.extend<{
	google: {
		hold(path: string): void;
		release(path: string): void;
		requested(path: string): number;
	};
}>({
	google: [
		async ({ page, context }, use, testInfo) => {
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
			try {
				const guard = await attachErrorGuard(page, peer.origin);
				const refused = await refuseOutsidePhonePeer(context, peer.origin);
				try {
					await page.route(`${peer.origin}/geopoint-peer/**`, async (route) => {
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
					});
					await page.setViewportSize({ width: 390, height: 720 });
					await page.goto(`${peer.origin}/?language-audit=1`);
					await expect(page.getByRole("combobox")).toBeVisible();
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
							await page.unrouteAll({ behavior: "wait" });
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

function locateButton(page: Page) {
	return page.getByRole("button", {
		name: /^(My location|Your location|Locating|Tu ubicación|Buscando ubicación)$/,
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
			expect
				.soft((await locateButton(page).textContent())?.trim())
				.toBe("Tu ubicación");
			expect
				.soft(await page.locator("body").innerText())
				.toMatch(/buscar.*dirección.*mapa.*ubicación/i);

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

gps(
	"held Chromium location localizes the wait and preserves exact coordinates",
	async ({ page, context, google }, testInfo) => {
		await context.grantPermissions(["geolocation"]);
		await context.setGeolocation({ latitude: 41, longitude: -75, accuracy: 3 });
		await page.evaluate(() => {
			const api = navigator.geolocation;
			const original = api.getCurrentPosition;
			const held: Array<() => void> = [];
			const optionsSeen: PositionOptions[] = [];
			api.getCurrentPosition = (success, error, options) => {
				optionsSeen.push(options ?? {});
				original.call(
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
					api.getCurrentPosition = original;
				},
			};
		});
		await locateButton(page).click();
		await expect
			.poll(() => page.evaluate(() => window.phoneGeolocation?.pending()))
			.toBe(1);
		await selectWorkerLanguage(page, "Español");
		await capturePhoneRuntime(page, testInfo, "spanish-locating-native-held", {
			observation: await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			),
			options: await page.evaluate(() => window.phoneGeolocation?.options()),
		});
		expect
			.soft((await locateButton(page).textContent())?.trim())
			.toBe("Buscando ubicación");
		await expect(locateButton(page)).toBeDisabled();
		expect(
			await page.evaluate(() => window.phoneGeolocation?.options()),
		).toEqual([{ enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }]);
		await page.evaluate(() => window.phoneGeolocation?.release());
		await expect
			.poll(() => page.evaluate(() => window.previewGeopointAudit.answer()))
			.toBe("41 -75 0 3");
		await expect.poll(() => google.requested("reverse?lat=41")).toBe(1);
		await expect(page.getByRole("combobox")).toHaveValue("Coordinates 41");
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

async function controlLocationFailure(
	page: Page,
	code: 1 | 2 | 3 | "unsupported" | "unexpected",
) {
	await page.evaluate((code) => {
		window.phoneGeolocation?.restore();
		const ownDescriptor = Object.getOwnPropertyDescriptor(
			navigator,
			"geolocation",
		);
		const api = navigator.geolocation;
		const original = api.getCurrentPosition;
		const held: Array<() => void> = [];
		const optionsSeen: PositionOptions[] = [];
		if (code === "unsupported")
			Object.defineProperty(navigator, "geolocation", {
				configurable: true,
				value: undefined,
			});
		else if (code === "unexpected")
			api.getCurrentPosition = () => {
				throw new Error("Controlled browser API exception");
			};
		else
			api.getCurrentPosition = (_success, error, options) => {
				if (!error)
					throw new Error("The production adapter must own an error callback");
				optionsSeen.push(options ?? {});
				held.push(() =>
					error({
						code,
						message: "Controlled browser API failure",
						PERMISSION_DENIED: 1,
						POSITION_UNAVAILABLE: 2,
						TIMEOUT: 3,
					}),
				);
			};
		window.phoneGeolocation = {
			pending: () => held.length,
			options: () => optionsSeen,
			release() {
				for (const deliver of held.splice(0)) deliver();
			},
			restore() {
				api.getCurrentPosition = original;
				if (ownDescriptor)
					Object.defineProperty(navigator, "geolocation", ownDescriptor);
				else Reflect.deleteProperty(navigator, "geolocation");
			},
		};
	}, code);
}

gps(
	"controlled browser location failures present Spanish reasons without an answer write",
	async ({ page }, testInfo) => {
		await selectWorkerLanguage(page, "Español");
		const before = await page.evaluate(() =>
			window.previewGeopointAudit.observation(),
		);
		for (const [code, reason] of [
			[1, /permiso/i],
			[2, /ubicación.*disponible/i],
			[3, /tiempo|tardó/i],
			["unsupported", /navegador.*ubicación/i],
			["unexpected", /obtener.*ubicación/i],
		] as const) {
			// Only the browser API failure boundary is controlled. Nova's production
			// requestGeolocation adapter still classifies and presents the reason.
			await controlLocationFailure(page, code);
			await locateButton(page).click();
			if (code !== "unsupported" && code !== "unexpected") {
				await expect
					.poll(() => page.evaluate(() => window.phoneGeolocation?.pending()))
					.toBe(1);
				await page.evaluate(() => window.phoneGeolocation?.release());
			}
			await expect
				.poll(() =>
					page.evaluate(
						() => window.previewGeopointAudit.observation().toasts.length,
					),
				)
				.toBe(1);
			const after = await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			);
			await capturePhoneRuntime(
				page,
				testInfo,
				`spanish-controlled-error-${code}`,
				after,
			);
			expect.soft(after.toasts[0]?.title).toBe("Ubicación no disponible");
			expect.soft(after.toasts[0]?.message).toMatch(reason);
			expect(after.answer).toBe(before.answer);
			expect(after.document).toBe(before.document);
			await page.getByRole("button", { name: "Dismiss", exact: true }).click();
			await expect
				.poll(() =>
					page.evaluate(() => window.previewGeopointAudit.toasts().length),
				)
				.toBe(0);
			// The store retires first; the exiting toast still owns its DOM button.
			await expect(
				page.getByRole("button", { name: "Dismiss", exact: true }),
			).toHaveCount(0);
		}
	},
);

for (const [from, to, code, title, reason] of [
	["English", "Español", 1, "Ubicación no disponible", /permiso/i],
	["Español", "English", 3, "Location unavailable", /timed out/i],
] as const) {
	gps(
		`a held location failure uses ${to} selected after the request began in ${from}`,
		async ({ page }, testInfo) => {
			if (from === "Español") await selectWorkerLanguage(page, from);
			const before = await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			);
			await controlLocationFailure(page, code);
			await locateButton(page).click();
			await expect
				.poll(() => page.evaluate(() => window.phoneGeolocation?.pending()))
				.toBe(1);
			await selectWorkerLanguage(page, to);
			await capturePhoneRuntime(
				page,
				testInfo,
				"language-changed-before-error",
				await page.evaluate(() => window.previewGeopointAudit.observation()),
			);
			await page.evaluate(() => window.phoneGeolocation?.release());
			await expect
				.poll(() =>
					page.evaluate(
						() => window.previewGeopointAudit.observation().toasts.length,
					),
				)
				.toBe(1);
			const after = await page.evaluate(() =>
				window.previewGeopointAudit.observation(),
			);
			await capturePhoneRuntime(
				page,
				testInfo,
				"error-delivered-in-selected-language",
				after,
			);
			expect.soft(after.toasts[0]?.title).toBe(title);
			expect.soft(after.toasts[0]?.message).toMatch(reason);
			expect(after.entryKey).toBe(before.entryKey);
			expect(after.answer).toBe(before.answer);
			expect(after.document).toBe(before.document);
		},
	);
}

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
