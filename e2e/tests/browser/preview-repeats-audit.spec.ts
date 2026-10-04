import { writeFile } from "node:fs/promises";
import type { Locator } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-repeats-client";

test("worker date, manual location and live announcements switch language without replacing answers", async ({
	page,
}, testInfo) => {
	const peer = await componentPeer("e2e/lib/preview-repeats-client.tsx");
	await page.route(`${peer.origin}/api/auth/get-session`, (route) =>
		route.fulfill({ json: null }),
	);
	try {
		await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto(`${peer.origin}/?language`);
		const date = page.getByRole("button", { name: /Visit date/ });
		await expect(date).toHaveAccessibleName(/Question 1.*Required/);
		await date.click();
		await page.getByRole("button", { name: /January 9th, 2024/ }).click();
		await page
			.getByRole("button", { name: "Enter coordinates manually", exact: true })
			.click();
		await page
			.getByRole("spinbutton", { name: "Latitude", exact: true })
			.fill("40");
		await page
			.getByRole("spinbutton", { name: "Longitude", exact: true })
			.fill("-74");
		await page
			.getByRole("textbox", { name: /Visit note/ })
			.fill("Retained note");
		await expect
			.poll(() =>
				page.evaluate(() => window.previewRepeatsAudit.answerValues()),
			)
			.toMatchObject({
				"/data/visit/date": "2024-01-09",
				"/data/visit/recorded_at": "2024-01-15T14:30:00.000-05:00",
				"/data/visit/location": "40 -74 0 0",
				"/data/visits[0]/notes": "Retained note",
			});
		await page.getByRole("button", { name: "Español", exact: true }).click();
		await expect(date).toHaveText("9 de enero de 2024");
		await expect(date).toHaveAccessibleName(/Pregunta 1.*Obligatoria/);
		await expect(
			page.getByRole("button", { name: "Fecha", exact: true }),
		).toHaveText("15 de enero de 2024");
		await expect(
			page.getByRole("textbox", { name: "Hora", exact: true }),
		).toHaveValue("2:30 PM");
		await expect(
			page.getByRole("spinbutton", { name: "Latitud", exact: true }),
		).toHaveValue("40");
		await expect(
			page.getByRole("spinbutton", { name: "Longitud", exact: true }),
		).toHaveValue("-74");
		await expect(
			page.getByText(
				"El mapa no está disponible aquí. Puede introducir las coordenadas manualmente abajo.",
				{ exact: true },
			),
		).toBeVisible();
		await expect(page.getByText(/NEXT_PUBLIC_GOOGLE_MAPS/)).toHaveCount(0);
		await expect(
			page.getByRole("textbox", { name: /^Pregunta 4\./ }),
		).toHaveCount(1);
		await expect
			.poll(() =>
				page.evaluate(() => window.previewRepeatsAudit.answerValues()),
			)
			.toMatchObject({
				"/data/visit/date": "2024-01-09",
				"/data/visit/recorded_at": "2024-01-15T14:30:00.000-05:00",
				"/data/visit/location": "40 -74 0 0",
				"/data/visits[0]/notes": "Retained note",
			});
		// Observe ordinary blur first, then switch with a new partial clock and
		// an incomplete coordinate pair. Language must add no remount/reset;
		// the clock's existing blur normalization still owns its commit.
		const spanishClock = page.getByRole("textbox", {
			name: "Hora",
			exact: true,
		});
		await spanishClock.fill("2:3");
		await spanishClock.press("Tab");
		await expect(spanishClock).toHaveValue("2:3");
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						window.previewRepeatsAudit.answerValues()[
							"/data/visit/recorded_at"
						],
				),
			)
			.toBe("2024-01-15T2:3");
		await page
			.getByRole("spinbutton", { name: "Longitud", exact: true })
			.fill("");
		await page
			.getByRole("spinbutton", { name: "Latitud", exact: true })
			.fill("4");
		await spanishClock.fill("2:4");
		await page.getByRole("button", { name: "English", exact: true }).click();
		await expect(
			page.getByRole("textbox", { name: "Time", exact: true }),
		).toHaveValue("2:4");
		await expect(
			page.getByRole("spinbutton", { name: "Latitude", exact: true }),
		).toHaveValue("4");
		await expect(
			page.getByRole("spinbutton", { name: "Longitude", exact: true }),
		).toHaveValue("");
		await expect
			.poll(() =>
				page.evaluate(() => window.previewRepeatsAudit.answerValues()),
			)
			.toMatchObject({
				"/data/visit/date": "2024-01-09",
				"/data/visit/recorded_at": "2024-01-15T2:4",
				"/data/visit/location": "40 -74 0 0",
				"/data/visits[0]/notes": "Retained note",
			});
		await page
			.getByRole("spinbutton", { name: "Latitude", exact: true })
			.fill("40");
		await page
			.getByRole("spinbutton", { name: "Longitude", exact: true })
			.fill("-74");
		await page
			.getByRole("spinbutton", { name: "Longitude", exact: true })
			.press("Tab");
		await page.getByRole("button", { name: "Español", exact: true }).click();
		await expect(
			page.getByRole("textbox", { name: "Hora", exact: true }),
		).toHaveValue("2:4");
		await date.click();
		await expect(
			page.getByRole("button", { name: "Ir al mes siguiente" }),
		).toBeVisible();
		await page.getByRole("button", { name: "Borrar", exact: true }).click();
		await expect(date).toHaveText("Elegir una fecha");
		await expect
			.poll(() =>
				page.evaluate(
					() => window.previewRepeatsAudit.answerValues()["/data/visit/date"],
				),
			)
			.toBe("");
		await page
			.getByRole("button", { name: /^Contraer.*Sección 1.*Visit details/ })
			.click();
		await expect(
			page.getByRole("button", { name: /^Expandir.*Sección 1.*Visit details/ }),
		).toHaveAttribute("aria-expanded", "false");
		await page
			.getByRole("button", { name: /^Expandir.*Sección 1.*Visit details/ })
			.click();
		await page
			.getByRole("button", { name: "Borrar ubicación", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						window.previewRepeatsAudit.answerValues()["/data/visit/location"],
				),
			)
			.toBe("");
		await page.getByRole("button", { name: /^Añadir Visits/ }).click();
		await expect(page.getByText("Repetición 2", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: /^Contraer.*Repetición 2.*Visits/ }),
		).toBeVisible();
		await page.getByRole("button", { name: /Quitar.*Repetición 2$/ }).click();
		await expect(page.getByRole("textbox", { name: /Visit note/ })).toHaveCount(
			1,
		);
		await page.getByRole("button", { name: "English", exact: true }).click();
		await expect(date).toHaveAccessibleName(/Question 1.*Required/);
		await expect(page.getByRole("textbox", { name: /Visit note/ })).toHaveValue(
			"Retained note",
		);
	} catch (error) {
		const snapshot = testInfo.outputPath("worker-form-language-aria.txt");
		await writeFile(snapshot, await page.locator("body").ariaSnapshot());
		await testInfo.attach("worker-form-language-accessibility", {
			path: snapshot,
			contentType: "text/plain",
		});
		const screenshot = testInfo.outputPath("worker-form-language.png");
		await page.screenshot({ path: screenshot, fullPage: true });
		await testInfo.attach("worker-form-language-failure", {
			path: screenshot,
			contentType: "image/png",
		});
		throw error;
	} finally {
		try {
			if (!page.isClosed())
				await page.evaluate(() => window.previewRepeatsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});

async function distinctVisibleLabels(controls: Locator, question: string) {
	await expect(controls).toHaveCount(2);
	const labels = await controls.evaluateAll((elements) =>
		elements.map((element) => {
			const ids = (element.getAttribute("aria-labelledby") ?? "")
				.split(/\s+/)
				.filter(Boolean);
			return ids.map((id) => ({
				id,
				text: document.getElementById(id)?.textContent ?? "",
			}));
		}),
	);
	expect(labels[0].length).toBeGreaterThan(0);
	expect(labels[1].length).toBeGreaterThan(0);
	expect(labels[0].map((label) => label.id)).not.toEqual(
		labels[1].map((label) => label.id),
	);
	for (const references of labels)
		expect(references.map((label) => label.text).join(" ")).toContain(question);
	for (const control of await controls.all())
		await expect(control).toHaveAccessibleName(new RegExp(question));
}

test("Repeated Preview questions keep native accessible names and retained DOM identity when an earlier instance is removed", async ({
	page,
}, testInfo) => {
	const peer = await componentPeer(
		"e2e/lib/preview-repeats-client.tsx",
		[],
		{},
		{
			"process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY": '""',
			"process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID": '""',
		},
	);
	await page.route(`${peer.origin}/api/auth/get-session`, (route) =>
		route.fulfill({ json: null }),
	);
	try {
		await page.goto(peer.origin);
		const groupToggles = page.getByRole("button", {
			name: /Collapse.*Section [12].*Visit/,
		});
		await expect(groupToggles).toHaveCount(2);
		for (const toggle of await groupToggles.all()) {
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			const controlled = await toggle.getAttribute("aria-controls");
			expect(controlled).toBeTruthy();
			await expect(page.locator(`[id="${controlled}"]`)).toBeVisible();
		}
		await expect(
			page.getByRole("button", {
				name: /Section 1.*Visit.*Photo.*Attach file/,
			}),
		).toHaveCount(1);
		await expect(
			page.getByRole("button", {
				name: /Section 2.*Visit.*Photo.*Attach file/,
			}),
		).toHaveCount(1);
		const repeat = page.getByRole("button", {
			name: /Collapse.*Repeat 3.*Visits/,
		});
		await expect(repeat).toHaveAttribute("aria-expanded", "true");
		const content = await repeat.getAttribute("aria-controls");
		expect(content).toBeTruthy();
		await expect(page.locator(`[id="${content}"]`)).toBeVisible();
		await page.getByRole("button", { name: /^Add Visits/ }).click();
		await expect(
			page.getByRole("button", {
				name: /Repeat 3.*Instance 1.*Photo.*Attach file/,
			}),
		).toHaveCount(1);
		await expect(
			page.getByRole("button", {
				name: /Repeat 3.*Instance 2.*Photo.*Attach file/,
			}),
		).toHaveCount(1);
		const text = page.getByRole("textbox", { name: /Related patient case id/ });
		await distinctVisibleLabels(text, "Related patient case id");
		await distinctVisibleLabels(
			page.getByRole("textbox", { name: /Household size/ }),
			"Household size",
		);
		await distinctVisibleLabels(
			page.getByRole("button", { name: /Visit date/ }),
			"Visit date",
		);
		for (const label of [
			"Visit outcome",
			"Symptoms observed",
			"Visit location",
		])
			await distinctVisibleLabels(
				page.getByRole("group", { name: new RegExp(label) }),
				label,
			);
		// Hidden calculations never consume a position. Conditional siblings use
		// the concrete repeat instance, not another instance's visibility.
		await expect(text.nth(0)).toHaveAccessibleName(
			/Question 1\. Related patient/,
		);
		await expect(text.nth(1)).toHaveAccessibleName(
			/Question 1\. Related patient/,
		);
		const size = page.getByRole("textbox", { name: /Household size/ });
		await size.nth(0).fill("2");
		await expect(
			page.getByRole("textbox", { name: /Extra detail/ }),
		).toHaveCount(1);
		await expect(text.nth(0)).toHaveAccessibleName(
			/Question 2\. Related patient/,
		);
		await expect(text.nth(1)).toHaveAccessibleName(
			/Question 1\. Related patient/,
		);
		await size.nth(0).fill("1");
		await expect(
			page.getByRole("textbox", { name: /Extra detail/ }),
		).toHaveCount(0);
		await expect(text.nth(0)).toHaveAccessibleName(
			/Question 1\. Related patient/,
		);
		await text.nth(0).fill("removed patient");
		await text.nth(1).fill("retained patient");
		const retained = await text.nth(1).elementHandle();
		if (!retained) throw new Error("Missing retained native input");
		try {
			await page.getByRole("button", { name: /Remove.*Instance 1/ }).click();
			await expect(text).toHaveCount(1);
			await expect(text).toHaveValue("retained patient");
			expect(
				await text.evaluate(
					(element, previous) => element === previous,
					retained,
				),
			).toBe(true);
			await expect(text).toHaveAccessibleName(/Related patient case id/);
			await expect(
				page.getByRole("button", {
					name: /Repeat 3.*Instance 1.*Photo.*Attach file/,
				}),
			).toHaveCount(1);
			await expect(
				page.getByRole("button", {
					name: /Repeat 3.*Instance 2.*Photo.*Attach file/,
				}),
			).toHaveCount(0);
			await repeat.click();
			await expect(
				page.getByRole("button", { name: /Expand.*Repeat 3.*Visits/ }),
			).toHaveAttribute("aria-expanded", "false");
			await expect(text).toBeHidden();
		} finally {
			await retained.dispose();
		}
	} catch (error) {
		await testInfo.attach("repeat-accessibility", {
			body: await page.locator("body").ariaSnapshot(),
			contentType: "text/plain",
		});
		await testInfo.attach("capture-labels", {
			body: JSON.stringify(
				await page.locator('input[type="file"]').evaluateAll((elements) =>
					elements.map((el) => ({
						label: el.getAttribute("aria-labelledby"),
						texts: (el.getAttribute("aria-labelledby") ?? "")
							.split(" ")
							.map((id) => document.getElementById(id)?.textContent),
					})),
				),
			),
			contentType: "application/json",
		});
		throw error;
	} finally {
		try {
			await page.evaluate(() => window.previewRepeatsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});

test("adding a repeat initializes its bound rows without replacing earlier answers", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-repeats-client.tsx");
	await page.route(`${peer.origin}/api/auth/get-session`, (route) =>
		route.fulfill({ json: null }),
	);
	try {
		await page.goto(`${peer.origin}/?initialization`);
		const notes = page.getByRole("textbox", { name: /Asset note/ });
		await expect(notes).toHaveCount(2);
		await expect(notes.nth(0)).toHaveValue("pump");
		await expect(notes.nth(1)).toHaveValue("tap");
		await notes.nth(1).fill("Retain this answer");
		await page.getByRole("textbox", { name: /New visit zone/ }).fill("south");
		await page.getByRole("button", { name: /^Add Visits/ }).click();
		await expect(notes).toHaveCount(3);
		await expect(notes.nth(0)).toHaveValue("pump");
		await expect(notes.nth(1)).toHaveValue("Retain this answer");
		await expect(notes.nth(2)).toHaveValue("tank");
	} finally {
		await page.evaluate(() => window.previewRepeatsAudit?.dispose());
		await page.close();
		await peer.close();
	}
});

test("phone Preview omits automatic calculation shells and keeps meaningful repeat controls", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 320, height: 720 });
	const peer = await componentPeer("e2e/lib/preview-repeats-client.tsx");
	await page.route(`${peer.origin}/api/auth/get-session`, (route) =>
		route.fulfill({ json: null }),
	);
	try {
		await page.goto(`${peer.origin}/?presentation`);
		const details = page.getByRole("textbox", { name: /Show entry details/ });
		await expect(details).toBeVisible();
		await expect(page.getByText("Instance 1", { exact: true })).toHaveCount(1);
		await expect(page.getByText("Instance 2", { exact: true })).toHaveCount(0);
		const add = page.getByRole("button", { name: /^Add/ });
		await expect(add).toHaveCount(1);
		await expect(add).toHaveAccessibleName(/Add.*Repeat/);
		const addBox = await add.boundingBox();
		if (!addBox) throw new Error("Repeat control has no bounds.");
		expect(Math.round(addBox.height)).toBeGreaterThanOrEqual(44);
		await expect
			.poll(() =>
				page.evaluate(() => window.previewRepeatsAudit.calculationValues()),
			)
			.toEqual({
				"/data/processing[0]/computed": "7",
				"/data/processing[1]/computed": "7",
				"/data/query_processing[0]/row_id": "first",
				"/data/query_processing[1]/row_id": "second",
			});
		await add.click();
		await expect(page.getByText("Instance 2", { exact: true })).toHaveCount(1);
		await page.getByRole("button", { name: /Remove.*Instance 2/ }).click();
		await expect(page.getByText("Instance 2", { exact: true })).toHaveCount(0);
		await details.fill("yes");
		await expect(
			page.getByText("Visible entry detail", { exact: true }),
		).toBeVisible();
		await expect(page.getByText("Instance 1", { exact: true })).toHaveCount(2);
		await expect(page.getByText("Instance 2", { exact: true })).toHaveCount(0);
		await details.fill("no");
		await expect(
			page.getByText("Visible entry detail", { exact: true }),
		).toHaveCount(0);
		await expect(page.getByText("Instance 1", { exact: true })).toHaveCount(1);
		const intro = await page
			.getByText("Review this visit before continuing", { exact: true })
			.boundingBox();
		const review = await page
			.getByText("Your visit is ready to review", { exact: true })
			.boundingBox();
		if (!intro || !review) throw new Error("Review copy has no bounds.");
		expect(intro.y).toBeLessThan(review.y);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBeLessThanOrEqual(320);
		await testInfo.attach("phone-worker-presentation", {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	} finally {
		try {
			await page.evaluate(() => window.previewRepeatsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});
