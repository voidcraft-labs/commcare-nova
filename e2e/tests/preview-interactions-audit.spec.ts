import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";
import type {} from "../lib/preview-interactions-client";

test("Preview drag adapters commit native pointer drops and restore cursor when the canvas retires", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-interactions-client.tsx");
	try {
		await page.goto(peer.origin);
		await expect(
			page.getByRole("region", { name: "Drag canvas" }),
		).toBeVisible();
		const ids = await page.evaluate(() => window.previewInteractionsAudit.ids);
		const first = page.locator(`[data-drag-row="${ids[0]}"]`);
		const third = page.locator(`[data-drag-row="${ids[2]}"]`);
		await first.dragTo(third, { targetPosition: { x: 30, y: 65 } });
		await expect
			.poll(() => page.evaluate(() => window.previewInteractionsAudit.order()))
			.toEqual([ids[1], ids[2], ids[0]]);
		await expect(
			page.getByRole("region", { name: "Drag canvas" }),
		).toHaveAttribute("data-drag-active", "false");
		await page.evaluate(() => {
			document.body.style.cursor = "crosshair";
		});
		const box = await first.boundingBox();
		if (box === null) throw new Error("Missing drag source rectangle");
		await page.mouse.move(box.x + 20, box.y + 20);
		await page.mouse.down();
		await page.mouse.move(box.x + 50, box.y + 30, { steps: 4 });
		await expect
			.poll(() => page.evaluate(() => document.body.style.cursor))
			.toBe("grabbing");
		await page.evaluate(() => window.previewInteractionsAudit.unmountCanvas());
		await expect(page.getByRole("region", { name: "Drag canvas" })).toHaveCount(
			0,
		);
		await expect
			.poll(() => page.evaluate(() => document.body.style.cursor))
			.toBe("crosshair");
		await page.mouse.up();
	} finally {
		try {
			await page.evaluate(() => window.previewInteractionsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});

test("Preview text editing retains rejected drafts, retries, cancels and navigates between native editors", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/preview-interactions-client.tsx");
	try {
		await page.goto(peer.origin);
		const back = page.getByRole("button", { name: "Go back", exact: true });
		await back.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByLabel("Back activations")).toHaveText("1");
		await expect(back).toBeDisabled();
		await page
			.getByRole("button", { name: "First label", exact: true })
			.click();
		const first = page.locator('[data-editor="first"] .ProseMirror');
		await expect(first).toBeFocused();
		await first.fill("Rejected draft");
		await first.press("ControlOrMeta+Enter");
		await expect(page.getByRole("alert")).toContainText(
			"This draft was refused",
		);
		await expect(first).toHaveText("Rejected draft");
		await first.fill("Accepted label");
		await first.press("Tab");
		await expect(
			page.getByRole("button", { name: "Accepted label", exact: true }),
		).toBeVisible();
		const second = page.locator('[data-editor="second"] .ProseMirror');
		await expect(second).toBeFocused();
		await second.fill("Discard me");
		await second.press("Escape");
		await expect(
			page.getByRole("button", { name: "Second label", exact: true }),
		).toBeVisible();
		await expect(page.getByText("Discard me", { exact: true })).toHaveCount(0);
	} finally {
		try {
			await page.evaluate(() => window.previewInteractionsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});

for (const finish of ["Escape", "outside", "placeholder"] as const) {
	test(`Preview native drag ${finish} respects the final browser drop target`, async ({
		page,
	}) => {
		const peer = await componentPeer("e2e/lib/preview-interactions-client.tsx");
		try {
			await page.goto(peer.origin);
			await expect(
				page.getByRole("region", { name: "Drag canvas" }),
			).toBeVisible();
			const ids = await page.evaluate(
				() => window.previewInteractionsAudit.ids,
			);
			const first = page.locator(`[data-drag-row="${ids[0]}"]`),
				third = page.locator(`[data-drag-row="${ids[2]}"]`);
			const a = await first.boundingBox(),
				b = await third.boundingBox();
			if (!a || !b) throw new Error("Missing native drag rectangles");
			await page.mouse.move(a.x + 20, a.y + 20);
			await page.mouse.down();
			await page.mouse.move(b.x + 25, b.y + 60, { steps: 8 });
			await expect(
				page.getByRole("region", { name: "Drag canvas" }),
			).toHaveAttribute("data-landing-ready", "true");
			if (finish === "Escape") await page.keyboard.press("Escape");
			else if (finish === "outside") await page.mouse.move(3, 3, { steps: 5 });
			else {
				const gap = await page
					.locator("[data-native-placeholder]")
					.boundingBox();
				if (!gap) throw new Error("Missing real placeholder");
				await page.mouse.move(gap.x + 30, gap.y + 25, { steps: 5 });
			}
			await page.mouse.up();
			await expect(
				page.getByRole("region", { name: "Drag canvas" }),
			).toHaveAttribute("data-drag-active", "false");
			expect(
				await page.evaluate(() => window.previewInteractionsAudit.order()),
			).toEqual(finish === "placeholder" ? [ids[1], ids[2], ids[0]] : ids);
		} finally {
			try {
				await page.evaluate(() => window.previewInteractionsAudit?.dispose());
			} finally {
				try {
					await page.close();
				} finally {
					await peer.close();
				}
			}
		}
	});
}
