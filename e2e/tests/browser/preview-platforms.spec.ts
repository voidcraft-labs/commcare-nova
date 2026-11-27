import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import sharp from "sharp";
import type { submitFormAction } from "@/lib/preview/engine/caseDataBinding";
import type { SubmissionResult } from "@/lib/preview/engine/caseDataBindingTypes";
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

function openPlatformsPeer(browserDefines?: Readonly<Record<string, string>>) {
	const boundary = resolve("e2e/lib/preview-section-paging-boundary.ts");
	return componentPeer(
		"e2e/lib/preview-platforms-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/formOpeningAction": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
			"@/lib/deployment/actions": boundary,
			"@/lib/doc/platformChangePreflight": boundary,
			"@/lib/preview/app-tests/actions": boundary,
		},
		browserDefines,
	);
}

test.beforeAll(async () => {
	platformsPeer = await openPlatformsPeer();
	searchPeer = await componentPeer("e2e/lib/preview-search-client.tsx");
	const navigation = resolve("e2e/lib/preview-navigation-boundary.ts");
	navigationPeer = await componentPeer(
		"e2e/lib/preview-navigation-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": navigation,
			"@/lib/preview/engine/formOpeningAction": navigation,
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
async function acceptAttachments(page: Page, contentType = "image/png") {
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
						uploadContentType: contentType,
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

async function photoSize(page: Page, android: boolean) {
	await openScenario(
		page,
		android ? "image-size-android" : "image-size-web-apps",
	);
	await acceptAttachments(page, "image/jpeg");
	const original = await sharp("proof/core/captures/proof-image.jpg")
		.withExif({
			IFD0: {
				Orientation: "6",
				ImageDescription: "Synthetic visit",
				Make: "Private camera make",
			},
		})
		.withMetadata({ orientation: 6 })
		.jpeg()
		.toBuffer();
	const sent = page.waitForRequest(
		(request) =>
			request.method() === "PUT" && request.url().endsWith("/capture-upload"),
	);
	await page
		.getByRole("button", {
			name: android ? /^Choose image/ : "Photo Attach file",
		})
		.setInputFiles({
			name: "visit.jpg",
			mimeType: "image/jpeg",
			buffer: original,
		});
	const uploaded = (await sent).postDataBuffer();
	expect(uploaded).toBeTruthy();
	if (!uploaded) throw new Error("The capture upload had no bytes.");
	if (android) {
		const metadata = await sharp(uploaded).metadata();
		expect(metadata).toMatchObject({
			format: "jpeg",
			width: 15,
			height: 11,
			orientation: 6,
		});
		expect(metadata.exif?.includes(Buffer.from("Synthetic visit"))).toBe(true);
		expect(metadata.exif?.includes(Buffer.from("Private camera make"))).toBe(
			false,
		);
	} else expect(uploaded).toEqual(original);
	await expect.poll(() => answer(page, PLATFORM_IDS.image)).toBe("large.png");
}

async function checkDatetimePicker(
	page: Page,
	platform: "android" | "web-apps",
) {
	await openScenario(page, `datetime-picker-${platform}`);
	const clock = page.getByRole("textbox", { name: "Time", exact: true });
	await expect(clock).toBeVisible();
	const applied = await page.evaluate(
		(uuid) =>
			window.previewPlatforms.setAnswer(uuid, "2025-11-02T06:24:47.125Z"),
		PLATFORM_IDS.datetime,
	);
	expect(applied).toBe(true);
	await expect(
		page.getByRole("button", { name: "Date", exact: true }),
	).toContainText(
		platform === "android" ? "November 1, 2025" : "November 2, 2025",
	);
	if (platform === "android") {
		await expect(clock).toHaveValue("11:24 PM");
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await expect(
			page.getByRole("textbox", { name: /Review visit/ }),
		).toBeVisible();
		await expect
			.poll(() => answer(page, PLATFORM_IDS.datetime))
			.toBe("2025-11-01T23:24:00.000-07:00");
		await page.getByRole("button", { name: "Back", exact: true }).click();
	} else {
		await expect(clock).toHaveValue(/06:24:47\.125/);
	}
	await clock.fill("11:26:48 PM");
	await clock.press("Tab");
	await expect
		.poll(() => answer(page, PLATFORM_IDS.datetime))
		.toBe(
			platform === "android"
				? "2025-11-01T23:26:00.000-07:00"
				: "2025-11-02T23:26:48.000-08:00",
		);
	if (platform === "android") {
		await page.getByRole("button", { name: "Date", exact: true }).click();
		await page.locator('button[data-day="11/2/2025"]').click();
		await expect
			.poll(() => answer(page, PLATFORM_IDS.datetime))
			.toBe("2025-11-02T23:26:00.000-08:00");
	}
}

const PREVIEW_PLATFORM_CHECKS: Readonly<
	Record<PreviewPlatformScenarioId, (page: Page) => Promise<void>>
> = {
	"datetime-picker-android": (page) => checkDatetimePicker(page, "android"),
	"datetime-picker-web-apps": (page) => checkDatetimePicker(page, "web-apps"),
	async "face-photo-android"(page) {
		await page.addInitScript(() => {
			const streams: MediaStream[] = [];
			Object.defineProperty(window, "photoTestStreams", { value: streams });
			Object.defineProperty(window, "FaceDetector", {
				value: undefined,
				configurable: true,
			});
			Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
				value: async () => {
					const canvas = document.createElement("canvas");
					canvas.width = 800;
					canvas.height = 600;
					const stream = canvas.captureStream(0);
					const track =
						stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
					const context = canvas.getContext("2d");
					if (!context) throw new Error("The test sensor needs a canvas.");
					context.fillStyle = "blue";
					const render = () => {
						if (track.readyState !== "live") return;
						context.fillRect(0, 0, canvas.width, canvas.height);
						track.requestFrame();
						requestAnimationFrame(render);
					};
					render();
					streams.push(stream);
					return stream;
				},
			});
		});
		await acceptAttachments(page);
		await openScenario(page, "face-photo-android");
		await expect(
			page.getByRole("button", { name: "Choose image" }),
		).toHaveCount(0);
		const open = page
			.getByRole("button", { name: "Take picture", exact: true })
			.and(page.locator('[aria-haspopup="dialog"]'));
		await open.click();
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByRole("button", { name: "Take picture" }),
		).toBeEnabled();
		await dialog.getByRole("button", { name: "Switch camera" }).click();
		await expect(
			dialog.getByRole("button", { name: "Take picture" }),
		).toBeEnabled();
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();
		const closed = () =>
			page.evaluate(() => {
				const streams =
					(window as Window & { photoTestStreams?: MediaStream[] })
						.photoTestStreams ?? [];
				return streams.map((s) => s.getVideoTracks()[0]?.readyState);
			});
		await expect.poll(closed).toEqual(["ended", "ended"]);
		await open.click();
		const pending = page.waitForRequest((request) =>
			request.url().endsWith("/capture-upload"),
		);
		await dialog.getByRole("button", { name: "Take picture" }).click();
		const bytes = (await pending).postDataBuffer();
		if (!bytes) throw new Error("The submitted photo held no bytes.");
		const sizeOf = (input: Buffer) =>
			page.evaluate(async (base64) => {
				const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
				const image = await createImageBitmap(
					new Blob([data], { type: "image/jpeg" }),
				);
				try {
					return [image.width, image.height];
				} finally {
					image.close();
				}
			}, input.toString("base64"));
		expect(await sizeOf(bytes)).toEqual([660, 580]);
		await expect(dialog).toBeHidden();
		await expect.poll(closed).toEqual(["ended", "ended", "ended"]);
		await page.evaluate(() => {
			let observation = 0;
			class PreviewCameraDetector {
				async detect() {
					observation++;
					if (observation === 1) return [];
					const x = observation === 2 ? 100 : 300;
					return [{ boundingBox: new DOMRect(x, 200, 120, 100) }];
				}
			}
			Object.defineProperty(window, "FaceDetector", {
				value: PreviewCameraDetector,
			});
		});
		const detected = page.waitForRequest((request) =>
			request.url().endsWith("/capture-upload"),
		);
		await open.click();
		const detectedBytes = (await detected).postDataBuffer();
		if (!detectedBytes) throw new Error("The face camera sent no photo.");
		expect(await sizeOf(detectedBytes)).toEqual([140, 200]);
		await expect.poll(closed).toEqual(["ended", "ended", "ended", "ended"]);
	},
	async "face-photo-web-apps"(page) {
		await acceptAttachments(page);
		await openScenario(page, "face-photo-web-apps");
		await expect(
			page.getByRole("button", { name: "Take picture" }),
		).toHaveCount(0);
		const uploaded = page.waitForRequest((request) =>
			request.url().endsWith("/capture-upload"),
		);
		await page.locator('input[type="file"]').setInputFiles({
			name: "portrait.png",
			mimeType: "image/png",
			buffer: PIXEL,
		});
		expect((await uploaded).postDataBuffer()).toEqual(PIXEL);
	},
	async "visit-display-web-apps"(page) {
		await openScenario(page, "visit-display-web-apps");
		const question = (id: string) =>
			page.locator(`[data-instance-path$="/${id}"]`);
		await expect(question("pin").getByRole("textbox")).toHaveAttribute(
			"type",
			"text",
		);
		await question("pin").getByRole("textbox").fill("007");
		/* Web Apps' address search: with no map provider set up, Preview
		 * makes up no address, and it names what the project space needs. */
		const address = question("address").getByRole("textbox");
		await expect(address).toHaveAttribute("readonly", "");
		await expect(address).toHaveValue("");
		await expect(question("address")).toContainText(
			"Preview can search for addresses once a map provider is set up.",
		);
		await expect(question("address")).toContainText("Geocoder plan feature");
		/* Web Apps ignores a compact group: the hint shows under its label. */
		await expect(question("people")).toContainText("Count adults and children");
		await expect(question("place").getByRole("textbox")).toHaveAttribute(
			"placeholder",
			"Building name",
		);
		await expect(page.getByText("Ask the driver", { exact: true })).toHaveCount(
			0,
		);
		const route = question("route").getByRole("combobox");
		await route.fill("val");
		await expect(
			page.getByRole("option", { name: "North valley" }),
		).toHaveCount(0);
		await route.fill("valley");
		await page.getByRole("option", { name: "Upper valley" }).click();
		await expect(route).toHaveValue("Upper valley");
		const market = question("market").getByRole("combobox");
		await market.fill("Nortt");
		await page
			.getByRole("option", { name: "North valley", exact: true })
			.click();
		await expect(market).toHaveValue("North valley");
		const stage = question("stage").getByRole("button");
		await expect(stage).toContainText("North valley");
		await stage.click();
		await expect(stage).toContainText("Upper valley");
		await expect(question("rating").getByRole("radio")).toHaveCount(3);
		await expect(
			question("rating").getByText("North valley", { exact: true }),
		).toBeVisible();
		await expect(
			question("change_day").getByRole("button", {
				name: "Clear",
				exact: true,
			}),
		).toHaveCount(0);
		await expect(question("supplies").getByRole("checkbox")).toHaveCount(3);
		await expect(question("signature_photo").locator("canvas")).toBeVisible();
		for (const id of ["photo", "voice", "clip"]) {
			await expect(question(id).locator("input[type=file]")).toHaveCount(1);
			await expect(
				question(id).locator("input[type=file][capture]"),
			).toHaveCount(0);
		}
		await expect(question("ready")).toContainText("Ready");
		await expect(question("absent")).toContainText("Device note");
		await expect(page.locator("[data-question-banner]")).toHaveCount(0);
		await expect(question("address_line")).toHaveCount(0);
		await page.getByRole("button", { name: /Expand.*Visit details/i }).click();
		await expect(question("address_line").getByRole("textbox")).toBeVisible();
	},
	async "visit-display-android"(page) {
		await openScenario(page, "visit-display-android");
		const question = (id: string) =>
			page.locator(`[data-instance-path$="/${id}"]`);
		await expect(question("pin").locator("input")).toHaveAttribute(
			"type",
			"password",
		);
		await expect(question("address").locator("input")).toHaveAttribute(
			"type",
			"password",
		);
		await expect(question("address")).not.toContainText("Geocoder");
		/* A number question under a compact group: its label's one line
		 * beside the answer box, with no hint. */
		const people = question("people");
		await expect(people.locator("[data-android-compact]")).toHaveCount(1);
		await expect(people).not.toContainText("Count adults and children");
		const label = await people
			.getByText("People at the visit", { exact: true })
			.boundingBox();
		const box = await people.locator("input").boundingBox();
		if (label === null || box === null)
			throw new Error("Expected the compact question's label and answer box.");
		expect(box.x).toBeGreaterThan(label.x);
		expect(
			Math.abs(box.y + box.height / 2 - (label.y + label.height / 2)),
		).toBeLessThan(box.height);
		await expect(question("place").getByRole("textbox")).not.toHaveAttribute(
			"placeholder",
			"Building name",
		);
		await expect(question("place")).toContainText("Building name");
		await expect(question("departure")).toContainText("Ask the driver");
		const short = question("code").getByRole("textbox");
		await short.focus();
		await expect(short).toHaveAttribute("enterkeyhint", "next");
		await short.press("Enter");
		await expect(question("address_line").getByRole("textbox")).toBeFocused();
		const route = question("route").getByRole("combobox");
		await route.fill("val");
		await expect(
			page.getByRole("option", { name: "North valley" }),
		).toBeVisible();
		await route.fill("beyond all choices");
		await expect(route).toHaveValue("val");
		await page.getByRole("option", { name: "North valley" }).click();
		await expect(route).toHaveValue("North valley");
		await question("route")
			.getByRole("button", { name: "Clear", exact: true })
			.click();
		await expect(route).toHaveValue("");
		await expect(question("stage").getByRole("radio")).toHaveCount(3);
		await expect(question("rating").getByRole("radio")).toHaveCount(3);
		const tiles = question("rating").getByRole("radio");
		await expect(tiles.nth(0)).toHaveAccessibleName("North valley");
		await expect(
			question("rating").getByText("North valley", { exact: true }),
		).toHaveCount(0);
		const calendar = question("change_day");
		const clearDay = calendar.getByRole("button", {
			name: "Clear",
			exact: true,
		});
		const dayPicker = calendar.getByRole("button", {
			name: /^Question \d+\. Change day$/,
		});
		await expect(clearDay).toBeEnabled();
		expect(await answer(page, PLATFORM_IDS.changeDay)).toBe("");
		await clearDay.click();
		await expect(clearDay).toBeDisabled();
		await expect(dayPicker).toHaveText("Pick a date");
		await dayPicker.press("Enter");
		await page
			.getByRole("button", { pressed: false })
			.filter({ hasText: /^1$/ })
			.click();
		await expect(clearDay).toBeEnabled();
		await expect
			.poll(() => answer(page, PLATFORM_IDS.changeDay))
			.toMatch(/^\d{4}-\d{2}-01$/);
		await clearDay.click();
		await expect(clearDay).toBeDisabled();
		await expect.poll(() => answer(page, PLATFORM_IDS.changeDay)).toBe("");
		await expect(question("signature_photo").locator("canvas")).toHaveCount(0);
		await expect(page.locator('[data-question-banner="good"]')).toHaveText(
			"Ready; Check",
		);
		await expect(question("absent")).toHaveCount(0);
		await expect(question("address_line").getByRole("textbox")).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Expand.*Visit details/i }),
		).toHaveCount(0);
		expect(await answer(page, PLATFORM_IDS.returnDay)).toBe("");
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await expect(page.getByText("Review this visit")).toBeVisible();
		expect(await answer(page, PLATFORM_IDS.changeDay)).toBe("");
		await expect
			.poll(() => answer(page, PLATFORM_IDS.returnDay))
			.toMatch(/^\d{4}-\d{2}-\d{2}$/);
		await page.getByRole("button", { name: "Back", exact: true }).click();
		await expect(clearDay).toBeEnabled();
		expect(await answer(page, PLATFORM_IDS.changeDay)).toBe("");
	},
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
	async "image-size-web-apps"(page) {
		await photoSize(page, false);
	},
	async "image-size-android"(page) {
		await photoSize(page, true);
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
		await expect(page.getByText("Details", { exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: /Inside/ })).toBeVisible();
		/* A group is collapsible in Web Apps only where it asks to be
		 * (`form_ui.js`, `collapsible`), and this one does not. */
		await expect(page.getByRole("button", { name: /Details/ })).toHaveCount(0);
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
		/* The repeat opens with no entry: the first is the worker's. */
		const first = page.getByRole("alertdialog", { name: "Add a new Visits?" });
		await expect(first).toBeVisible();
		await first
			.getByRole("button", { name: "Add a new Visits?", exact: true })
			.click();
		await expect(header).toHaveText("Visits (1) > Details", {
			useInnerText: true,
		});
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
		await expect(header).toHaveText("Visits (2) > Details", {
			useInnerText: true,
		});
	},
	async "label-texts-android"(page) {
		/* The browser's speech, recorded: what it was asked to read and when
		 * it was told to stop. */
		await page.addInitScript(() => {
			const calls: string[] = [];
			Object.defineProperty(window, "speechCalls", { value: calls });
			Object.defineProperty(window, "SpeechSynthesisUtterance", {
				configurable: true,
				value: class extends EventTarget {
					constructor(readonly text: string) {
						super();
					}
				},
			});
			Object.defineProperty(window, "speechSynthesis", {
				configurable: true,
				value: {
					speak(utterance: SpeechSynthesisUtterance) {
						calls.push(`speak:${utterance.text}`);
					},
					cancel() {
						calls.push("cancel");
					},
				},
			});
		});
		const speech = () =>
			page.evaluate(
				() => (window as unknown as { speechCalls: string[] }).speechCalls,
			);
		await openScenario(page, "label-texts-android");
		await expect(
			page.getByText("Full name of the person", { exact: true }),
		).toBeVisible();
		await expect(page.locator("[data-label-qr-code]")).toContainText(
			"household-12",
		);
		await page.getByRole("button", { name: /^Read aloud/ }).click();
		await expect.poll(speech).toEqual(["cancel", "speak:Say the full name"]);
		/* Web Apps has no speaker button; the reading it started stops with it. */
		await page.evaluate(() => window.previewPlatforms.setPlatform("web-apps"));
		await expect(page.getByRole("button", { name: /^Read aloud/ })).toHaveCount(
			0,
		);
		await expect
			.poll(speech)
			.toEqual(["cancel", "speak:Say the full name", "cancel"]);
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
		/* Every element the page plays, kept so the test can read it after the
		 * screen that started it has gone. */
		await page.addInitScript(() => {
			const started: HTMLMediaElement[] = [];
			Object.assign(window, { __startedMedia: started });
			const play = HTMLMediaElement.prototype.play;
			HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
				started.push(this);
				return play.call(this);
			};
		});
		const run = await openScenario(page, "menu-grid-android");
		const grid = page.locator('[data-menu-layout="grid"]');
		const tile = grid.getByRole("button", { name: /^Visits/ });
		await expect(grid.locator("audio")).toHaveAccessibleName("Visits");
		const heard = () =>
			page.evaluate(() =>
				(
					(window as unknown as { __startedMedia: HTMLMediaElement[] })
						.__startedMedia ?? []
				).some(
					// A player taken out of the page is paused there; one that
					// keeps playing is still going or has reached its end.
					(el) => el.played.length > 0 && (!el.paused || el.ended),
				),
			);
		await tile.hover();
		await page.mouse.down();
		try {
			await expect.poll(heard).toBe(true);
			// The hold alone opens nothing.
			expect(page.url()).not.toContain(PLATFORM_IDS.module);
		} finally {
			await page.mouse.up();
		}
		/* Android delivers the tap when the worker lets go of a tile it held,
		 * so the menu opens while its label keeps playing. This page mounts
		 * Home alone, so the opening shows as the builder's location moving
		 * to the menu. */
		await expect.poll(() => page.url()).toContain(PLATFORM_IDS.module);
		expect(await heard()).toBe(true);
		expect(
			run.mediaRequests.some((path) => path.includes(PLATFORM_IDS.menuSound)),
		).toBe(true);
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
	async "android-app-answers"(page) {
		await acceptAttachments(page);
		const upload = Promise.withResolvers<void>();
		await page.route(
			`${platformsPeer.origin}/capture-upload`,
			async (route) => {
				await upload.promise;
				await route.fallback();
			},
		);
		await openScenario(page, "android-app-answers");
		const buttons = page.getByRole("button", { name: "Open Android app" });
		const dialog = page.getByRole("dialog");
		await buttons.first().click();
		await expect(dialog.getByText("prior", { exact: true })).toBeVisible();
		await expect(dialog.getByText("litres")).toBeVisible();
		await expect(dialog.getByText("gallons")).toHaveCount(0);
		await dialog
			.getByRole("checkbox", { name: "Return an answer to Meter" })
			.check();
		await dialog
			.getByRole("textbox", { name: "Meter", exact: true })
			.fill("captured");
		await dialog.getByRole("checkbox", { name: "Return quantity" }).check();
		await dialog
			.getByRole("textbox", { name: "quantity", exact: true })
			.fill("008");
		await dialog.getByRole("checkbox", { name: "Return photo" }).check();
		await dialog.getByLabel("File for photo").setInputFiles({
			name: "meter.png",
			mimeType: "image/png",
			buffer: PIXEL,
		});
		try {
			await dialog.getByRole("button", { name: "Return to form" }).click();
			await expect(
				dialog.getByRole("button", { name: "Cancel", exact: true }),
			).toBeDisabled();
			await page.keyboard.press("Escape");
			await expect(dialog).toBeVisible();
		} finally {
			upload.resolve();
		}
		await expect(page.getByText("captured", { exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: /Quantity$/ })).toHaveValue(
			"8",
		);
		await expect(
			page.getByRole("textbox", { name: /Reading as text$/ }),
		).toHaveValue("008");
		await expect(page.getByText("large.png", { exact: true })).toBeVisible();
		await buttons.nth(1).click();
		await expect(dialog.getByText("7", { exact: true })).toBeVisible();
		await dialog
			.getByRole("checkbox", { name: "Return an answer to Check meter" })
			.check();
		await dialog
			.getByRole("textbox", { name: "Check meter", exact: true })
			.fill("009");
		await dialog.getByRole("button", { name: "Return to form" }).click();
		await expect(page.getByText("9", { exact: true })).toBeVisible();
		await expect(page.getByText("captured", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await expect(page.getByRole("textbox", { name: /Quantity$/ })).toHaveValue(
			"5",
		);
		await expect(
			page.getByRole("textbox", { name: /Reading as text$/ }),
		).toHaveValue("five");
		await expect(page.getByText("large.png", { exact: true })).toHaveCount(0);
		await buttons.first().click();
		await expect(dialog.getByText("prior", { exact: true })).toBeVisible();
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	},
	async "android-app-required"(page) {
		const submissions: Parameters<typeof submitFormAction>[] = [];
		await page.route(`${platformsPeer.origin}/submission`, async (route) => {
			submissions.push(route.request().postDataJSON());
			await route.fulfill({
				json: {
					kind: "survey",
					caseDatabasePatch: { rows: [], indices: [] },
				} satisfies SubmissionResult,
			});
		});
		await openScenario(page, "android-app-required");
		const open = page.getByRole("button", { name: "Open Android app" });
		const dialog = page.getByRole("dialog");
		await open.click();
		await dialog
			.getByRole("checkbox", { name: "Return an answer to Meter" })
			.check();
		await dialog
			.getByRole("textbox", { name: "Meter", exact: true })
			.fill("completed");
		await dialog.getByRole("button", { name: "Return to form" }).click();
		await open.click();
		await expect(dialog.getByText("completed", { exact: true })).toBeVisible();
		await dialog.getByRole("combobox", { name: "Result type" }).click();
		await page.getByRole("option", { name: "Identity registration" }).click();
		await dialog.getByLabel("Sample template for face").setInputFiles({
			name: "sample.bin",
			mimeType: "application/octet-stream",
			buffer: Buffer.alloc(1024 * 1024),
		});
		await dialog.getByRole("button", { name: "Return to form" }).click();
		await expect(dialog.getByRole("alert")).toContainText(
			"too large for one Android result",
		);

		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect.poll(() => answer(page, PLATFORM_IDS.meter)).toBe("completed");
		const finish = page.getByRole("button", { name: "Finish", exact: true });
		await finish.click();
		await expect.poll(() => submissions.length).toBe(1);
		expect(submissions[0]?.[0]).toMatchObject({
			kind: "survey",
			formUuid: PLATFORM_IDS.form,
		});
		await openScenario(page, "android-app-required");
		await open.click();
		await dialog
			.getByRole("checkbox", { name: "Return an answer to Meter" })
			.check();
		await dialog
			.getByRole("textbox", { name: "Meter", exact: true })
			.fill("another result");
		await dialog.getByRole("button", { name: "Return to form" }).click();
		await expect
			.poll(() => answer(page, PLATFORM_IDS.meter))
			.toBe("another result");
		await open.click();
		await dialog.getByRole("button", { name: "Return to form" }).click();
		await expect.poll(() => answer(page, PLATFORM_IDS.meter)).toBe("");
		await finish.click();
		await expect(open).toBeVisible();
		await page.evaluate(() => window.previewPlatforms.settled());
		expect(submissions).toHaveLength(1);
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
		/* Where the browser cannot scan, typing stands in for the scan. */
		await page.getByRole("textbox", { name: /Code/ }).fill("BC-8");
		await expect.poll(() => answer(page, PLATFORM_IDS.code)).toBe("BC-8");
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
		/* Android takes the scanned text alone: this question does not let the
		 * worker edit it (`BarcodeWidget.java`, `editable`). */
		await expect(
			page.getByRole("textbox", { name: /Code/ }),
		).not.toBeEditable();
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
		/* The repeat opens with no entry: the first is the worker's. */
		const addNew = page.getByRole("alertdialog", {
			name: "Add a new Visits?",
		});
		await expect(addNew).toBeVisible();
		await addNew
			.getByRole("button", { name: "Add a new Visits?", exact: true })
			.click();
		await expect(header).toHaveText("Visits (1) > Details", {
			useInnerText: true,
		});
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
		await expect(header).toHaveText("Visits (1) > Details", {
			useInnerText: true,
		});
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
		await expect(header).toHaveText("Visits (1) > Details", {
			useInnerText: true,
		});
		await next.click();
		await expect(prompt).toBeVisible();
		/* A group shown on one screen inside a repeat is one screen per
		 * entry. */
		await addAnother.click();
		await expect(header).toHaveText("Visits (2) > Details", {
			useInnerText: true,
		});
		await expect(note).toHaveValue("");
		await next.click();
		await expect(prompt).toBeVisible();
		await prompt
			.getByRole("button", { name: "Do not add", exact: true })
			.click();
		/* A group shown on one screen is one screen of all its questions. */
		await expect(header).toHaveText("Household", { useInnerText: true });
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
		const firstItem = page.getByRole("alertdialog", {
			name: "Add a new Items?",
		});
		await expect(firstItem).toBeVisible();
		await firstItem
			.getByRole("button", { name: "Add a new Items?", exact: true })
			.click();
		await expect(header).toHaveText("Stock > Items (1)", {
			useInnerText: true,
		});
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
	const addCheck = () => {
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
	};
	if (scenario.fixture === "datetime-picker") {
		test.describe("worker date and time", () => {
			test.use({ timezoneId: "America/Los_Angeles" });
			addCheck();
		});
	} else {
		addCheck();
	}
}

test("Web Apps address search commits only the current choice and updates the form receiver", async ({
	page,
}) => {
	const peer = await openPlatformsPeer({
		"process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY": JSON.stringify("proof-key"),
		"process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID": JSON.stringify("proof-map"),
	});
	try {
		// Supply only the external Places library. The address control, receiver and XPath worker run unmodified.
		await page.addInitScript(() => {
			const pending = Promise.withResolvers<void>();
			let deferRiver = true;
			Reflect.set(window, "finishOldPlace", pending.resolve);
			Reflect.set(window, "google", {
				maps: {
					async importLibrary(name: string) {
						if (name !== "places")
							throw new Error(`Unexpected Maps library ${name}`);
						return {
							AutocompleteSessionToken: class {},
							AutocompleteSuggestion: {
								async fetchAutocompleteSuggestions({
									input,
								}: {
									input: string;
								}) {
									const river = input.startsWith("River");
									const street = river ? "River Road" : "Harbor Way";
									const city = river ? "River Town" : "Harbor Town";
									return {
										suggestions: [
											{
												placePrediction: {
													placeId: street,
													text: { text: street },
													toPlace: () => ({
														async fetchFields() {
															if (river && deferRiver) {
																deferRiver = false;
																Reflect.set(window, "oldPlaceRequested", true);
																await pending.promise;
															}
														},
														formattedAddress: `18 ${street}, ${city}`,
														location: { lat: () => -1.9, lng: () => 35.12 },
														addressComponents: [
															{
																longText: city,
																shortText: city,
																types: ["locality"],
															},
														],
													}),
												},
											},
										],
									};
								},
							},
						};
					},
				},
			});
		});
		await page.goto(`${peer.origin}/?scenario=visit-display-web-apps`);
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible({ timeout: 20_000 });
		const address = page.getByRole("combobox", {
			name: "Private meeting place",
		});
		const city = page.locator('[data-instance-path$="/city"] input');
		const cityCopy = () => answer(page, PLATFORM_IDS.addressCityCopy);
		const storedAddress = () => answer(page, PLATFORM_IDS.address);
		const choose = async (query: string, choice: string) => {
			await address.fill(query);
			await page.getByRole("option", { name: choice, exact: true }).click();
		};

		await choose("River", "River Road");
		await expect
			.poll(() => page.evaluate(() => Reflect.get(window, "oldPlaceRequested")))
			.toBe(true);
		await address.fill("Harbor");
		await page.evaluate(() => Reflect.get(window, "finishOldPlace")());
		await expect(address).toHaveValue("Harbor");
		await expect(city).toHaveValue("");
		await page.getByRole("option", { name: "Harbor Way", exact: true }).click();
		await expect(address).toHaveValue("18 Harbor Way, Harbor Town");
		await expect(city).toHaveValue("Harbor Town");
		await expect.poll(cityCopy).toBe("Harbor Town");
		expect(JSON.parse((await storedAddress()) ?? "")).toMatchObject({
			city: "Harbor Town",
		});

		await address.fill("River");
		await expect.poll(storedAddress).toBe("");
		await expect(city).toHaveValue("Harbor Town");
		await page.getByRole("option", { name: "River Road", exact: true }).click();
		await expect.poll(cityCopy).toBe("River Town");
		await page.getByRole("button", { name: "Clear the address" }).click();
		await expect(address).toHaveValue("");
		await expect(city).toHaveValue("");
		await expect.poll(cityCopy).toBe("");
		await expect.poll(storedAddress).toBe("");
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(async () => {
					Reflect.get(window, "finishOldPlace")?.();
					await window.previewPlatforms?.dispose();
				});
		} finally {
			await peer.close();
		}
	}
});

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
