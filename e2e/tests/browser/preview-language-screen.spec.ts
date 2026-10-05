import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { componentPeer } from "../../lib/componentPeer";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-language-screen-client";
import { DATE, NAME } from "../../lib/preview-language-screen-doc";

test("a rejected submission keeps required errors and review announcements in the current language", async ({
	page,
}, testInfo) => {
	const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
	const peer = await componentPeer(
		"e2e/lib/preview-language-screen-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
			"@/lib/preview/xpath/browserWorkerClient": resolve(
				"e2e/lib/preview-language-worker-boundary.ts",
			),
		},
	);
	try {
		const guard = await attachErrorGuard(page, peer.origin);
		async function capture(name: string) {
			await writeFile(
				testInfo.outputPath(`${name}.aria.txt`),
				await page.locator("body").ariaSnapshot(),
			);
			const screenPath = testInfo.outputPath(`${name}.png`);
			await page.screenshot({ path: screenPath, fullPage: true });
			await testInfo.attach(name, {
				path: screenPath,
				contentType: "image/png",
			});
		}
		try {
			await page.setViewportSize({ width: 390, height: 720 });
			await page.goto(peer.origin);
			await expect(
				page.locator('[data-preview-engine-ready="true"]'),
			).toBeVisible();
			await page.getByRole("button", { name: "Español", exact: true }).click();
			await page.evaluate(() => window.previewLanguageScreen.settled());
			const before = await page.evaluate(() =>
				window.previewLanguageScreen.observation(),
			);
			const question = page.locator(
				`[data-field-uuid="${NAME}"][data-instance-path]`,
			);
			const announcement = page.locator('p[role="alert"].sr-only');
			await page.getByRole("button", { name: "Enviar", exact: true }).click();
			await expect(question).toHaveAttribute("data-invalid", "true");
			await expect(
				question.getByText("Este campo es obligatorio", { exact: true }),
			).toBeVisible();
			await expect(announcement).toHaveText("Revise la pregunta resaltada.");
			await capture("required-spa");
			for (const [button, error, review, tag] of [
				[
					"English",
					"This field is required",
					"Review the highlighted question.",
					"eng",
				],
				[
					"Español",
					"Este campo es obligatorio",
					"Revise la pregunta resaltada.",
					"spa",
				],
			] as const) {
				await page.getByRole("button", { name: button, exact: true }).click();
				// Observe the completed production rebuild, without revalidating or
				// submitting again to recreate the warning under test.
				await page.evaluate(() => window.previewLanguageScreen.settled());
				await expect(question).toHaveAttribute("data-invalid", "true");
				await expect(question.getByText(error, { exact: true })).toBeVisible();
				await expect(announcement).toHaveText(review);
				const after = await page.evaluate(() =>
					window.previewLanguageScreen.observation(),
				);
				expect(after.entry?.entryKey).toBe(before.entry?.entryKey);
				expect(after.values).toEqual(before.values);
				await capture(`required-rebuilt-${tag}`);
			}
			await question.getByRole("textbox").fill("   ");
			await page.getByRole("button", { name: "Enviar", exact: true }).click();
			await expect(
				question.getByText("Ingrese un nombre con letras.", { exact: true }),
			).toBeVisible();
			await page.getByRole("button", { name: "English", exact: true }).click();
			await page.evaluate(() => window.previewLanguageScreen.settled());
			await expect(question).toHaveAttribute("data-invalid", "true");
			await expect(
				question.getByText("Enter a name with letters.", { exact: true }),
			).toBeVisible();
			await expect(announcement).toHaveText("Review the highlighted question.");
			await expect(question.getByRole("textbox")).toHaveValue("   ");
			await capture("authored-rebuilt-eng");
		} catch (error) {
			if (!page.isClosed()) await capture("failure");
			throw error;
		} finally {
			try {
				if (!page.isClosed())
					await page.evaluate(() => window.previewLanguageScreen?.dispose());
			} finally {
				await closePageWithUnload(page);
				await guard.assertNoErrors();
			}
		}
	} finally {
		await peer.close();
	}
});

test("a production form keeps partial drafts and capture identity mounted through a held language and path replacement", async ({
	page,
}, testInfo) => {
	const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
	const peer = await componentPeer(
		"e2e/lib/preview-language-screen-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
			"@/lib/preview/xpath/browserWorkerClient": resolve(
				"e2e/lib/preview-language-worker-boundary.ts",
			),
		},
	);
	const guard = await attachErrorGuard(page, peer.origin);
	const captureAttempts: unknown[] = [];
	await page.route(
		`${peer.origin}/api/apps/native-language-screen/attachments`,
		async (route) => {
			captureAttempts.push(route.request().postDataJSON());
			// Retain the worker's actual ink through an unavailable local transport;
			// no upload URL, staged object or GCS success is invented here.
			await route.fulfill({
				status: 409,
				json: { error: "The attachment couldn't be saved. Try again." },
			});
		},
	);
	async function capture(name: string) {
		const ariaPath = testInfo.outputPath(`${name}.aria.txt`);
		const screenPath = testInfo.outputPath(`${name}.png`);
		const observationPath = testInfo.outputPath(`${name}.json`);
		await writeFile(ariaPath, await page.locator("body").ariaSnapshot());
		await page.screenshot({ path: screenPath, fullPage: true });
		await writeFile(
			observationPath,
			`${JSON.stringify({ observation: await page.evaluate(() => window.previewLanguageScreen.observation()), captureAttempts }, null, 2)}\n`,
		);
		await testInfo.attach(name, { path: screenPath, contentType: "image/png" });
	}
	try {
		await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto(peer.origin);
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible();
		await page.getByRole("textbox", { name: /Question 1.*Name/ }).fill("Amina");
		const date = page.getByRole("button", { name: /Visit date/ });
		await date.click();
		await page.getByRole("button", { name: /January 9th, 2024/ }).click();
		await expect(date).toHaveText("January 9, 2024");
		await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
		await page.evaluate(() => window.previewLanguageScreen.settled());
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible();
		const manualCoordinates = page.getByRole("button", {
			name: "Enter coordinates manually",
			exact: true,
		});
		await manualCoordinates.click();
		await expect(manualCoordinates).toHaveAttribute("aria-expanded", "true");
		const latitude = page.getByRole("spinbutton", {
			name: "Latitude",
			exact: true,
		});
		const longitude = page.getByRole("spinbutton", {
			name: "Longitude",
			exact: true,
		});
		await expect(latitude).toBeVisible();
		await latitude.fill("40");
		await longitude.fill("-74");
		await page
			.getByRole("textbox", { name: /Visit note/ })
			.first()
			.fill("Retained visit note");
		await page.evaluate(() => window.previewLanguageScreen.settled());
		const before = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(before.values).toEqual({
			name: "Amina",
			date: "2024-01-09",
			when: "2024-01-15T14:30:00.000-05:00",
			location: "40 -74 0 0",
			note: "Retained visit note",
		});
		const canvas = page.locator(
			'canvas[data-instance-path="/data/visit/visits[0]/signature"]',
		);
		await canvas.scrollIntoViewIfNeeded();
		const box = await canvas.boundingBox();
		if (!box) throw new Error("The signature pad has no browser box");
		await page.mouse.move(box.x + 20, box.y + 20);
		await page.mouse.down();
		await page.mouse.move(box.x + 65, box.y + 45, { steps: 4 });
		await page.mouse.up();
		const ink = await canvas.evaluate((element: HTMLCanvasElement) =>
			element.toDataURL(),
		);
		const latitudeNode = await latitude.elementHandle();
		const longitudeNode = await longitude.elementHandle();
		const signatureNode = await canvas.elementHandle();
		const fileNode = await page
			.locator('input[type="file"]')
			.first()
			.elementHandle();
		if (!latitudeNode || !longitudeNode || !signatureNode || !fileNode)
			throw new Error("Missing native input identities");
		await longitude.fill("");
		await latitude.fill("4");
		const clock = page.getByRole("textbox", { name: "Time", exact: true });
		await clock.fill("2:4");
		await page.evaluate(() => window.previewLanguageScreen.arm());
		await capture("01-before-language");
		await page.getByRole("button", { name: "Español", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.previewLanguageScreen.held()))
			.toBe(true);
		await page.evaluate(() => window.previewLanguageScreen.rename());
		await expect
			.poll(() =>
				page.evaluate(() => window.previewLanguageScreen.observation().entry),
			)
			.toMatchObject({
				entryKey: before.entry?.entryKey,
				ready: false,
				rebuilding: true,
			});
		await expect(
			page.locator('[data-preview-engine-ready="false"]'),
		).toHaveAttribute("inert", "");
		await expect(
			page.getByText("This form is getting ready.", { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Enviar", exact: true }),
		).toBeDisabled();
		expect(
			await latitudeNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
				disabled: element.matches(":disabled"),
			})),
		).toEqual({ connected: true, value: "4", disabled: true });
		expect(
			await longitudeNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
			})),
		).toEqual({ connected: true, value: "" });
		expect(
			await signatureNode.evaluate((element: HTMLCanvasElement) => ({
				connected: element.isConnected,
				ink: element.toDataURL(),
			})),
		).toEqual({ connected: true, ink });
		expect(await fileNode.evaluate((element) => element.isConnected)).toBe(
			true,
		);
		const pending = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(pending.paths).toEqual({
			repeat: "/data/visit/visits",
			note: "/data/visit/visits[0]/note",
			image: "/data/visit/visits[0]/image",
		});
		expect(await signatureNode.getAttribute("data-instance-path")).toBe(
			"/data/visit/visits[0]/signature",
		);
		expect(pending.repeatKeys).toEqual(before.repeatKeys);
		expect(pending.values).toEqual({
			...before.values,
			when: "2024-01-15T2:4",
		});
		await capture("02-replacement-held");
		await page.evaluate(() => window.previewLanguageScreen.release());
		await page.evaluate(() => window.previewLanguageScreen.settled());
		await expect(
			page.getByRole("spinbutton", { name: "Latitud", exact: true }),
		).toHaveValue("4");
		await expect(
			page.getByRole("spinbutton", { name: "Longitud", exact: true }),
		).toHaveValue("");
		await expect(
			page.getByRole("textbox", { name: "Hora", exact: true }),
		).toHaveValue("2:4");
		await expect(date).toHaveText("9 de enero de 2024");
		const after = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(after.entry).toMatchObject({
			entryKey: before.entry?.entryKey,
			ready: true,
			rebuilding: false,
			fault: undefined,
		});
		expect(after.greeting).toBe("Hola Amina");
		expect(after.values).toEqual(pending.values);
		expect(after.repeatKeys).toEqual(before.repeatKeys);
		expect(after.paths).toEqual({
			repeat: "/data/encounter/journeys",
			note: "/data/encounter/journeys[0]/detail",
			image: "/data/encounter/journeys[0]/evidence",
		});
		expect(await signatureNode.getAttribute("data-instance-path")).toBe(
			"/data/encounter/journeys[0]/approval",
		);
		expect(
			await fileNode.evaluate((element) =>
				element
					.closest("[data-instance-path]")
					?.getAttribute("data-instance-path"),
			),
		).toBe("/data/encounter/journeys[0]/evidence");
		expect(
			await signatureNode.evaluate((element: HTMLCanvasElement) => ({
				connected: element.isConnected,
				ink: element.toDataURL(),
			})),
		).toEqual({ connected: true, ink });
		expect(await fileNode.evaluate((element) => element.isConnected)).toBe(
			true,
		);
		await capture("03-replacement-published");
		await page.getByRole("button", { name: "English", exact: true }).click();
		await page.evaluate(() => window.previewLanguageScreen.settled());
		await page.getByRole("button", { name: "Clear form", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(
					() => window.previewLanguageScreen.observation().entry?.entryKey,
				),
			)
			.not.toBe(before.entry?.entryKey);
		await page.evaluate(() => window.previewLanguageScreen.settled());
		expect(await latitudeNode.evaluate((element) => element.isConnected)).toBe(
			false,
		);
		expect(await signatureNode.evaluate((element) => element.isConnected)).toBe(
			false,
		);
		expect(
			(await page.evaluate(() => window.previewLanguageScreen.observation()))
				.values,
		).toEqual({
			name: "",
			date: "",
			when: "2024-01-15T14:30:00.000-05:00",
			location: "",
			note: "",
		});
		await capture("04-new-entry-cleared");
	} catch (error) {
		if (!page.isClosed()) await capture("failure");
		throw error;
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewLanguageScreen?.dispose());
		} finally {
			try {
				await closePageWithUnload(page);
				await guard.assertNoErrors();
			} finally {
				await peer.close();
			}
		}
	}
});

for (const outcome of ["accept", "new-entry"] as const) {
	test(`a confirmed repeated capture ${outcome === "accept" ? "waits for current paths before acceptance" : "is cleaned when its waiting entry is replaced"}`, async ({
		page,
	}, testInfo) => {
		const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
		const peer = await componentPeer(
			"e2e/lib/preview-language-screen-client.tsx",
			[],
			{
				"@/lib/preview/engine/caseDataBinding": boundary,
				"@/lib/preview/engine/lookupDataBinding": boundary,
				"@/lib/preview/entryPointLaunchAction": boundary,
				"@/lib/auth/hooks/useAuth": boundary,
				"@/lib/lookup/actions": boundary,
				"@/lib/preview/xpath/browserWorkerClient": resolve(
					"e2e/lib/preview-language-worker-boundary.ts",
				),
			},
		);
		const guard = await attachErrorGuard(page, peer.origin);
		const attachmentId = "77777777-7777-4777-8777-777777777777";
		const filename = "visit.png";
		const bytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
			"base64",
		);
		const calls: { method: string; body?: unknown }[] = [];
		let confirmEntered = false;
		let confirmReturned = false;
		let releaseConfirm: () => void = () => {};
		const confirmGate = new Promise<void>((resolveGate) => {
			releaseConfirm = resolveGate;
		});
		await page.route(
			`${peer.origin}/api/apps/native-language-screen/attachments**`,
			async (route) => {
				const request = route.request();
				const method = request.method();
				calls.push({
					method,
					...(request.postData() ? { body: request.postDataJSON() } : {}),
				});
				if (method === "DELETE") {
					await route.fulfill({ status: 204 });
				} else if (method === "PATCH") {
					const body = request.postDataJSON();
					await route.fulfill({ json: { instancePath: body.instancePath } });
				} else if (new URL(request.url()).pathname.endsWith("/attachments")) {
					await route.fulfill({
						json: {
							attachmentId,
							attachmentName: "confirmed.png",
							uploadUrl: `${peer.origin}/capture-upload`,
							uploadContentType: "image/png",
							uploadHeaders: {},
						},
					});
				} else {
					confirmEntered = true;
					await confirmGate;
					await route.fulfill({
						json: {
							attachmentId,
							attachmentName: "confirmed.png",
							originalFilename: filename,
							sizeBytes: bytes.length,
						},
					});
					confirmReturned = true;
				}
			},
		);
		await page.route(`${peer.origin}/capture-upload`, async (route) => {
			expect(route.request().method()).toBe("PUT");
			expect(route.request().postDataBuffer()).toEqual(bytes);
			await route.fulfill({ status: 200, body: "" });
		});
		async function capture(name: string) {
			await writeFile(
				testInfo.outputPath(`${name}.json`),
				`${JSON.stringify({ calls, observation: await page.evaluate(() => window.previewLanguageScreen.observation()) }, null, 2)}\n`,
			);
			await page.screenshot({
				path: testInfo.outputPath(`${name}.png`),
				fullPage: true,
			});
		}
		try {
			await page.setViewportSize({ width: 320, height: 720 });
			await page.goto(peer.origin);
			await expect(
				page.locator('[data-preview-engine-ready="true"]'),
			).toBeVisible();
			const before = await page.evaluate(() =>
				window.previewLanguageScreen.observation(),
			);
			await page.locator('input[type="file"]').first().setInputFiles({
				name: filename,
				mimeType: "image/png",
				buffer: bytes,
			});
			await expect.poll(() => confirmEntered).toBe(true);
			await page.evaluate(() => window.previewLanguageScreen.arm());
			await page.getByRole("button", { name: "Español", exact: true }).click();
			await expect
				.poll(() => page.evaluate(() => window.previewLanguageScreen.held()))
				.toBe(true);
			await page.evaluate(() => window.previewLanguageScreen.rename());
			releaseConfirm();
			await expect.poll(() => confirmReturned).toBe(true);
			// Confirmation is a controlled client transport response. The controller
			// must still withhold both its answer and row ownership until ready.
			const pending = await page.evaluate(() =>
				window.previewLanguageScreen.observation(),
			);
			expect(pending.capture.value).toBe("");
			expect(pending.capture.owned).toBeUndefined();
			expect(pending.entry).toMatchObject({
				entryKey: before.entry?.entryKey,
				ready: false,
				rebuilding: true,
			});
			await capture("confirmed-while-held");
			if (outcome === "new-entry") {
				await page.evaluate(() => window.previewLanguageScreen.newEntry());
				await expect
					.poll(() => calls.filter((call) => call.method === "DELETE").length)
					.toBe(1);
				const replacement = await page.evaluate(() =>
					window.previewLanguageScreen.observation(),
				);
				expect(replacement.entry?.entryKey).not.toBe(before.entry?.entryKey);
				expect(replacement.capture.value).toBe("");
				expect(replacement.capture.owned).toBeUndefined();
			} else {
				await page.evaluate(() => window.previewLanguageScreen.release());
				await page.evaluate(() =>
					window.previewLanguageScreen.captureSettled(),
				);
				const accepted = await page.evaluate(() =>
					window.previewLanguageScreen.observation(),
				);
				expect(accepted.entry).toMatchObject({
					entryKey: before.entry?.entryKey,
					ready: true,
					rebuilding: false,
				});
				expect(accepted.capture.value).toBe("confirmed.png");
				expect(accepted.capture.owned).toEqual({
					attachmentId,
					attachmentName: "confirmed.png",
					originalFilename: filename,
					sizeBytes: bytes.length,
				});
				expect(accepted.paths.image).toBe(
					"/data/encounter/journeys[0]/evidence",
				);
				expect(accepted.capture.slotPath).toBe(accepted.paths.image);
				expect(accepted.repeatKeys).toEqual(before.repeatKeys);
				expect(calls.filter((call) => call.method === "PATCH")).toEqual([
					{
						method: "PATCH",
						body: {
							expectedInstancePath: "/data/visit/visits[0]/image",
							instancePath: "/data/encounter/journeys[0]/evidence",
						},
					},
				]);
				expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
					0,
				);
			}
			await capture("capture-finished");
		} catch (error) {
			if (!page.isClosed()) await capture("capture-failure");
			throw error;
		} finally {
			releaseConfirm();
			try {
				if (!page.isClosed())
					await page.evaluate(() => window.previewLanguageScreen?.dispose());
			} finally {
				try {
					await closePageWithUnload(page);
					await guard.assertNoErrors();
				} finally {
					await peer.close();
				}
			}
		}
	});
}

test("held section unwrap and wrap retain the published controls until their new topology is ready", async ({
	page,
}, testInfo) => {
	const boundary = resolve("e2e/lib/preview-form-lifecycle-boundary.ts");
	const peer = await componentPeer(
		"e2e/lib/preview-language-screen-client.tsx",
		[],
		{
			"@/lib/preview/engine/caseDataBinding": boundary,
			"@/lib/preview/engine/lookupDataBinding": boundary,
			"@/lib/preview/entryPointLaunchAction": boundary,
			"@/lib/auth/hooks/useAuth": boundary,
			"@/lib/lookup/actions": boundary,
			"@/lib/preview/xpath/browserWorkerClient": resolve(
				"e2e/lib/preview-language-worker-boundary.ts",
			),
		},
	);
	const guard = await attachErrorGuard(page, peer.origin);
	async function capture(name: string) {
		await writeFile(
			testInfo.outputPath(`${name}.json`),
			`${JSON.stringify(await page.evaluate(() => window.previewLanguageScreen.observation()), null, 2)}\n`,
		);
		await writeFile(
			testInfo.outputPath(`${name}.aria.txt`),
			await page.locator("body").ariaSnapshot(),
		);
		await page.screenshot({
			path: testInfo.outputPath(`${name}.png`),
			fullPage: true,
		});
	}
	try {
		await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto(peer.origin);
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible();
		await page.getByRole("textbox", { name: /Question 1.*Name/ }).fill("Amina");
		await page.getByRole("button", { name: /Visit date/ }).click();
		await page.evaluate(() => window.previewLanguageScreen.settled());
		// Entering the calendar is not submission: it must not introduce a
		// required warning that then moves the next control when a day is picked.
		await expect(
			page.locator(`[data-field-uuid="${DATE}"][data-instance-path]`),
		).not.toHaveAttribute("data-invalid", "true");
		await page.getByRole("button", { name: /January 9th, 2024/ }).click();
		const manualCoordinates = page.getByRole("button", {
			name: "Enter coordinates manually",
			exact: true,
		});
		await manualCoordinates.click();
		await expect(manualCoordinates).toHaveAttribute("aria-expanded", "true");
		const originalLatitude = page.getByRole("spinbutton", {
			name: "Latitude",
			exact: true,
		});
		const originalLongitude = page.getByRole("spinbutton", {
			name: "Longitude",
			exact: true,
		});
		const originalClock = page.getByRole("textbox", {
			name: "Time",
			exact: true,
		});
		await originalLatitude.fill("40");
		await originalLongitude.fill("-74");
		await page
			.getByRole("textbox", { name: /Visit note/ })
			.first()
			.fill("Retained visit note");
		await page.evaluate(() => window.previewLanguageScreen.settled());
		const initial = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(initial.values).toEqual({
			name: "Amina",
			date: "2024-01-09",
			when: "2024-01-15T14:30:00.000-05:00",
			location: "40 -74 0 0",
			note: "Retained visit note",
		});
		expect(initial.topology.sectioned).toBe(true);
		expect(initial.topology.pages).toHaveLength(1);
		expect(initial.paths.repeat).toBe("/data/visit/visits");
		const oldLatitudeNode = await originalLatitude.elementHandle();
		const oldLongitudeNode = await originalLongitude.elementHandle();
		const oldClockNode = await originalClock.elementHandle();
		if (!oldLatitudeNode || !oldLongitudeNode || !oldClockNode)
			throw new Error("Missing original section inputs");
		await originalLongitude.fill("");
		await originalLatitude.fill("4");
		await originalClock.fill("2:4");
		await page.evaluate(() => window.previewLanguageScreen.arm());
		await page.getByRole("button", { name: "Español", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.previewLanguageScreen.held()))
			.toBe(true);
		await page.evaluate(() => window.previewLanguageScreen.unwrap());
		await expect(
			page.locator('[data-preview-engine-ready="false"]'),
		).toHaveAttribute("inert", "");
		expect(
			await oldLatitudeNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
				disabled: element.matches(":disabled"),
			})),
		).toEqual({ connected: true, value: "4", disabled: true });
		expect(
			await oldLongitudeNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
			})),
		).toEqual({ connected: true, value: "" });
		expect(
			await oldClockNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
			})),
		).toEqual({ connected: true, value: "2:4" });
		await expect(
			page.getByRole("heading", { name: /Visit details/, includeHidden: true }),
		).toBeVisible();
		await expect(
			page
				.getByRole("navigation", { name: "Secciones", exact: true })
				.getByRole("button", { name: /Visit details/ }),
		).toBeVisible();
		await expect(
			page.getByText("This form is getting ready.", { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText(
				"Nothing to answer right now. Every section is empty or hidden by a display condition.",
				{ exact: true },
			),
		).toHaveCount(0);
		const heldUnwrap = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(heldUnwrap.entry).toMatchObject({
			entryKey: initial.entry?.entryKey,
			ready: false,
			rebuilding: true,
		});
		expect(heldUnwrap.topology).toEqual(initial.topology);
		expect(heldUnwrap.paths).toEqual(initial.paths);
		expect(heldUnwrap.repeatKeys).toEqual(initial.repeatKeys);
		expect(heldUnwrap.values).toEqual({
			...initial.values,
			when: "2024-01-15T2:4",
		});
		await capture("unwrap-held");
		await page.evaluate(() => window.previewLanguageScreen.release());
		await page.evaluate(() => window.previewLanguageScreen.settled());
		await expect(
			page.locator('[data-preview-engine-ready="true"]'),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: /Visit details/ }),
		).toHaveCount(0);
		await expect(
			page.getByRole("navigation", { name: "Secciones", exact: true }),
		).toHaveCount(0);
		expect(
			await oldLatitudeNode.evaluate((element) => element.isConnected),
		).toBe(false);
		expect(
			await oldLongitudeNode.evaluate((element) => element.isConnected),
		).toBe(false);
		expect(await oldClockNode.evaluate((element) => element.isConnected)).toBe(
			false,
		);
		const unwrapped = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(unwrapped.entry).toMatchObject({
			entryKey: initial.entry?.entryKey,
			ready: true,
			rebuilding: false,
		});
		expect(unwrapped.topology.sectioned).toBe(false);
		expect(unwrapped.topology.pages).toEqual([]);
		expect(unwrapped.paths).toEqual({
			repeat: "/data/visits",
			note: "/data/visits[0]/note",
			image: "/data/visits[0]/image",
		});
		expect(unwrapped.values).toEqual(heldUnwrap.values);
		expect(unwrapped.repeatKeys).toEqual(initial.repeatKeys);
		await expect(
			page.getByText("«2:4» no es una hora. Introduzca una hora como 14:30.", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.locator('[data-instance-path="/data/location"]'),
		).toHaveCount(1);
		await expect(page.locator('[data-instance-path="/data/name"]')).toHaveCount(
			1,
		);
		await capture("unwrap-published");
		await page
			.getByRole("button", {
				name: "Introducir coordenadas manualmente",
				exact: true,
			})
			.click();
		const unpagedLatitude = page.getByRole("spinbutton", {
			name: "Latitud",
			exact: true,
		});
		const unpagedLongitude = page.getByRole("spinbutton", {
			name: "Longitud",
			exact: true,
		});
		const unpagedClock = page.getByRole("textbox", {
			name: "Hora",
			exact: true,
		});
		const unpagedLatitudeNode = await unpagedLatitude.elementHandle();
		const unpagedLongitudeNode = await unpagedLongitude.elementHandle();
		const unpagedClockNode = await unpagedClock.elementHandle();
		if (!unpagedLatitudeNode || !unpagedLongitudeNode || !unpagedClockNode)
			throw new Error("Missing unsectioned inputs");
		await unpagedLongitude.fill("");
		await unpagedLatitude.fill("5");
		await unpagedClock.fill("3:4");
		await page.evaluate(() => window.previewLanguageScreen.arm());
		await page.getByRole("button", { name: "English", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.previewLanguageScreen.held()))
			.toBe(true);
		await page.evaluate(() => window.previewLanguageScreen.wrap());
		expect(
			await unpagedLatitudeNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
				disabled: element.matches(":disabled"),
			})),
		).toEqual({ connected: true, value: "5", disabled: true });
		expect(
			await unpagedLongitudeNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
			})),
		).toEqual({ connected: true, value: "" });
		expect(
			await unpagedClockNode.evaluate((element: HTMLInputElement) => ({
				connected: element.isConnected,
				value: element.value,
			})),
		).toEqual({ connected: true, value: "3:4" });
		await expect(
			page.getByRole("heading", { name: /Wrapped visit/, includeHidden: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("navigation", { name: "Sections", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText(
				"Nothing to answer right now. Every section is empty or hidden by a display condition.",
				{ exact: true },
			),
		).toHaveCount(0);
		const heldWrap = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(heldWrap.entry).toMatchObject({
			entryKey: initial.entry?.entryKey,
			ready: false,
			rebuilding: true,
		});
		expect(heldWrap.topology).toEqual(unwrapped.topology);
		expect(heldWrap.paths).toEqual(unwrapped.paths);
		expect(heldWrap.repeatKeys).toEqual(initial.repeatKeys);
		expect(heldWrap.values).toEqual({
			...unwrapped.values,
			when: "2024-01-15T3:4",
		});
		await capture("wrap-held");
		await page.evaluate(() => window.previewLanguageScreen.release());
		await page.evaluate(() => window.previewLanguageScreen.settled());
		await expect(
			page.getByRole("heading", { name: /Wrapped visit/ }),
		).toBeVisible();
		await expect(
			page
				.getByRole("navigation", { name: "Sections", exact: true })
				.getByRole("button", { name: /Wrapped visit/ }),
		).toBeVisible();
		expect(
			await unpagedLatitudeNode.evaluate((element) => element.isConnected),
		).toBe(false);
		expect(
			await unpagedLongitudeNode.evaluate((element) => element.isConnected),
		).toBe(false);
		expect(
			await unpagedClockNode.evaluate((element) => element.isConnected),
		).toBe(false);
		const wrapped = await page.evaluate(() =>
			window.previewLanguageScreen.observation(),
		);
		expect(wrapped.entry).toMatchObject({
			entryKey: initial.entry?.entryKey,
			ready: true,
			rebuilding: false,
		});
		expect(wrapped.topology.sectioned).toBe(true);
		expect(wrapped.topology.pages).toHaveLength(1);
		expect(wrapped.topology.pages?.[0].path).toBe("/data/wrapped_visit");
		expect(wrapped.paths).toEqual({
			repeat: "/data/wrapped_visit/visits",
			note: "/data/wrapped_visit/visits[0]/note",
			image: "/data/wrapped_visit/visits[0]/image",
		});
		expect(wrapped.values).toEqual(heldWrap.values);
		expect(wrapped.repeatKeys).toEqual(initial.repeatKeys);
		await expect(
			page.getByText(
				"“3:4” isn't a time yet. Enter a clock time like 2:30 PM.",
				{ exact: true },
			),
		).toBeVisible();
		await expect(
			page.locator('[data-instance-path="/data/wrapped_visit/location"]'),
		).toHaveCount(1);
		await expect(
			page.locator('[data-instance-path="/data/wrapped_visit/name"]'),
		).toHaveCount(1);
		await capture("wrap-published");
	} catch (error) {
		if (!page.isClosed()) await capture("paging-failure");
		throw error;
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewLanguageScreen?.dispose());
		} finally {
			try {
				await closePageWithUnload(page);
				await guard.assertNoErrors();
			} finally {
				await peer.close();
			}
		}
	}
});
