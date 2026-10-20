import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

test("A saved expression follows a question rename and a case property rename", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/expression-rename-client.tsx");
	try {
		await page.goto(peer.origin);
		const condition = page.getByRole("region", { name: "Display condition" });
		const savedCondition = page.getByLabel("Saved condition");
		await expect(savedCondition).toHaveText("");

		// Type a relative read of the select and save it.
		await condition.getByRole("button").first().click();
		const editor = condition.locator('.cm-content[contenteditable="true"]');
		await expect(editor).toBeFocused();
		await editor.pressSequentially("../a = 'yes'");
		await expect(editor).toContainText("= 'yes'");
		await editor.press("ControlOrMeta+Enter");
		await expect(savedCondition).toHaveText("../a = 'yes'");
		await expect(editor).toHaveCount(0);
		// The read shows as the question's chip, standing for its text.
		await expect(condition.locator('[data-ref-raw="../a"]')).toHaveText(
			"Attending",
		);

		// Renaming the question respells the stored read in place.
		await page.getByRole("button", { name: "Rename the question" }).click();
		await expect(savedCondition).toHaveText("../c = 'yes'");
		await expect(condition.locator('[data-ref-raw="../c"]')).toHaveText(
			"Attending",
		);

		// A records query names its property, and follows that property's rename.
		const calculation = page.getByRole("region", { name: "Calculated value" });
		const savedCalculation = page.getByLabel("Saved calculation");
		await expect(savedCalculation).toContainText("[status_note = 'x']");
		await expect(calculation).toContainText("status_note = 'x'");
		await page.getByRole("button", { name: "Rename the property" }).click();
		await expect(savedCalculation).toContainText("[note = 'x']");
		await expect(calculation).toContainText("note = 'x'");
		await expect(calculation).not.toContainText("status_note");
	} finally {
		await page.close();
		await peer.close();
	}
});
