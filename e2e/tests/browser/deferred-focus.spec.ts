import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

test("deferred handoffs yield to newer interaction and expire with their owner", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/deferred-focus-client.tsx");
	try {
		await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
		await page.goto(peer.origin);
		const other = page.getByRole("textbox", { name: "Other", exact: true });
		const schedule = page.getByRole("button", { name: "Schedule focus" });
		await expect(schedule).toBeVisible();
		await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
		const trigger = async (name: string) => {
			await page
				.getByRole("button", { name, exact: true })
				.evaluate((button: HTMLButtonElement) => button.click());
		};
		try {
			await trigger("Schedule focus");
			await page.clock.runFor(32);
			await expect(
				page.getByRole("textbox", { name: "Target", exact: true }),
			).toBeFocused();

			await trigger("Schedule focus");
			await other.focus();
			await page.clock.runFor(32);
			await expect(other).toBeFocused();

			await trigger("Schedule focus");
			await other.press("x");
			await page.clock.runFor(32);
			await expect(other).toBeFocused();
			await expect(other).toHaveValue("x");

			await trigger("Schedule focus");
			await other.dispatchEvent("pointerdown");
			await page.clock.runFor(32);
			await expect(other).toBeFocused();

			await trigger("Schedule focus");
			await trigger("Replace focus");
			await page.clock.runFor(32);
			await expect(
				page.getByRole("textbox", { name: "Newest", exact: true }),
			).toBeFocused();

			await trigger("Remove First");
			await expect(
				page.getByRole("button", { name: "Remove First" }),
			).toHaveCount(0);
			await page.clock.runFor(32);
			await expect(
				page.getByRole("button", { name: "Remove Second" }),
			).toBeFocused();

			await trigger("Remove Second");
			await expect(
				page.getByRole("button", { name: "Remove Second" }),
			).toHaveCount(0);
			await other.focus();
			await page.clock.runFor(32);
			await expect(other).toBeFocused();

			await trigger("Clear slot");
			await expect(
				page.getByRole("button", { name: "Add slot" }),
			).toBeVisible();
			await page.clock.runFor(32);
			await expect(
				page.getByRole("button", { name: "Add slot" }),
			).toBeFocused();

			await other.focus();
			await trigger("Schedule focus");
			await trigger("Unmount");
			await expect(schedule).toHaveCount(0);
			await page.clock.runFor(32);
			await expect(other).toBeFocused();
		} finally {
			await page.clock.resume();
		}
	} finally {
		await peer.close();
	}
});
