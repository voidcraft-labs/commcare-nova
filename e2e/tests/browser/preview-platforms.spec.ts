import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { buildUrl } from "@/lib/routing/location";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-navigation-client";
import type {} from "../../lib/preview-platforms-client";
import type {} from "../../lib/preview-search-client";
import {
	NAVIGATION_APP_ID,
	NAVIGATION_CASES,
	NAVIGATION_HOUSEHOLDS,
	NAVIGATION_VILLAGES,
	PARENT_CHAIN_HOUSEHOLDS_MODULE_UUID,
} from "../../lib/previewNavigationFixture";
import {
	PREVIEW_PLATFORM_SCENARIOS,
	type PreviewPlatformScenarioId,
} from "../../lib/previewPlatformScenarios";
import { PLATFORM_IDS } from "../../lib/previewPlatformsFixture";

/**
 * Preview plays one platform at a time: one test per browser scenario the
 * cell table (`lib/preview/__tests__/platformCells.ts`) names, each running
 * the production screen as the scenario's platform and asserting the
 * scenario's observable. `PREVIEW_PLATFORM_CHECKS` is typed by the registry,
 * so a scenario with no check fails `tsc`.
 *
 * Media requests (`/api/media/<asset>`) are answered with one transparent pixel and
 * counted, so a scenario that draws no media proves it by asking for none.
 *
 * The navigation tests at the end run the running app's menus in their own
 * peer (`preview-navigation-client.tsx`): where a menu that searches first
 * opens on each platform, and where a case chosen from a case list menu
 * entry beside forms lands.
 */

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

let platformsPeer: Awaited<ReturnType<typeof componentPeer>>;
let searchPeer: Awaited<ReturnType<typeof componentPeer>>;
let navigationPeer: Awaited<ReturnType<typeof componentPeer>>;

test.beforeAll(async () => {
	const boundary = resolve("e2e/lib/preview-section-paging-boundary.ts");
	platformsPeer = await componentPeer(
		"e2e/lib/preview-platforms-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
			"@/lib/deployment/actions": boundary,
			"@/lib/doc/platformChangePreflight": boundary,
			"@/lib/preview/app-tests/actions": boundary,
		},
	);
	searchPeer = await componentPeer("e2e/lib/preview-search-client.tsx");
	const navigation = resolve("e2e/lib/preview-navigation-boundary.ts");
	navigationPeer = await componentPeer(
		"e2e/lib/preview-navigation-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": navigation,
			"@/lib/preview/engine/lookupDataBinding": navigation,
			"@/lib/preview/entryPointLaunchAction": navigation,
			"@/lib/auth/hooks/useAuth": navigation,
			"@/lib/lookup/actions": navigation,
			"@/lib/deployment/actions": navigation,
			"@/lib/doc/platformChangePreflight": navigation,
			"@/lib/preview/app-tests/actions": navigation,
			"@/components/builder/app-setup/AppSetupWorkspace": navigation,
			"@/components/builder/case-operations/CaseOperationDetailCanvas":
				navigation,
			"@/components/builder/case-operations/CaseOperationsCanvas": navigation,
			"@/components/builder/conditions/DisplayConditionCanvas": navigation,
			"@/components/builder/data-review/DataReviewScreen": navigation,
			"@/components/builder/form-links/FormLinkDetailCanvas": navigation,
			"@/components/builder/form-links/FormLinksCanvas": navigation,
			"@/components/builder/project-data/ProjectDataWorkspace": navigation,
			"@/components/builder/case-list-config/CaseListConfigWorkspace":
				navigation,
		},
	);
});
test.afterAll(async () => {
	await platformsPeer?.close();
	await searchPeer?.close();
	await navigationPeer?.close();
});

interface Run {
	readonly page: Page;
	/** The media asset paths the page asked for. */
	readonly mediaRequests: string[];
}

async function openScenario(
	page: Page,
	id: PreviewPlatformScenarioId,
): Promise<Run> {
	const mediaRequests: string[] = [];
	await page.route(`${platformsPeer.origin}/api/media/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		mediaRequests.push(path);
		if (path.includes(PLATFORM_IDS.menuSound)) {
			await route.fulfill({
				body: readFileSync(resolve("lib/media/__tests__/fixtures/tone.wav")),
				contentType: "audio/wav",
			});
		} else {
			await route.fulfill({ body: PIXEL, contentType: "image/png" });
		}
	});
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto(`${platformsPeer.origin}/?scenario=${id}`);
	if (PREVIEW_PLATFORM_SCENARIOS[id].fixture !== "home")
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible({ timeout: 20_000 });
	return { page, mediaRequests };
}

async function openSearch(page: Page, platform: "web-apps" | "android") {
	await page.goto(`${searchPeer.origin}/?platform=${platform}`);
	await expect(page.getByLabel("Patient name")).toBeVisible();
}

function answer(page: Page, uuid: string) {
	return page.evaluate(
		(target) => window.previewPlatforms.answer(target),
		uuid,
	);
}

/** The attachments transport, answered in process: the upload is staged and
 *  confirmed without reaching a server. */
async function acceptAttachments(page: Page) {
	const origin = platformsPeer.origin;
	await page.route(
		`${origin}/api/apps/native-platforms/attachments**`,
		async (route) => {
			const request = route.request();
			if (request.method() === "DELETE") {
				await route.fulfill({ status: 204 });
			} else if (request.method() === "PATCH") {
				await route.fulfill({
					json: { instancePath: request.postDataJSON().instancePath },
				});
			} else if (new URL(request.url()).pathname.endsWith("/attachments")) {
				await route.fulfill({
					json: {
						attachmentId: "platforms-capture",
						attachmentName: "large.png",
						uploadUrl: `${origin}/capture-upload`,
						uploadContentType: "image/png",
						uploadHeaders: {},
					},
				});
			} else {
				await route.fulfill({
					json: {
						attachmentId: "platforms-capture",
						attachmentName: "large.png",
						originalFilename: "large.png",
						sizeBytes: 3_200_000,
					},
				});
			}
		},
	);
	await page.route(`${origin}/capture-upload`, async (route) => {
		await route.fulfill({ status: 200, body: "" });
	});
}

async function helpOf(run: Run, platform: "web-apps" | "android") {
	const { page } = run;
	const showHelp = page.getByRole("button", { name: "Show help", exact: true });
	/* Web Apps draws help only for help text; Android for help media alone
	 * too. Two questions hold help text, one of them written with formatting
	 * off. */
	await expect(showHelp).toHaveCount(platform === "web-apps" ? 2 : 3);
	await showHelp.first().click();
	const dialog = page.getByRole("dialog", { name: "Name" });
	await expect(dialog).toBeVisible();
	await expect(dialog.locator("strong")).toHaveText("full");
	if (platform === "web-apps") {
		await expect(
			dialog.getByRole("button", { name: "OK", exact: true }),
		).toHaveCount(0);
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
	} else {
		await expect(
			dialog.getByRole("button", { name: "Close", exact: true }),
		).toHaveCount(0);
		await dialog.getByRole("button", { name: "OK", exact: true }).click();
	}
	await expect(dialog).toHaveCount(0);
	if (platform === "web-apps") {
		expect(run.mediaRequests).toEqual([]);
		return;
	}
	await showHelp.nth(1).click();
	const mediaDialog = page.getByRole("dialog", { name: "Note" });
	await expect(mediaDialog.locator("img")).toHaveCount(1);
	await expect
		.poll(() => run.mediaRequests)
		.toContain(`/api/media/${PLATFORM_IDS.helpImage}`);
	await mediaDialog.getByRole("button", { name: "OK", exact: true }).click();
}

async function hintOf(page: Page, markdown: boolean) {
	const name = page.getByRole("textbox", { name: /Name/ });
	if (markdown) {
		await expect(page.locator("strong", { hasText: /^bold$/ })).toHaveCount(1);
		await expect(page.getByText("Use **bold** words")).toHaveCount(0);
	} else {
		await expect(page.getByText("Use **bold** words")).toBeVisible();
	}
	await expect(name).toBeVisible();
}

async function validationOf(page: Page) {
	const name = page.getByRole("textbox", { name: /Name/ });
	await name.fill("bad");
	await name.blur();
	await expect(page.getByText("Not **bad**", { exact: true })).toBeVisible();
	await expect(name).toHaveAttribute("aria-invalid", "true");
}

async function choiceLabelOf(page: Page) {
	const yes = page.getByRole("radio", { name: /Bold yes/ });
	await expect(yes).toBeVisible();
	await expect(page.locator("strong", { hasText: /^Bold$/ })).toHaveCount(1);
	await expect(page.getByText("**Bold** yes")).toHaveCount(0);
}

async function attachOnly(run: Run, label: string) {
	const { page } = run;
	/* The file input is named by its question's label and its action, which
	 * it joins by aria-labelledby; getByLabel matches each labelling element
	 * alone, so the input is found by its whole accessible name. */
	await expect(
		page.getByRole("button", { name: `${label} Attach file` }),
	).toHaveCount(1);
	await expect(page.locator('input[type="file"][capture]')).toHaveCount(0);
	for (const name of [
		"Take picture",
		"Choose image",
		"Start recording",
		"Record video",
		"Choose video",
	])
		await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
			0,
		);
}

const PREVIEW_PLATFORM_CHECKS: Readonly<
	Record<PreviewPlatformScenarioId, (page: Page) => Promise<void>>
> = {
	async "location-map-web-apps"(page) {
		await openScenario(page, "location-map-web-apps");
		await expect(
			page.getByRole("button", { name: "Record location", exact: true }),
		).toHaveCount(0);
		await expect(page.getByText(/use my location/i)).toHaveCount(0);
		await page
			.getByRole("button", { name: "Enter coordinates manually", exact: true })
			.click();
		await page.getByRole("spinbutton", { name: "Latitude" }).fill("40");
		const longitude = page.getByRole("spinbutton", { name: "Longitude" });
		await longitude.fill("-74");
		await longitude.press("Enter");
		await expect
			.poll(() => answer(page, PLATFORM_IDS.place))
			.toBe("40.0 -74.0 0.0 0.0");
	},
	async "barcode-text-web-apps"(page) {
		await openScenario(page, "barcode-text-web-apps");
		const code = page.getByRole("textbox", { name: /Code/ });
		await code.fill("BC-7");
		await code.blur();
		await expect(page.getByRole("button", { name: /^Scan/ })).toHaveCount(0);
		await expect(page.getByText(/doesn't support camera scanning/)).toHaveCount(
			0,
		);
		await expect.poll(() => answer(page, PLATFORM_IDS.code)).toBe("BC-7");
	},
	async "number-keypad-web-apps"(page) {
		await openScenario(page, "number-keypad-web-apps");
		const phone = page.getByRole("textbox", { name: /Phone/ });
		await expect(phone).toHaveAttribute("inputmode", "tel");
		const refusal =
			"This answer takes digits, with an optional + or - in front and an optional decimal part.";
		await phone.fill("0712");
		await phone.blur();
		await expect.poll(() => answer(page, PLATFORM_IDS.phoneHeld)).toBe("0712");
		await phone.fill("+254712");
		await phone.blur();
		await expect
			.poll(() => answer(page, PLATFORM_IDS.phoneHeld))
			.toBe("+254712");
		await expect(page.getByText(refusal)).toHaveCount(0);
		await phone.fill("12 34");
		await phone.blur();
		await expect(page.getByText(refusal)).toBeVisible();
		await expect(phone).toHaveValue("12 34");
		await expect(phone).toHaveAttribute("aria-invalid", "true");
		expect(await answer(page, PLATFORM_IDS.phoneHeld)).toBe("+254712");
	},
	async "image-attach-web-apps"(page) {
		await attachOnly(
			await openScenario(page, "image-attach-web-apps"),
			"Photo",
		);
	},
	async "audio-attach-web-apps"(page) {
		await attachOnly(
			await openScenario(page, "audio-attach-web-apps"),
			"Voice",
		);
	},
	async "video-attach-web-apps"(page) {
		await attachOnly(await openScenario(page, "video-attach-web-apps"), "Clip");
	},
	async "sections-one-screen-web-apps"(page) {
		await openScenario(page, "sections-one-screen-web-apps");
		await expect(
			page.getByRole("heading", { name: "About you", level: 2 }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Your visit", level: 2 }),
		).toBeVisible();
		await expect(page.getByRole("textbox", { name: /Note/ })).toBeVisible();
		await expect(
			page.getByRole("navigation", { name: "Sections" }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Next", exact: true }),
		).toHaveCount(0);
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(page.getByRole("textbox", { name: /Name/ })).toHaveAttribute(
			"aria-invalid",
			"true",
		);
	},
	async "choice-media-web-apps"(page) {
		const run = await openScenario(page, "choice-media-web-apps");
		await expect(page.getByRole("radio", { name: /Yes/ })).toBeVisible();
		await expect(page.locator("img")).toHaveCount(0);
		expect(run.mediaRequests).toEqual([]);
	},
	async "help-web-apps"(page) {
		await helpOf(await openScenario(page, "help-web-apps"), "web-apps");
	},
	async "help-plain-web-apps"(page) {
		await openScenario(page, "help-plain-web-apps");
		/* The question holds `plainHelp`, so its help writes no markdown form;
		 * the Web Apps client formats its default text all the same. */
		await page
			.getByRole("button", { name: "Show help", exact: true })
			.nth(1)
			.click();
		const dialog = page.getByRole("dialog", { name: "Plain help" });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator("strong")).toHaveText("full");
		await expect(dialog.getByText("Ask for the **full** name")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toHaveCount(0);
	},
	async "hint-markdown-web-apps"(page) {
		await openScenario(page, "hint-markdown-web-apps");
		await hintOf(page, true);
	},
	async "validation-plain-web-apps"(page) {
		await openScenario(page, "validation-plain-web-apps");
		await validationOf(page);
	},
	async "choice-label-markdown-web-apps"(page) {
		await openScenario(page, "choice-label-markdown-web-apps");
		await choiceLabelOf(page);
	},
	async "choice-label-plain-web-apps"(page) {
		await openScenario(page, "choice-label-plain-web-apps");
		/* The choice holds `plainLabel`, so its item writes no markdown form;
		 * the Web Apps client formats it all the same. */
		await expect(
			page.getByRole("radio", { name: /Plain maybe/ }),
		).toBeVisible();
		await expect(page.locator("em", { hasText: /^Plain$/ })).toHaveCount(1);
		await expect(page.getByText("*Plain* maybe")).toHaveCount(0);
	},
	async "group-label-web-apps"(page) {
		await openScenario(page, "group-label-web-apps");
		await expect(
			page.getByRole("button", { name: /Details/, expanded: true }),
		).toBeVisible();
		await expect(page.getByRole("textbox", { name: /Inside/ })).toBeVisible();
	},
	async "barcode-search-field-web-apps"(page) {
		await openSearch(page, "web-apps");
		await expect(page.getByLabel("Barcode", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: /^Scan/ })).toHaveCount(0);
		await expect(page.getByText("First or last name")).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Find a patient", level: 1 }),
		).toBeVisible();
	},
	async "help-android"(page) {
		await helpOf(await openScenario(page, "help-android"), "android");
	},
	async "hint-plain-android"(page) {
		await openScenario(page, "hint-plain-android");
		await hintOf(page, false);
	},
	async "validation-plain-android"(page) {
		await openScenario(page, "validation-plain-android");
		await validationOf(page);
	},
	async "choice-label-markdown-android"(page) {
		await openScenario(page, "choice-label-markdown-android");
		await choiceLabelOf(page);
	},
	async "group-label-android"(page) {
		await openScenario(page, "group-label-android");
		const header = page.locator("[data-screen-header]");
		await page.getByRole("textbox", { name: /Name/ }).fill("Ada");
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await expect(header).toHaveText("Visits (1) > Details");
		await expect(page.getByRole("textbox", { name: /Note/ })).toBeVisible();
		/* Android draws no card for a group: its label is the header line. */
		await expect(
			page.getByRole("button", { name: /Details/, expanded: true }),
		).toHaveCount(0);
		await page.getByRole("button", { name: "Next", exact: true }).click();
		const prompt = page.getByRole("alertdialog", {
			name: "Add another Visits?",
		});
		await expect(prompt).toBeVisible();
		await prompt
			.getByRole("button", { name: "Add another Visits?", exact: true })
			.click();
		await expect(header).toHaveText("Visits (2) > Details");
	},
	async "label-markdown-android"(page) {
		await openScenario(page, "label-markdown-android");
		/* Markwon joins the single newline with a space, drops the raw tag and
		 * shows the image as its alt text. */
		await expect(page.getByText("a b x c", { exact: true })).toBeVisible();
		await expect(page.locator("b")).toHaveCount(0);
		await expect(page.locator('img[src="y"]')).toHaveCount(0);
	},
	async "search-screen-text-android"(page) {
		await openSearch(page, "android");
		await expect(
			page.getByRole("heading", { name: "Search All Cases", level: 1 }),
		).toBeVisible();
		await expect(page.getByText("Find a patient")).toHaveCount(0);
		await expect(page.getByText("Search by name or barcode")).toHaveCount(0);
		await expect(page.getByText("First or last name")).toHaveCount(0);
	},
	async "menu-grid-web-apps"(page) {
		const run = await openScenario(page, "menu-grid-web-apps");
		const grid = page.locator('[data-menu-layout="grid"]');
		const tile = grid.getByRole("button", { name: /^Visits/ });
		await tile.focus();
		await expect(tile).toBeFocused();
		await expect(grid.locator("audio")).toHaveCount(0);
		expect(
			run.mediaRequests.some((path) => path.includes(PLATFORM_IDS.menuSound)),
		).toBe(false);
	},
	async "menu-grid-android"(page) {
		await openScenario(page, "menu-grid-android");
		const grid = page.locator('[data-menu-layout="grid"]');
		const tile = grid.getByRole("button", { name: /^Visits/ });
		const player = grid.locator("audio");
		await expect(player).toHaveAccessibleName("Visits");
		await tile.hover();
		await page.mouse.down();
		try {
			await expect
				.poll(() => player.evaluate((el: HTMLAudioElement) => el.played.length))
				.toBeGreaterThan(0);
		} finally {
			await page.mouse.up();
		}
		await expect(tile).toBeVisible();
	},
	async "logo-android"(page) {
		const run = await openScenario(page, "logo-android");
		await expect(page.getByRole("button", { name: /^Visits/ })).toBeVisible();
		await expect(page.locator(`img[src*="${PLATFORM_IDS.logo}"]`)).toHaveCount(
			0,
		);
		expect(run.mediaRequests).toEqual([]);
	},
	async "location-record-android"(page) {
		await page.context().grantPermissions(["geolocation"]);
		await page
			.context()
			.setGeolocation({ latitude: 41, longitude: -75, accuracy: 40 });
		await openScenario(page, "location-record-android");
		await expect(page.getByRole("combobox")).toHaveCount(0);
		await page
			.getByRole("button", { name: "Record location", exact: true })
			.click();
		const dialog = page.getByRole("dialog", { name: "Finding location" });
		/* A fix worse than 5 metres waits for the worker, who can take it once
		 * its accuracy shows. */
		await expect(
			dialog.getByText(/^Location accuracy: 40(\.0)? m$/),
		).toBeVisible();
		await dialog
			.getByRole("button", { name: "Record location", exact: true })
			.click();
		await expect(dialog).toHaveCount(0);
		await expect
			.poll(() => answer(page, PLATFORM_IDS.place))
			.toBe("41.0 -75.0 0.0 40.0");
		/* Android's reading is one block of four lines, accuracy last. */
		await expect(page.getByText(/Accuracy: 40(\.0)?m$/)).toBeVisible();
		/* A fix of 5 metres or better is taken at once. */
		await page.context().setGeolocation({
			latitude: 40,
			longitude: -74,
			accuracy: 4,
		});
		await page
			.getByRole("button", { name: "Replace location", exact: true })
			.click();
		await expect
			.poll(() => answer(page, PLATFORM_IDS.place))
			.toBe("40.0 -74.0 0.0 4.0");
		await expect(dialog).toHaveCount(0);
		/* Cancel writes nothing and shows Android's toast. */
		await page.context().clearPermissions();
		await page
			.getByRole("button", { name: "Replace location", exact: true })
			.click();
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByText("Location capture cancelled")).toBeVisible();
		expect(await answer(page, PLATFORM_IDS.place)).toBe("40.0 -74.0 0.0 4.0");
	},
	async "capture-android"(page) {
		await acceptAttachments(page);
		await openScenario(page, "capture-android");
		await expect(
			page.getByRole("button", { name: /^Take picture/ }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /^Choose image/ }),
		).toBeVisible();
		/* Take picture asks the browser for its camera; Choose image does not,
		 * and both accept any image. */
		await expect(
			page.locator(
				'input[type="file"][capture="environment"][accept="image/*"]',
			),
		).toHaveCount(1);
		const choose = page.locator(
			'input[type="file"][accept="image/*"]:not([capture])',
		);
		await expect(choose).toHaveCount(1);
		const largeLine = page.getByText(
			"This file is large and may be slow to send",
		);
		await choose.setInputFiles({
			name: "huge.png",
			mimeType: "image/png",
			buffer: Buffer.alloc(15 * 1_048_576),
		});
		await expect(
			page.getByText(
				"This file is bigger than 15 MB. You can choose a smaller one.",
			),
		).toBeVisible();
		expect(await answer(page, PLATFORM_IDS.image)).toBe("");
		/* Android warns from 3,001 whole KiB: one byte under attaches
		 * quietly, and the first warned size attaches with the line. */
		await choose.setInputFiles({
			name: "quiet.png",
			mimeType: "image/png",
			buffer: Buffer.alloc(3_073_023),
		});
		await expect.poll(() => answer(page, PLATFORM_IDS.image)).not.toBe("");
		await expect(largeLine).toHaveCount(0);
		await expect(choose).toBeEnabled();
		await choose.setInputFiles({
			name: "large.png",
			mimeType: "image/png",
			buffer: Buffer.alloc(3_073_024),
		});
		await expect(largeLine).toBeVisible();
		await expect.poll(() => answer(page, PLATFORM_IDS.image)).not.toBe("");
	},
	async "barcode-scan-android"(page) {
		/* Whether a browser ships BarcodeDetector varies by host (Chromium has
		 * one on macOS and none on Linux), so the test decides: first a browser
		 * without one, where the line stands in for Scan, then one whose
		 * detector reads a format, where Scan shows. */
		await page.addInitScript(() => {
			Reflect.deleteProperty(window, "BarcodeDetector");
		});
		await openScenario(page, "barcode-scan-android");
		expect(await page.evaluate(() => "BarcodeDetector" in window)).toBe(false);
		await expect(
			page.getByText(
				"Your browser doesn't support camera scanning. You can type the barcode",
			),
		).toBeVisible();
		await page.addInitScript(() => {
			Object.defineProperty(window, "BarcodeDetector", {
				value: class {
					static async getSupportedFormats() {
						return ["code_128"];
					}
					async detect() {
						return [];
					}
				},
			});
		});
		/* Open the scenario again rather than reload: the peer moved the URL
		 * to the form's builder path, which it does not serve. */
		await page.goto(`${platformsPeer.origin}/?scenario=barcode-scan-android`);
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole("button", { name: /^Scan/ })).toBeVisible();
		await page.getByRole("textbox", { name: /Code/ }).fill("BC-8");
		await expect.poll(() => answer(page, PLATFORM_IDS.code)).toBe("BC-8");
	},
	async "form-screens-android"(page) {
		await openScenario(page, "form-screens-android");
		const header = page.locator("[data-screen-header]");
		const name = page.getByRole("textbox", { name: /Name/ });
		const note = page.getByRole("textbox", { name: /Note/ });
		const next = page.getByRole("button", { name: "Next", exact: true });
		const back = page.getByRole("button", { name: "Back", exact: true });
		const prompt = page.getByRole("alertdialog", {
			name: "Add another Visits?",
		});
		const addAnother = prompt.getByRole("button", {
			name: "Add another Visits?",
			exact: true,
		});
		/* One question per screen outside a group. */
		await expect(name).toBeVisible();
		await expect(note).toHaveCount(0);
		/* Next validates the screen. */
		await next.click();
		await expect(name).toHaveAttribute("aria-invalid", "true");
		/* The name Quick hides everything after the repeat, so its prompt has
		 * nothing after it and declining finishes the form. */
		await name.fill("Quick");
		await next.click();
		await expect(header).toHaveText("Visits (1) > Details");
		await note.fill("First");
		await next.click();
		await expect(prompt).toBeVisible();
		await expect(
			prompt.getByRole("button", {
				name: "Do not add, I'm finished",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			prompt.getByRole("button", { name: "Do not add", exact: true }),
		).toHaveCount(0);
		/* Go back closes the prompt on the screen before it. */
		await prompt.getByRole("button", { name: "Go back", exact: true }).click();
		await expect(prompt).toHaveCount(0);
		await expect(header).toHaveText("Visits (1) > Details");
		await expect(note).toHaveValue("First");
		await next.click();
		await prompt
			.getByRole("button", { name: "Do not add, I'm finished", exact: true })
			.click();
		await expect(prompt).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Finish", exact: true }),
		).toBeVisible();
		await expect(next).toHaveCount(0);
		/* Android offers no delete for an entry. */
		await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
		await back.click();
		await expect(name).toBeVisible();
		await name.fill("Ada");
		await next.click();
		await expect(header).toHaveText("Visits (1) > Details");
		await next.click();
		await expect(prompt).toBeVisible();
		/* A group shown on one screen inside a repeat is one screen per
		 * entry. */
		await addAnother.click();
		await expect(header).toHaveText("Visits (2) > Details");
		await expect(note).toHaveValue("");
		await next.click();
		await expect(prompt).toBeVisible();
		await prompt
			.getByRole("button", { name: "Do not add", exact: true })
			.click();
		/* A group shown on one screen is one screen of all its questions. */
		await expect(header).toHaveText("Household");
		await expect(page.getByRole("textbox", { name: /Adults/ })).toBeVisible();
		await expect(page.getByRole("textbox", { name: /Children/ })).toBeVisible();
		/* An unlabeled group's questions are one screen each. */
		await next.click();
		await expect(
			page.getByRole("textbox", { name: /First extra/ }),
		).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: /Second extra/ }),
		).toHaveCount(0);
		await next.click();
		await expect(
			page.getByRole("textbox", { name: /Second extra/ }),
		).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: /First extra/ }),
		).toHaveCount(0);
		/* A labeled group without `fieldList` is transparent: the repeat
		 * the worker adds to inside it pages its entry under the group's
		 * header line and prompts after it, with no add control. */
		await next.click();
		await expect(header).toHaveText("Stock > Items (1)");
		await expect(page.getByRole("textbox", { name: /Item/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /^Add / })).toHaveCount(0);
		await next.click();
		const itemsPrompt = page.getByRole("alertdialog", {
			name: "Add another Items?",
		});
		await expect(itemsPrompt).toBeVisible();
		await itemsPrompt
			.getByRole("button", { name: "Do not add", exact: true })
			.click();
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await expect(page.getByRole("textbox", { name: /Wrap up/ })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Finish", exact: true }),
		).toBeVisible();
		await expect(next).toHaveCount(0);
	},
};

for (const [id, scenario] of Object.entries(PREVIEW_PLATFORM_SCENARIOS) as [
	PreviewPlatformScenarioId,
	(typeof PREVIEW_PLATFORM_SCENARIOS)[PreviewPlatformScenarioId],
][]) {
	test(`${id}: ${scenario.describe}`, async ({ page }) => {
		try {
			await PREVIEW_PLATFORM_CHECKS[id](page);
		} finally {
			if (!page.isClosed())
				await page.evaluate(async () => {
					await window.previewPlatforms?.dispose();
					window.previewSearchAudit?.dispose();
				});
		}
	});
}

/** Open the navigation peer's fixture as `platform`, on the app's menu. */
async function openNavigation(
	page: Page,
	query: { fixture: string; platform: string; details?: boolean },
) {
	await page.setViewportSize({ width: 390, height: 800 });
	const search = new URLSearchParams({
		fixture: query.fixture,
		platform: query.platform,
	});
	if (query.details) search.set("details", "");
	await page.goto(`${navigationPeer.origin}/?${search}`);
	const main = page.locator("main");
	await main
		.getByRole("button", { name: /^Patients\b/ })
		.click({ timeout: 20_000 });
	return main;
}

async function closeNavigation(page: Page) {
	if (!page.isClosed())
		await page.evaluate(() => window.previewNavigation?.dispose());
}

const [FIRST_CASE] = NAVIGATION_CASES;
const [RAO_HOUSEHOLD] = NAVIGATION_HOUSEHOLDS;

/* A worker assigned nowhere has no place key in the session
 * (`models.py::get_user_session_data`), and Core refuses a read of a key the
 * device lacks, failing the menu that reads it (`MenuLoader`, shown by
 * Formplayer's `MenuScreen.init` and Android's `MenuAdapter`). */
for (const platform of ["web-apps", "android"] as const)
	test(`${platform}: a first menu whose condition reads a place the worker lacks stops as a phone does, saying what to change`, async ({
		page,
	}) => {
		try {
			await page.setViewportSize({ width: 390, height: 800 });
			await page.goto(
				`${navigationPeer.origin}/?fixture=place-condition&platform=${platform}`,
			);
			const main = page.locator("main");
			const refusal = main.locator(
				'[data-preview-data-refusal="worker-information"]',
			);
			await expect(refusal).toBeVisible({ timeout: 20_000 });
			await expect(refusal).toHaveAttribute(
				"data-preview-data-refusal-surface",
				"menu",
			);
			await expect(
				refusal.getByRole("heading", {
					name: "This menu doesn't open on a phone",
				}),
			).toBeVisible();
			await expect(refusal).toContainText(
				"This menu reads worker information you don't have",
			);
			await expect(refusal).toContainText(
				"you can preview as a persona who has a place",
			);
			// No menu of the screen lists in its place.
			await expect(
				main.getByRole("button", { name: /^Patients\b/ }),
			).toHaveCount(0);
		} finally {
			await closeNavigation(page);
		}
	});

/* Every other screen that reads the place of a worker assigned nowhere stops
 * as a phone stops there, with the refusal held as the screen's state, so
 * nothing reaches the console (the error guard). */
async function openPlaceScreen(page: Page, platform: string, menu: RegExp) {
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto(
		`${navigationPeer.origin}/?fixture=place-screens&platform=${platform}`,
	);
	const main = page.locator("main");
	await main.getByRole("button", { name: menu }).click({ timeout: 20_000 });
	return main;
}

function workerRefusal(main: Locator) {
	return main.locator('[data-preview-data-refusal="worker-information"]');
}

for (const platform of ["web-apps", "android"] as const) {
	test(`${platform}: a menu whose submenu's condition reads a place the worker lacks stops on its own screen`, async ({
		page,
	}) => {
		try {
			const main = await openPlaceScreen(page, platform, /^Districts\b/);
			const refusal = workerRefusal(main);
			await expect(refusal).toBeVisible({ timeout: 20_000 });
			await expect(refusal).toHaveAttribute(
				"data-preview-data-refusal-surface",
				"menu",
			);
			await expect(
				refusal.getByRole("heading", {
					name: "This menu doesn't open on a phone",
				}),
			).toBeVisible();
			await expect(
				main.getByRole("button", { name: /^District survey\b/ }),
			).toHaveCount(0);
		} finally {
			await closeNavigation(page);
		}
	});

	test(`${platform}: a case-first menu whose form's condition reads a place the worker lacks stops once the case is chosen`, async ({
		page,
	}) => {
		try {
			const main = await openPlaceScreen(page, platform, /^Patients\b/);
			await main
				.getByRole("button", { name: `Continue with ${FIRST_CASE}` })
				.click({ timeout: 20_000 });
			const refusal = workerRefusal(main);
			await expect(refusal).toBeVisible({ timeout: 20_000 });
			await expect(refusal).toHaveAttribute(
				"data-preview-data-refusal-surface",
				"menu",
			);
			// No form of the menu lists or opens in its place.
			await expect(main.locator("[data-form-menu-choice-label]")).toHaveCount(
				0,
			);
			await expect(main.getByRole("button", { name: "Submit" })).toHaveCount(0);
		} finally {
			await closeNavigation(page);
		}
	});

	test(`${platform}: a list whose filter reads a place the worker lacks stops in place of its cases`, async ({
		page,
	}) => {
		try {
			const main = await openPlaceScreen(page, platform, /^Placed patients\b/);
			const refusal = workerRefusal(main);
			await expect(refusal).toBeVisible({ timeout: 20_000 });
			await expect(refusal).toHaveAttribute(
				"data-preview-data-refusal-surface",
				"list",
			);
			await expect(
				refusal.getByRole("heading", {
					name: "This case list doesn't open on a phone",
				}),
			).toBeVisible();
			await expect(
				main.getByRole("button", { name: `Continue with ${FIRST_CASE}` }),
			).toHaveCount(0);
		} finally {
			await closeNavigation(page);
		}
	});
}

/* A Search field that starts on the place: Web Apps opens the menu on its
 * Search screen, which reads the value as it opens, so the screen stops;
 * Android opens the list first and stops only the search. */
test("web-apps: a Search screen that starts a field on a place the worker lacks stops as it opens", async ({
	page,
}) => {
	try {
		const main = await openPlaceScreen(page, "web-apps", /^Find patients\b/);
		const refusal = workerRefusal(main);
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toHaveAttribute(
			"data-preview-data-refusal-surface",
			"search",
		);
		await expect(
			refusal.getByRole("heading", {
				name: "This search doesn't open on a phone",
			}),
		).toBeVisible();
		await expect(refusal).toContainText(
			"This search reads worker information you don't have",
		);
		await expect(main.getByLabel("Place")).toHaveCount(0);
	} finally {
		await closeNavigation(page);
	}
});

test("android: a list that opens first keeps its cases, and its Search stops on a place the worker lacks", async ({
	page,
}) => {
	try {
		const main = await openPlaceScreen(page, "android", /^Find patients\b/);
		const refusal = workerRefusal(main);
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toHaveAttribute(
			"data-preview-data-refusal-surface",
			"search",
		);
		await expect(main.getByLabel("Place")).toHaveCount(0);
		await expect(
			main.getByRole("button", { name: `Continue with ${FIRST_CASE}` }),
		).toBeVisible();
	} finally {
		await closeNavigation(page);
	}
});

test("a menu that searches first opens on Search in Web Apps", async ({
	page,
}) => {
	try {
		const main = await openNavigation(page, {
			fixture: "search-first",
			platform: "web-apps",
		});
		await expect(main.getByRole("search", { name: "Search" })).toBeVisible({
			timeout: 20_000,
		});
		await expect(
			main.getByRole("textbox", { name: "Patient name" }),
		).toBeVisible();
		await expect(main.getByRole("list", { name: "Cases" })).toHaveCount(0);
		/* Web Apps' query screen draws Clear (`cloudcare/partials/query/list.html`,
		 * `#query-clear-button`), which empties the fields. */
		const answer = main.getByRole("textbox", { name: "Patient name" });
		await answer.fill("Ko");
		await main
			.getByRole("button", { name: "Clear search", exact: true })
			.click({ timeout: 20_000 });
		await expect(answer).toHaveValue("");
	} finally {
		await closeNavigation(page);
	}
});

test("a menu that searches first opens on its case list on Android", async ({
	page,
}) => {
	try {
		const main = await openNavigation(page, {
			fixture: "search-first",
			platform: "android",
		});
		const rows = main
			.getByRole("list", { name: "Cases", exact: true })
			.getByRole("listitem");
		await expect(rows).toHaveCount(NAVIGATION_CASES.length, {
			timeout: 20_000,
		});
		// The worker's own cases show before any search runs.
		await expect(rows.first()).toContainText(FIRST_CASE);
		/* Android's search screen holds its prompts, its search button and
		 * its error line alone (`QueryRequestUiController`), so there is no
		 * Clear to press, whatever the worker typed. */
		const answer = main.getByRole("textbox", { name: "Patient name" });
		await answer.fill("Ko");
		await expect(answer).toHaveValue("Ko");
		await expect(
			main.getByRole("button", { name: "Search All Cases", exact: true }),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: "Clear search", exact: true }),
		).toHaveCount(0);
	} finally {
		await closeNavigation(page);
	}
});

test("in Web Apps a case chosen from the case list entry beside forms shows the screen before it again", async ({
	page,
}) => {
	try {
		const main = await openNavigation(page, {
			fixture: "case-list-entry",
			platform: "web-apps",
		});
		const entry = main.locator("[data-case-list-menu-entry]");
		await expect(entry).toBeVisible({ timeout: 20_000 });
		// The entry comes after the menu's forms.
		// Each command sits in its own choice beside its spoken label.
		const commands = entry
			.locator("xpath=ancestor::*[@data-menu-layout][1]")
			.locator("[data-menu-choice] > button");
		await expect(commands.first()).toContainText("Register");
		await expect(commands.last()).toHaveAttribute("data-case-list-menu-entry");
		await entry.click();
		const choose = main.getByRole("button", {
			name: `Continue with ${FIRST_CASE}`,
		});
		await choose.click({ timeout: 20_000 });
		// Nothing opens from the entry: the list shows again, nothing chosen.
		await expect(page.getByLabel("Location")).toHaveText("cases");
		await expect(choose).toBeVisible();
		await expect(main.getByRole("button", { name: "Submit" })).toHaveCount(0);
		await expect(page.getByLabel("At the device home")).toHaveText("false");
	} finally {
		await closeNavigation(page);
	}
});

test("a case-first menu lists only its forms once the case is chosen, without its own case list entry", async ({
	page,
}) => {
	try {
		const main = await openNavigation(page, {
			fixture: "case-first-entry",
			platform: "web-apps",
		});
		await main
			.getByRole("button", { name: `Continue with ${FIRST_CASE}` })
			.click({ timeout: 20_000 });
		// The entry chooses the case already chosen, so CommCare does not list
		// it, and it lists the menu's one form rather than opening it.
		await expect(main.locator("[data-form-menu-choice-label]")).toHaveText([
			"Visit",
		]);
		await expect(main.locator("[data-case-list-menu-entry]")).toHaveCount(0);
		await expect(main.getByRole("button", { name: "Submit" })).toHaveCount(0);
		await expect(page.getByLabel("Location")).toHaveText("cases");
	} finally {
		await closeNavigation(page);
	}
});

test("a case-first menu showing another menu's forms opens on its case list, and lists its forms and its members' case list entry once a household is chosen", async ({
	page,
}) => {
	try {
		await page.setViewportSize({ width: 390, height: 800 });
		await page.goto(
			`${navigationPeer.origin}/?fixture=child-list-above&platform=web-apps`,
		);
		const main = page.locator("main");
		const entry = main.locator("[data-case-list-menu-entry]");
		await main
			.getByRole("button", { name: /^Households\b/ })
			.click({ timeout: 20_000 });
		// CommCare asks for the household before it lists anything on the
		// screen, the members' forms and case list entry included.
		const chooseHousehold = main.getByRole("button", {
			name: `Continue with ${RAO_HOUSEHOLD.name}`,
		});
		await expect(chooseHousehold).toBeVisible({ timeout: 20_000 });
		await expect(page.getByLabel("Location")).toHaveText("cases");
		await expect(main.getByRole("button", { name: "Cases" })).toHaveCount(0);
		await expect(entry).toHaveCount(0);
		await chooseHousehold.click();
		// The households' own entry would choose the household again, so
		// only the members' entry is listed, after the forms.
		await expect(entry).toHaveCount(1, { timeout: 20_000 });
		await expect(entry).toHaveText("People");
		await expect(
			main.getByRole("button", { name: /^Visit household\b/ }),
		).toBeVisible();
		await entry.click();
		// It opens the chosen household's members.
		const [member] = RAO_HOUSEHOLD.members;
		const choose = main.getByRole("button", {
			name: `Continue with ${member}`,
		});
		await expect(choose).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: /^Continue with Kofi Mensah/ }),
		).toHaveCount(0);
		await choose.click();
		// Nothing opens from the entry: the list shows again, nothing chosen.
		await expect(page.getByLabel("Location")).toHaveText("cases");
		await expect(choose).toBeVisible();
		await expect(main.getByRole("button", { name: "Submit" })).toHaveCount(0);
	} finally {
		await closeNavigation(page);
	}
});

/** Open `parent-chain` as `platform` and choose People, whose entry asks
 *  for a household chosen under a village: CommCare asks for the village
 *  first. */
async function openParentChain(page: Page, platform: string) {
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto(
		`${navigationPeer.origin}/?fixture=parent-chain&platform=${platform}`,
	);
	const main = page.locator("main");
	await main
		.getByRole("button", { name: /^People\b/ })
		.click({ timeout: 20_000 });
	return main;
}

const [NORTH_VILLAGE, SOUTH_VILLAGE] = NAVIGATION_VILLAGES;

/* CommCare collects one datum per list: Back from the household's list pops
 * the village just chosen and asks for it again (`CommCareSession.stepBack`,
 * which Android's Back runs and Web Apps' address less its last selection
 * replays), and Back from the village's list leaves to the screen People was
 * chosen on. */
for (const platform of ["web-apps", "android"] as const)
	test(`${platform}: Back from a later parent's list returns to the earlier parent's list, and Back again leaves`, async ({
		page,
	}) => {
		try {
			const main = await openParentChain(page, platform);
			const chooseNorth = main.getByRole("button", {
				name: `Continue with ${NORTH_VILLAGE}`,
			});
			await expect(chooseNorth).toBeVisible({ timeout: 20_000 });
			await chooseNorth.click();
			const chooseRao = main.getByRole("button", {
				name: `Continue with ${RAO_HOUSEHOLD.name}`,
			});
			await expect(chooseRao).toBeVisible({ timeout: 20_000 });
			await expect(
				main.getByRole("button", {
					name: `Continue with ${NAVIGATION_HOUSEHOLDS[1].name}`,
				}),
			).toHaveCount(0);
			await main.getByRole("button", { name: "Back", exact: true }).click();
			// The village's list again, with no village chosen.
			await expect(chooseNorth).toBeVisible({ timeout: 20_000 });
			await expect(
				main.getByRole("button", { name: `Continue with ${SOUTH_VILLAGE}` }),
			).toBeVisible();
			await expect(chooseRao).toHaveCount(0);
			await main.getByRole("button", { name: "Back", exact: true }).click();
			await expect(page.getByLabel("Location")).toHaveText("home", {
				timeout: 20_000,
			});
			await expect(
				main.getByRole("button", { name: /^People\b/ }),
			).toBeVisible();
		} finally {
			await closeNavigation(page);
		}
	});

/* A household's datum in People's entry names no details screen, so its row
 * goes on at once; an address naming a household on that list goes on the
 * same way and never shows its details. */
test("a parent's list whose datum names no details goes on with a case its address names", async ({
	page,
}) => {
	try {
		const main = await openParentChain(page, "web-apps");
		await main
			.getByRole("button", { name: `Continue with ${NORTH_VILLAGE}` })
			.click({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: `Continue with ${RAO_HOUSEHOLD.name}` }),
		).toBeVisible({ timeout: 20_000 });
		await page.evaluate(
			(path) => window.previewNavigation.go(path),
			buildUrl(`/build/${NAVIGATION_APP_ID}`, {
				kind: "cases",
				moduleUuid: PARENT_CHAIN_HOUSEHOLDS_MODULE_UUID,
				caseId: "navigation-household-1",
			}),
		);
		// People's list of the household's members, never its details.
		const [member, other] = RAO_HOUSEHOLD.members;
		await expect(
			main.getByRole("button", { name: `Continue with ${member}` }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: `Continue with ${other}` }),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: "Continue", exact: true }),
		).toHaveCount(0);
		await expect(
			main.getByRole("heading", { name: RAO_HOUSEHOLD.name }),
		).toHaveCount(0);
	} finally {
		await closeNavigation(page);
	}
});

/* A submenu that keeps its own screen is a `<menu root>` of its own, no entry
 * of its parent's command, so CommCare asks for the parent's case before it
 * lists the submenu's tile (`CommCareSession.getNeededData` over
 * `getEntriesForCommand`), whether the parent chooses its case for its forms
 * or is only its case list. */
for (const shape of [
	{
		menu: "Households",
		submenu: "Household notes",
		form: "Visit household",
		describe: "a case-first menu",
	},
	{
		menu: "Household list",
		submenu: "Household checks",
		form: undefined,
		describe: "a menu that is only its case list",
	},
] as const)
	test(`${shape.describe} with a submenu of its own opens on its case list, and lists the submenu once a household is chosen`, async ({
		page,
	}) => {
		try {
			await page.setViewportSize({ width: 390, height: 800 });
			await page.goto(
				`${navigationPeer.origin}/?fixture=submenus&platform=web-apps`,
			);
			const main = page.locator("main");
			await main
				.getByRole("button", { name: new RegExp(`^${shape.menu}\\b`) })
				.click({ timeout: 20_000 });
			const chooseHousehold = main.getByRole("button", {
				name: `Continue with ${RAO_HOUSEHOLD.name}`,
			});
			await expect(chooseHousehold).toBeVisible({ timeout: 20_000 });
			await expect(page.getByLabel("Location")).toHaveText("cases");
			// Nothing of the menu's screen shows before the household: no
			// submenu tile and no way past the list.
			await expect(
				main.getByRole("button", { name: new RegExp(`^${shape.submenu}\\b`) }),
			).toHaveCount(0);
			await expect(main.getByRole("button", { name: "Cases" })).toHaveCount(0);
			await chooseHousehold.click();
			const submenuTile = main.getByRole("button", {
				name: new RegExp(`^${shape.submenu}\\b`),
			});
			await expect(submenuTile).toBeVisible({ timeout: 20_000 });
			if (shape.form !== undefined)
				await expect(
					main.getByRole("button", { name: new RegExp(`^${shape.form}\\b`) }),
				).toBeVisible();
			await expect(main.getByRole("button", { name: "Submit" })).toHaveCount(0);
		} finally {
			await closeNavigation(page);
		}
	});

test("on Android a case-first menu of one form lists that form once the case is chosen", async ({
	page,
}) => {
	try {
		await page.route("**/nova-icons/record_vitals.png", (route) =>
			route.fulfill({
				path: resolve("public/nova-icons/record_vitals.png"),
				contentType: "image/png",
			}),
		);
		const main = await openNavigation(page, {
			fixture: "search-first",
			platform: "android",
		});
		await main
			.getByRole("button", { name: `Continue with ${FIRST_CASE}` })
			.click({ timeout: 20_000 });
		// A menu's command names no entry, so CommCare asks for a command
		// (`CommCareSession.getNeededData`), and Android lists the menu.
		await expect(main.locator("[data-form-menu-choice-label]")).toHaveText([
			"Visit",
		]);
		await expect(main.getByRole("button", { name: "Finish" })).toHaveCount(0);
		const grid = main.locator('[data-menu-layout="grid"]');
		const icon = grid
			.getByRole("button", { name: "Visit", exact: true })
			.locator("img");
		await expect(icon).toHaveAttribute("src", /record_vitals\.png$/);
		expect(
			await icon.evaluate(async (image) => {
				if (!(image instanceof HTMLImageElement))
					throw new Error("The form command must show an image.");
				await image.decode();
				return image.naturalWidth;
			}),
		).toBeGreaterThan(0);
		await main.getByRole("button", { name: "Visit", exact: true }).click();
		await expect(main.getByRole("textbox", { name: /Note$/ })).toBeVisible({
			timeout: 20_000,
		});
	} finally {
		await closeNavigation(page);
	}
});

test("in Web Apps a case chosen from the entry shows its details, and Continue shows the list again", async ({
	page,
}) => {
	try {
		const main = await openNavigation(page, {
			fixture: "case-list-entry",
			platform: "web-apps",
			details: true,
		});
		await main.locator("[data-case-list-menu-entry]").click({
			timeout: 20_000,
		});
		const details = main.getByRole("button", {
			name: `View details for ${FIRST_CASE}`,
		});
		await details.click({ timeout: 20_000 });
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(details).toBeVisible();
		await expect(page.getByLabel("Location")).toHaveText("cases");
		await expect(main.locator("[data-case-detail-done]")).toHaveCount(0);
	} finally {
		await closeNavigation(page);
	}
});

test("on Android a case chosen from the entry with no details returns to the phone's home screen, on a new session", async ({
	page,
}) => {
	try {
		const main = await openNavigation(page, {
			fixture: "case-list-entry",
			platform: "android",
		});
		const session = page.getByLabel("Preview session");
		const running = await session.textContent();
		await main.locator("[data-case-list-menu-entry]").click({
			timeout: 20_000,
		});
		await main
			.getByRole("button", { name: `Continue with ${FIRST_CASE}` })
			.click({ timeout: 20_000 });
		await expect(page.getByLabel("At the device home")).toHaveText("true");
		await expect(page.getByLabel("Location")).toHaveText("home");
		// The home screen resets Android's session
		// (`HomeScreenBaseActivity.processCanceledGetCommandOrCase`): a step
		// the browser's history kept from the old one no longer stands.
		await expect(session).not.toHaveText(running ?? "");
		const reset = await session.textContent();
		// Start opens the app on that new session.
		await main.getByRole("button", { name: "Start", exact: true }).click();
		await expect(page.getByLabel("At the device home")).toHaveText("false");
		await expect(session).toHaveText(reset ?? "");
	} finally {
		await closeNavigation(page);
	}
});

test("on Android a case chosen from the entry shows its details, and Done returns to the list", async ({
	page,
}) => {
	try {
		const main = await openNavigation(page, {
			fixture: "case-list-entry",
			platform: "android",
			details: true,
		});
		await main.locator("[data-case-list-menu-entry]").click({
			timeout: 20_000,
		});
		const details = main.getByRole("button", {
			name: `View details for ${FIRST_CASE}`,
		});
		await details.click({ timeout: 20_000 });
		const done = main.locator("[data-case-detail-done]");
		await expect(done).toHaveText("Done");
		await done.click();
		await expect(details).toBeVisible();
		await expect(page.getByLabel("At the device home")).toHaveText("false");
	} finally {
		await closeNavigation(page);
	}
});
