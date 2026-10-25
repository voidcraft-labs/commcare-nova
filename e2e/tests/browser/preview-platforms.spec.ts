import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-platforms-client";
import type {} from "../../lib/preview-search-client";
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
 */

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

let platformsPeer: Awaited<ReturnType<typeof componentPeer>>;
let searchPeer: Awaited<ReturnType<typeof componentPeer>>;

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
			"@/lib/preview/app-tests/actions": boundary,
		},
	);
	searchPeer = await componentPeer("e2e/lib/preview-search-client.tsx");
});
test.afterAll(async () => {
	await platformsPeer?.close();
	await searchPeer?.close();
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
		mediaRequests.push(new URL(route.request().url()).pathname);
		await route.fulfill({ body: PIXEL, contentType: "image/png" });
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
	 * too. */
	await expect(showHelp).toHaveCount(platform === "web-apps" ? 1 : 2);
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
	/* The file input is named by its question's label and its action. */
	await expect(
		page.getByLabel(new RegExp(`${label}.*Attach file`)),
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
		await openScenario(page, "barcode-scan-android");
		/* Chromium here has no BarcodeDetector: the line stands in for Scan. */
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
		/* A labeled group inside a repeat is one screen per entry. */
		await addAnother.click();
		await expect(header).toHaveText("Visits (2) > Details");
		await expect(note).toHaveValue("");
		await next.click();
		await expect(prompt).toBeVisible();
		await prompt
			.getByRole("button", { name: "Do not add", exact: true })
			.click();
		/* A labeled group is one screen of all its questions. */
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
		/* A repeat the worker adds to inside a labeled group is part of the
		 * group's screen: no prompt and no add control. */
		await next.click();
		await expect(header).toHaveText("Stock");
		await expect(page.getByRole("textbox", { name: /Item/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /^Add / })).toHaveCount(0);
		await next.click();
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
