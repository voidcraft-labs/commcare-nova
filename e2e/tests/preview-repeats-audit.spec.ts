import type { Locator } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";
import type {} from "../lib/preview-repeats-client";

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
			page.getByRole("spinbutton", { name: /Household size/ }),
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
