import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-search-client";

test("Search calendars follow the worker language while authoring defaults and date answers remain intact", async ({
	page,
}, testInfo) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	try {
		await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
		await page.goto(`${peer.origin}/?language`);
		await page.getByLabel("Patient name").fill("Ada");
		const from = page.getByLabel("Registered from");
		const to = page.getByLabel("Registered to");
		await from.click();
		await page.getByRole("button", { name: /January 2nd, 2024/ }).click();
		await page.getByRole("button", { name: "Español", exact: true }).click();
		await expect(from).toHaveText("2 de enero de 2024");
		await expect(to).toHaveText("Elegir una fecha");
		await expect(page.getByLabel("Authoring date")).toHaveText(
			"January 15, 2024",
		);
		await from.click();
		await expect(page.getByRole("grid")).toHaveAccessibleName(/enero.*2024/);
		await expect(
			page.getByRole("button", { name: "Ir al mes anterior" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Ir al mes siguiente" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: "martes, 2 de enero de 2024, seleccionado",
				exact: true,
			}),
		).toHaveAccessibleName(/seleccionado/);
		await page.keyboard.press("Escape");
		await to.click();
		await page.getByRole("button", { name: /31 de enero de 2024/ }).click();
		await page.getByRole("button", { name: "English UK", exact: true }).click();
		await expect(from).toHaveText("2 January 2024");
		await expect(to).toHaveText("31 January 2024");
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect
			.poll(async () =>
				JSON.parse(await page.getByLabel("Submitted search").innerText()),
			)
			.toEqual({
				case_name: "Ada",
				"registered:from": "2024-01-02",
				"registered:to": "2024-01-31",
			});
		await page.getByRole("button", { name: "Español", exact: true }).click();
		await from.click();
		await page.getByRole("button", { name: "Borrar", exact: true }).click();
		await expect(from).toHaveText("Elegir una fecha");
		await expect(to).toHaveText("31 de enero de 2024");
		await page.getByLabel("Authoring date").click();
		await expect(
			page.getByRole("button", { name: "Go to the Next Month" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Clear", exact: true }),
		).toBeVisible();
	} catch (error) {
		const snapshot = testInfo.outputPath("worker-search-language-aria.txt");
		await writeFile(snapshot, await page.locator("body").ariaSnapshot());
		await testInfo.attach("worker-search-language-accessibility", {
			path: snapshot,
			contentType: "text/plain",
		});
		const screenshot = testInfo.outputPath("worker-search-language.png");
		await page.screenshot({ path: screenshot, fullPage: true });
		await testInfo.attach("worker-search-language-failure", {
			path: screenshot,
			contentType: "image/png",
		});
		throw error;
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewSearchAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});

test("Search date ranges remain usable on a narrow screen and submit the actual calendar selections", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	try {
		await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
		await page.setViewportSize({ width: 320, height: 640 });
		await page.goto(peer.origin);
		await page.getByLabel("Patient name").fill("Ada");
		const from = page.getByLabel("Registered from"),
			to = page.getByLabel("Registered to");
		const fromBox = await from.boundingBox(),
			toBox = await to.boundingBox();
		if (!fromBox || !toBox) throw new Error("Missing date range controls");
		expect(toBox.y).toBeGreaterThan(fromBox.y + fromBox.height);
		expect(fromBox.height).toBeGreaterThanOrEqual(44);
		await from.click();
		const calendar = page.getByRole("grid");
		await expect(calendar).toBeVisible();
		const calendarBox = await calendar.boundingBox();
		if (!calendarBox) throw new Error("Missing calendar");
		expect(calendarBox.x).toBeGreaterThanOrEqual(0);
		expect(calendarBox.x + calendarBox.width).toBeLessThanOrEqual(320);
		await page.getByRole("button", { name: /January 1st, 2024/ }).click();
		await expect(calendar).toBeHidden();
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText("Choose both");
		await expect(from).toHaveAttribute("aria-invalid", "true");
		await expect(page.getByLabel("Submitted search")).toHaveText("{}");
		await to.click();
		await page.getByRole("button", { name: /January 31st, 2024/ }).click();
		await from.click();
		await page.getByRole("button", { name: "Clear", exact: true }).click();
		await expect(from).toHaveText("Pick a date");
		await expect(to).toHaveText("January 31, 2024");
		await from.click();
		await page.getByRole("button", { name: /January 2nd, 2024/ }).click();
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect(page.getByLabel("Submitted search")).toHaveText(
			'{"case_name":"Ada","registered:to":"2024-01-31","registered:from":"2024-01-02"}',
		);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			),
		).toBe(false);
		await page.setViewportSize({ width: 800, height: 700 });
		const wideFrom = await from.boundingBox(),
			wideTo = await to.boundingBox();
		if (!wideFrom || !wideTo) throw new Error("Missing wide date fields");
		expect(wideTo.y).toBe(wideFrom.y);
		expect(wideTo.x).toBeGreaterThan(wideFrom.x);
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewSearchAudit?.dispose());
		} finally {
			await page.close();
			await peer.close();
		}
	}
});

test("an open Search calendar retains its native grid and keyboard focus across a parent render", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	try {
		await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
		await page.goto(peer.origin);
		await page.getByLabel("Registered from").click();
		const calendar = page.getByRole("grid");
		await expect(calendar).toBeVisible();
		await page.getByRole("button", { name: "Go to the Next Month" }).click();
		const day = page.getByRole("button", { name: /February 15th, 2024/ });
		await day.focus();
		await expect(day).toBeFocused();
		const gridNode = await calendar.elementHandle();
		const dayNode = await day.elementHandle();
		if (!gridNode || !dayNode) throw new Error("Missing open calendar nodes");
		await page.evaluate(() => window.previewSearchAudit.rerender());
		await expect(page.locator("[data-render-revision]")).toHaveAttribute(
			"data-render-revision",
			"1",
		);
		expect(await gridNode.evaluate((node) => node.isConnected)).toBe(true);
		expect(await dayNode.evaluate((node) => node.isConnected)).toBe(true);
		await expect(day).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(
			page.getByRole("button", { name: /February 16th, 2024/ }),
		).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(calendar).toBeHidden();
		await expect(page.getByLabel("Registered from")).toHaveText(
			"February 16, 2024",
		);
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewSearchAudit?.dispose());
		} finally {
			await page.close();
			await peer.close();
		}
	}
});

test("Search barcode scanning disposes native media tracks on cancellation, late permission and detection", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	await page.addInitScript(() => {
		const streams: MediaStream[] = [];
		let release: (() => void) | undefined;
		let detected = "";
		let hold = true;
		Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
			value: async () => {
				const canvas = document.createElement("canvas");
				canvas.width = 20;
				canvas.height = 20;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Missing native canvas context");
				context.fillRect(0, 0, 20, 20);
				const stream = canvas.captureStream();
				streams.push(stream);
				if (hold)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				return stream;
			},
		});
		Object.defineProperty(window, "BarcodeDetector", {
			value: class {
				static async getSupportedFormats() {
					return ["code_128"];
				}
				async detect() {
					return detected ? [{ rawValue: detected }] : [];
				}
			},
		});
		window.previewCameraBoundary = {
			release() {
				hold = false;
				release?.();
			},
			detect(value: string) {
				detected = value;
			},
			states() {
				return streams.flatMap((stream) =>
					stream.getTracks().map((track) => track.readyState),
				);
			},
			dispose() {
				release?.();
				for (const stream of streams)
					for (const track of stream.getTracks()) track.stop();
			},
		};
	});
	try {
		await page.goto(`${peer.origin}/?platform=android`);
		await page.getByLabel("Barcode", { exact: true }).fill("Manual code");
		await page.getByRole("button", { name: "Scan Barcode" }).click();
		await expect(page.getByText("Starting your camera…")).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => window.previewCameraBoundary.states()))
			.toEqual(["live"]);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.evaluate(() => window.previewCameraBoundary.release());
		await expect
			.poll(() => page.evaluate(() => window.previewCameraBoundary.states()))
			.toEqual(["ended"]);
		await expect(page.getByLabel("Barcode", { exact: true })).toHaveValue(
			"Manual code",
		);
		await page.getByRole("button", { name: "Scan Barcode" }).click();
		await expect(
			page.getByText("Point your camera at the barcode"),
		).toBeVisible();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.previewCameraBoundary.states()))
			.toEqual(["ended", "ended"]);
		await page.evaluate(() => window.previewCameraBoundary.detect("BC-0042"));
		await page.getByRole("button", { name: "Scan Barcode" }).click();
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(page.getByLabel("Barcode", { exact: true })).toHaveValue(
			"BC-0042",
		);
		await expect
			.poll(() => page.evaluate(() => window.previewCameraBoundary.states()))
			.toEqual(["ended", "ended", "ended"]);
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect(page.getByLabel("Submitted search")).toHaveText(
			'{"barcode":"BC-0042"}',
		);
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => {
					window.previewCameraBoundary?.dispose();
					window.previewSearchAudit?.dispose();
				});
		} finally {
			await page.close();
			await peer.close();
		}
	}
});
declare global {
	interface Window {
		previewCameraBoundary: {
			release(): void;
			detect(value: string): void;
			states(): MediaStreamTrackState[];
			dispose(): void;
		};
	}
}

test("workers can replace a readable three-date starting value on the search screen", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	try {
		await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
		await page.goto(
			`${peer.origin}/?platform=web-apps&range=2024-01-02__2024-02-12__2024-05-21`,
		);
		await expect(
			page.getByText("1/2/2024 to 2/12/2024 to 5/21/2024", { exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect(
			page.getByText("Choose valid start and end dates", { exact: true }),
		).toBeVisible();
		await page.getByLabel("Registered from").click();
		await page.getByRole("button", { name: /January 2nd, 2024/ }).click();
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect(
			page.getByText("Choose both a start date and an end date", {
				exact: true,
			}),
		).toBeVisible();
		await page.getByLabel("Registered to").click();
		await page.getByRole("button", { name: /January 15th, 2024/ }).click();
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect
			.poll(async () =>
				JSON.parse(await page.getByLabel("Submitted search").innerText()),
			)
			.toEqual({
				"registered:from": "2024-01-02",
				"registered:to": "2024-01-15",
			});
	} finally {
		await peer.close();
	}
});

test("Web Apps offers a search for blank under a field that allows it, and Android shows the field alone", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	try {
		await page.goto(`${peer.origin}/?platform=web-apps&blank`);
		const box = page.getByRole("checkbox", {
			name: "Include results where 'Patient name' is blank",
		});
		await expect(box).toBeVisible();
		await page.getByLabel("Patient name", { exact: true }).fill("Amina");
		await box.check();
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect
			.poll(async () =>
				JSON.parse(await page.getByLabel("Submitted search").innerText()),
			)
			.toEqual({ case_name: "Amina", "case_name:blank": "true" });
		await page.goto(`${peer.origin}/?platform=android&blank`);
		await expect(
			page.getByLabel("Patient name", { exact: true }),
		).toBeVisible();
		await expect(page.getByText(/Include results where/)).toHaveCount(0);
	} finally {
		await peer.close();
	}
});

test("Web Apps holds a search for a requirement with no message, marking the field with no words, and shows CommCare's sentence for a check with none, and Android searches", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	try {
		await page.goto(`${peer.origin}/?platform=web-apps&unmessaged`);
		const barcode = page.getByLabel("Barcode", { exact: true });
		const search = page.getByRole("button", { name: "Search", exact: true });
		const submitted = async () =>
			JSON.parse(await page.getByLabel("Submitted search").innerText());
		await barcode.fill("999");
		await search.click();
		await expect(
			page.getByText("Sorry, this response is invalid!"),
		).toBeVisible();
		await barcode.fill("123");
		await search.click();
		await expect(
			page.getByText("Sorry, this response is invalid!"),
		).toHaveCount(0);
		// The name is still required and has no message: the search waits, and
		// the field shows as invalid with no words under it (HQ writes the
		// blank text as a no-break space, which Web Apps reads as a message).
		const name = page.getByLabel("Patient name", { exact: true });
		await expect(name).toHaveAttribute("aria-invalid", "true");
		await expect(
			page.getByText("Fill in this answer before searching."),
		).toHaveCount(0);
		await expect.poll(submitted).toEqual({});
		await name.fill("Amina");
		await search.click();
		await expect(name).not.toHaveAttribute("aria-invalid", "true");
		await expect
			.poll(submitted)
			.toEqual({ barcode: "123", case_name: "Amina" });
		await page.goto(`${peer.origin}/?platform=android&unmessaged`);
		await page.getByLabel("Barcode", { exact: true }).fill("999");
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect.poll(submitted).toEqual({ barcode: "999" });
	} finally {
		await peer.close();
	}
});

test("Web Apps searches with a hidden field's starting value without drawing it, and Android draws it", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-search-client.tsx");
	try {
		await page.goto(`${peer.origin}/?platform=web-apps&hidden`);
		await expect(
			page.getByLabel("Patient name", { exact: true }),
		).toBeVisible();
		await expect(page.getByLabel("Region", { exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect
			.poll(async () =>
				JSON.parse(await page.getByLabel("Submitted search").innerText()),
			)
			.toEqual({ region: "north" });
		await page.goto(`${peer.origin}/?platform=android&hidden`);
		const region = page.getByLabel("Region", { exact: true });
		await expect(region).toHaveValue("north");
		await region.fill("south");
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect
			.poll(async () =>
				JSON.parse(await page.getByLabel("Submitted search").innerText()),
			)
			.toEqual({ region: "south" });
	} finally {
		await peer.close();
	}
});

test("A chosen address fills Search through its linked field and never sends the address", async ({
	page,
}) => {
	const peer = await componentPeer(
		"e2e/lib/preview-search-client.tsx",
		[],
		{
			"@googlemaps/js-api-loader": resolve(
				"e2e/lib/preview-geopoint-google-peer.ts",
			),
		},
		{
			"process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY": '"synthetic-key"',
			"process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID": '"synthetic-map"',
		},
	);
	try {
		await page.route(`${peer.origin}/geopoint-peer/**`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			await route.fulfill({
				json: path.endsWith("/suggestions")
					? [{ id: "visit-road", label: "18 Visit Road" }]
					: {
							label: "18 Visit Road, Example Town",
							lat: -1.9,
							lng: 35.12,
							addressComponents: [
								{ longText: "Example Town", types: ["locality"] },
							],
						},
			});
		});
		await page.goto(`${peer.origin}/?platform=web-apps&address`);
		const address = page.getByRole("combobox", { name: "Find an address" });
		const name = page.getByRole("textbox", { name: "Patient name" });
		await expect(address).toBeEditable();
		await address.fill("Visit Road");
		await page.getByRole("option", { name: "18 Visit Road" }).click();
		await expect(address).toHaveValue("18 Visit Road, Example Town");
		await expect(name).toHaveValue("Example Town");
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect(page.getByLabel("Submitted search")).toHaveText(
			'{"case_name":"Example Town"}',
		);
		await page.getByRole("button", { name: "Clear the address" }).click();
		await expect(name).toHaveValue("");
		await page.goto(`${peer.origin}/?platform=android&address`);
		await expect(address).toHaveCount(0);
		await expect(name).toBeEditable();
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewSearchAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});
