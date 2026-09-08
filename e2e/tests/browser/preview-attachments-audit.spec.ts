import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-attachments-client";

test("Preview attachments retain narrow layout and emit real signature PNGs through the running engine", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-attachments-client.tsx");
	const attempts: Array<{
		filename: string;
		instancePath: string;
		bytes?: Buffer;
	}> = [];
	await page.route(
		`${peer.origin}/api/apps/native-attachments/attachments**`,
		async (route) => {
			const request = route.request();
			if (request.method() === "DELETE") {
				await route.fulfill({ status: 204 });
				return;
			}
			if (new URL(request.url()).pathname.endsWith("/attachments")) {
				const body = request.postDataJSON();
				const id = String(
					attempts.push({
						filename: body.filename,
						instancePath: body.instancePath,
					}),
				);
				await route.fulfill({
					json: {
						attachmentId: id,
						attachmentName: `stored-${id}.png`,
						uploadUrl: `${peer.origin}/storage/${id}`,
						uploadContentType: "image/png",
						uploadHeaders: { "x-goog-if-generation-match": "0" },
					},
				});
			} else {
				const id = Number(new URL(request.url()).pathname.split("/").at(-1));
				const attempt = attempts[id - 1];
				expect(attempt.bytes).toBeDefined();
				await route.fulfill({
					json: {
						attachmentId: String(id),
						attachmentName: `stored-${id}.png`,
						originalFilename: attempt.filename,
						sizeBytes: attempt.bytes?.length,
					},
				});
			}
		},
	);
	await page.route(`${peer.origin}/storage/*`, async (route) => {
		const id = Number(
			new URL(route.request().url()).pathname.split("/").at(-1),
		);
		expect(route.request().method()).toBe("PUT");
		expect(route.request().headers()["x-goog-if-generation-match"]).toBe("0");
		attempts[id - 1].bytes = route.request().postDataBuffer() ?? undefined;
		await route.fulfill({ status: 200, body: "" });
	});
	try {
		await page.setViewportSize({ width: 320, height: 850 });
		await page.goto(peer.origin);
		const photo = page.getByRole("region", { name: "photo", exact: true });
		const filename = `${"a".repeat(251)}.png`;
		await photo.getByLabel(/Photo.*Attach file/).setInputFiles({
			name: filename,
			mimeType: "image/png",
			buffer: Buffer.from([0, 127, 255]),
		});
		await expect(photo.getByRole("status")).toHaveText(filename);
		expect(attempts[0]).toEqual({
			filename,
			instancePath: "/data/photo",
			bytes: Buffer.from([0, 127, 255]),
		});
		expect(
			await page.evaluate(() => window.previewAttachmentsAudit.answers().photo),
		).toBe("stored-1.png");
		const geometry = await photo.evaluate((element) => {
			const status = element.querySelector('[role="status"]');
			const input = element.querySelector("input");
			if (!(status instanceof HTMLElement) || !input)
				throw new Error("Missing attachment controls");
			return {
				container: element.getBoundingClientRect().width,
				statusWidth: status.getBoundingClientRect().width,
				statusHeight: status.getBoundingClientRect().height,
				lineHeight: Number.parseFloat(getComputedStyle(status).lineHeight),
				overflow: document.documentElement.scrollWidth > window.innerWidth,
				inputValue: input.value,
			};
		});
		expect(geometry.overflow).toBe(false);
		expect(geometry.statusWidth).toBeLessThanOrEqual(geometry.container);
		expect(geometry.statusHeight).toBeGreaterThan(geometry.lineHeight * 2);
		expect(geometry.inputValue).toBe("");
		const signature = page.getByRole("region", {
			name: "consent",
			exact: true,
		});
		const canvas = signature.getByRole("textbox");
		const box = await canvas.boundingBox();
		if (!box) throw new Error("Missing signature canvas");
		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.75, {
			steps: 12,
		});
		await page.mouse.up();
		await expect(signature.getByRole("status")).toHaveText("Signature saved.");
		const firstPng = attempts.find(
			(attempt) => attempt.filename === "signature.png",
		)?.bytes;
		if (!firstPng) throw new Error("Missing signature upload");
		expect([...firstPng.subarray(0, 8)]).toEqual([
			137, 80, 78, 71, 13, 10, 26, 10,
		]);
		const firstWidth = firstPng.readUInt32BE(16);
		expect(firstWidth).toBe(Math.round(box.width));
		expect(firstPng.readUInt32BE(20)).toBe(Math.round(box.height));
		await page.setViewportSize({ width: 500, height: 850 });
		await expect
			.poll(
				() =>
					attempts.filter(
						(attempt) => attempt.filename === "signature.png" && attempt.bytes,
					).length,
			)
			.toBe(2);
		await expect(signature.getByRole("status")).toHaveText("Signature saved.");
		const latest = attempts.at(-1)?.bytes;
		if (!latest) throw new Error("Missing resized signature");
		expect(latest.readUInt32BE(16)).toBeGreaterThan(firstWidth);
		const pixels = await page.evaluate(
			async (encoded) => {
				const image = await createImageBitmap(
					new Blob([new Uint8Array(encoded)], { type: "image/png" }),
				);
				try {
					const target = document.createElement("canvas");
					target.width = image.width;
					target.height = image.height;
					const context = target.getContext("2d");
					if (!context) throw new Error("Missing native pixel reader");
					context.drawImage(image, 0, 0);
					const data = context.getImageData(
						0,
						0,
						image.width,
						image.height,
					).data;
					let minX = image.width,
						maxX = 0,
						minY = image.height,
						maxY = 0,
						dark = 0;
					for (let y = 0; y < image.height; y++)
						for (let x = 0; x < image.width; x++) {
							const index = (y * image.width + x) * 4;
							if (data[index + 3] > 128 && data[index] < 40) {
								dark++;
								minX = Math.min(minX, x);
								maxX = Math.max(maxX, x);
								minY = Math.min(minY, y);
								maxY = Math.max(maxY, y);
							}
						}
					return {
						dark,
						left: minX / image.width,
						right: maxX / image.width,
						top: minY / image.height,
						bottom: maxY / image.height,
					};
				} finally {
					image.close();
				}
			},
			[...latest],
		);
		expect(pixels.dark).toBeGreaterThan(100);
		expect(pixels.left).toBeCloseTo(0.2, 1);
		expect(pixels.right).toBeCloseTo(0.8, 1);
		expect(pixels.top).toBeCloseTo(0.25, 1);
		expect(pixels.bottom).toBeCloseTo(0.75, 1);
		await signature.getByRole("button", { name: /Clear signature/ }).click();
		await expect(signature.getByRole("status")).toHaveText(
			"Signature cleared.",
		);
		expect(
			await page.evaluate(
				() => window.previewAttachmentsAudit.answers().signature,
			),
		).toBe("");
		await signature.getByRole("button", { name: /Undo/ }).click();
		await expect(signature.getByRole("status")).toHaveText("Signature saved.");
		expect(
			attempts.filter((attempt) => attempt.filename === "signature.png"),
		).toHaveLength(3);
	} finally {
		try {
			await page.evaluate(() => window.previewAttachmentsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});
