import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-search-client";

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
			'{"case_name":"Ada","period:to":"2024-01-31","period:from":"2024-01-02"}',
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
		await page.goto(peer.origin);
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
