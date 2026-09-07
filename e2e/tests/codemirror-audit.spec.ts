import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";

test("CodeMirror completes live field identities, retains refused drafts and commits through the document gate", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/codemirror-audit-client.tsx");
	try {
		await page.goto(peer.origin);
		const authoring = page.getByRole("region", { name: "XPath authoring" });
		const saved = page.getByLabel("Saved XPath");
		await expect(saved).toHaveText("1");
		await authoring.getByRole("button").first().click();
		const editor = authoring.locator('.cm-content[contenteditable="true"]');
		await expect(editor).toBeFocused();
		await editor.fill("#form/a");
		const completions = page.locator(".cm-tooltip-autocomplete");
		await expect(completions).toBeVisible();
		await completions.getByText("#form/age", { exact: true }).click();
		await expect(editor).toBeVisible();
		await expect(saved).toHaveText("1");
		await editor.press("ControlOrMeta+Enter");
		await expect(saved).toHaveText("#form/age");
		await expect(page.getByLabel("Accepted edits")).toHaveText("1");
		await expect(editor).toHaveCount(0);

		await authoring.getByRole("button").first().click();
		await editor.fill("(");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(editor).toBeFocused();
		await expect(saved).toHaveText("#form/age");
		await editor.fill("#form/dependent");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(editor).toBeVisible();
		await expect(saved).toHaveText("#form/age");
		await expect(page.getByLabel("Accepted edits")).toHaveText("1");
		await editor.fill("#form/age + 1");
		await editor.press("ControlOrMeta+Enter");
		await expect(saved).toHaveText("#form/age + 1");
		await expect(page.getByLabel("Accepted edits")).toHaveText("2");

		await authoring.getByRole("button").first().click();
		await editor.fill("#form/a");
		await expect(completions).toBeVisible();
		await editor.press("Escape");
		await expect(completions).toHaveCount(0);
		await expect(editor).toBeFocused();
		await expect(saved).toHaveText("#form/age + 1");
		await editor.press("Escape");
		await expect(editor).toHaveCount(0);
		await expect(saved).toHaveText("#form/age + 1");
		await expect(page.getByLabel("Accepted edits")).toHaveText("2");
		await page.getByRole("button", { name: "Retire editor" }).click();
		await expect(authoring.locator(".cm-editor")).toHaveCount(0);
	} finally {
		await page.close();
		await peer.close();
	}
});
