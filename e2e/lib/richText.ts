import { expect, type Locator } from "@playwright/test";

/** Keep the editor's selection state in step with its native DOM selection.
 * fill() replaces only the DOM range, which a pending ProseMirror focus can
 * overwrite before insertion. The keyboard command updates both together. */
export async function replaceRichText(editor: Locator, text: string) {
	await editor.press("ControlOrMeta+A");
	await editor.press("Backspace");
	await expect(editor).toHaveText("");
	await editor.pressSequentially(text);
	await expect(editor).toHaveText(text);
}
