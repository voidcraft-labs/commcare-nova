import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/preview-repeats-client";

// The language journey's document runs only on Android, so Preview plays
// Android's screens there: the labeled group "Visit details" is one screen
// with no group card, and its location is recorded from the browser's
// position in place of the phone's GPS (`context.setGeolocation`, a fix of 4
// metres, which Android takes at once). The visit's starting value is
// `'2024-01-15T14:30:00.000-05:00'`. Core holds a date-and-time answer as its
// instant, written in the device's zone (`DateTimeData.uncast`), and the
// browser stands in for the device, so the held text and the shown clock
// follow the browser's zone: New York keeps both as authored on every runner,
// and Kolkata, whose offset is neither the stored one nor a runner's UTC,
// shows the clock converted into its zone on the authored calendar day:
// Core's cast converts only the clock and keeps the day it was written on
// (`DateUtils.parseTimeAndStore`), as Preview's cast does
// (`XPathDate.parse`).

test.use({ timezoneId: "America/New_York" });

async function openLanguageJourney(page: Page, peerOrigin: string) {
	await page.context().grantPermissions(["geolocation"]);
	await page
		.context()
		.setGeolocation({ latitude: 40, longitude: -74, accuracy: 4 });
	await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto(`${peerOrigin}/?language`);
}

async function attachFailure(page: Page, testInfo: TestInfo, name: string) {
	const snapshot = testInfo.outputPath(`${name}-aria.txt`);
	await writeFile(snapshot, await page.locator("body").ariaSnapshot());
	await testInfo.attach(`${name}-accessibility`, {
		path: snapshot,
		contentType: "text/plain",
	});
	const screenshot = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path: screenshot, fullPage: true });
	await testInfo.attach(`${name}-failure`, {
		path: screenshot,
		contentType: "image/png",
	});
}

async function closeJourney(page: Page, peer: { close(): Promise<void> }) {
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

test.describe("on Android, in a zone the stored offset matches", () => {
	test.use({ timezoneId: "America/New_York" });

	test("worker date, recorded location and live announcements switch language without replacing answers", async ({
		page,
	}, testInfo) => {
		const peer = await componentPeer("e2e/lib/preview-repeats-client.tsx");
		await page.route(`${peer.origin}/api/auth/get-session`, (route) =>
			route.fulfill({ json: null }),
		);
		try {
			await openLanguageJourney(page, peer.origin);
			const date = page.getByRole("button", { name: /Visit date/ });
			await expect(date).toHaveAccessibleName(/Question 1.*Required/);
			// Android draws no group card: a screen's groups are its header.
			await expect(
				page.getByRole("button", { name: /^Collapse.*Visit details/ }),
			).toHaveCount(0);
			await date.click();
			await page.getByRole("button", { name: /January 9th, 2024/ }).click();
			await page
				.getByRole("button", { name: "Record location", exact: true })
				.click();
			await expect(
				page.getByRole("button", { name: "Replace location", exact: true }),
			).toBeVisible();
			await expect(page.getByText(`Latitude: N 40°0'0"`)).toBeVisible();
			await expect
				.poll(() =>
					page.evaluate(() => window.previewRepeatsAudit.answerValues()),
				)
				.toMatchObject({
					"/data/visit/date": "2024-01-09",
					"/data/visit/recorded_at": "2024-01-15T14:30:00.000-05:00",
					"/data/visit/location": "40.0 -74.0 0.0 4.0",
				});
			// A language switch rebuilds the entry, and the rebuilding form takes no
			// answers until it is idle again. The localized text commits with the
			// switch, so once it shows, the rebuild has begun and the body's busy
			// state covers it.
			const formBody = page.locator("[data-preview-form-body]");
			await page.getByRole("button", { name: "Español", exact: true }).click();
			await expect(date).toHaveText("9 de enero de 2024");
			await expect(formBody).toHaveAttribute("aria-busy", "false");
			await expect(date).toHaveAccessibleName(/Pregunta 1.*Obligatoria/);
			await expect(
				page.getByRole("button", { name: "Fecha", exact: true }),
			).toHaveText("15 de enero de 2024");
			await expect(
				page.getByRole("textbox", { name: "Hora", exact: true }),
			).toHaveValue("2:30 PM");
			await expect(
				page.getByRole("button", { name: "Reemplazar ubicación", exact: true }),
			).toBeVisible();
			await expect(page.getByText(`Latitud: N 40°0'0"`)).toBeVisible();
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
					"/data/visit/location": "40.0 -74.0 0.0 4.0",
				});
			// Observe ordinary blur first, then switch with a new partial clock.
			// Language must add no remount/reset; the clock's existing blur
			// normalization still owns its commit.
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
			await spanishClock.fill("2:4");
			await page.getByRole("button", { name: "English", exact: true }).click();
			await expect(
				page.getByRole("textbox", { name: "Time", exact: true }),
			).toHaveValue("2:4");
			await expect(formBody).toHaveAttribute("aria-busy", "false");
			await expect
				.poll(() =>
					page.evaluate(() => window.previewRepeatsAudit.answerValues()),
				)
				.toMatchObject({
					"/data/visit/date": "2024-01-09",
					"/data/visit/recorded_at": "2024-01-15T2:4",
					"/data/visit/location": "40.0 -74.0 0.0 4.0",
				});
			await page.getByRole("button", { name: "Español", exact: true }).click();
			await expect(
				page.getByRole("textbox", { name: "Hora", exact: true }),
			).toHaveValue("2:4");
			await expect(formBody).toHaveAttribute("aria-busy", "false");
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
			// The repeat after the group is another screen on a phone, so this
			// screen draws none of it.
			await expect(
				page.getByRole("textbox", { name: /Visit note/ }),
			).toHaveCount(0);
			await page.getByRole("button", { name: "English", exact: true }).click();
			await expect(date).toHaveAccessibleName(/Question 1.*Required/);
			await expect(
				page.getByRole("button", { name: "Replace location", exact: true }),
			).toBeVisible();
		} catch (error) {
			await attachFailure(page, testInfo, "worker-form-language");
			throw error;
		} finally {
			await closeJourney(page, peer);
		}
	});
});

test.describe("on Android, in a zone the stored offset is not", () => {
	test.use({ timezoneId: "Asia/Kolkata" });

	test("a preloaded date and time reads in the device's zone, and its two halves answer only what the worker gives", async ({
		page,
	}, testInfo) => {
		const peer = await componentPeer("e2e/lib/preview-repeats-client.tsx");
		await page.route(`${peer.origin}/api/auth/get-session`, (route) =>
			route.fulfill({ json: null }),
		);
		try {
			await openLanguageJourney(page, peer.origin);
			const dateHalf = page.getByRole("button", { name: "Date", exact: true });
			const clock = page.getByRole("textbox", { name: "Time", exact: true });

			await test.step("a preloaded answer's clock is converted to the device's zone", async () => {
				// 14:30 at -05:00 is 01:00 in Kolkata (+05:30). Core moves the
				// clock and keeps the authored day, so a device there holds
				// 01:00 on January 15, and both halves read what it holds.
				await expect(dateHalf).toHaveText("January 15, 2024");
				await expect(clock).toHaveValue("1:00 AM");
				await expect(clock).not.toHaveAttribute("aria-invalid", "true");
				await expect
					.poll(() =>
						page.evaluate(
							() =>
								window.previewRepeatsAudit.answerValues()[
									"/data/visit/recorded_at"
								],
						),
					)
					.toMatch(/^2024-01-15T01:00:00(\.000)?\+05:30$/);
			});

			await test.step("emptying the clock half answers nothing on the person's behalf", async () => {
				// The date's own midnight is a value nobody chose, and committing it
				// back here would make a cleared clock refill itself.
				await clock.fill("");
				await clock.blur();
				await expect(clock).toHaveValue("");
				await expect(dateHalf).not.toHaveText(/Pick a date/);
				await expect(clock).not.toHaveAttribute("aria-invalid", "true");
			});

			await test.step("a clock entered before its date reads back as typed", async () => {
				// Clear the date too, so the clock really is the only half there.
				// The join has to survive that: showing back "14:30:00" would be the
				// field rewriting the person's own "2:30 PM" into a spelling they
				// never used, and quoting the join at them in the error would put
				// punctuation they never typed on screen.
				await dateHalf.click();
				await page.getByRole("button", { name: "Clear", exact: true }).click();
				await expect(dateHalf).toHaveText(/Pick a date/);

				await clock.fill("2:30 PM");
				await clock.blur();
				await expect(clock).toHaveValue("2:30 PM");
				await expect(
					page.getByText("Pick a date: this question needs both."),
				).toBeVisible();

				// And clearing the remaining half empties the answer outright.
				await clock.fill("");
				await clock.blur();
				await expect(clock).toHaveValue("");
				await expect(
					page.getByText("Pick a date: this question needs both."),
				).toBeHidden();
			});
		} catch (error) {
			await attachFailure(page, testInfo, "worker-datetime-zone");
			throw error;
		} finally {
			await closeJourney(page, peer);
		}
	});
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
