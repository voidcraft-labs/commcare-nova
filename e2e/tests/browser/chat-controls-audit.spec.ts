import type {} from "../../lib/chat-controls-client";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import type {} from "../../lib/toast-controls-client";

const asset = {
	id: "019a0000-0000-7000-8000-000000000061",
	contentHash: "a".repeat(64),
	mimeType: "image/png",
	kind: "image",
	extension: ".png",
	sizeBytes: 68,
	originalFilename: "visit-photo.png",
	status: "ready",
	createdAt: "2026-09-06T00:00:00Z",
};
const imageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=",
	"base64",
);
test("Chat native controls retain the actual draft and picked asset through the hidden composer", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/chat-controls-client.tsx");
	try {
		await page.route("**/api/user/usage", (route) =>
			route.fulfill({
				json: {
					period: "2026-09",
					allowance: 1000,
					consumed: 0,
					bonus: 0,
					balance: 1000,
					lifetimeConsumed: 0,
				},
			}),
		);
		await page.route("**/api/media/library?*", (route) =>
			route.fulfill({ json: { assets: [asset], nextCursor: null } }),
		);
		await page.route(`**/api/media/${asset.id}*`, (route) =>
			route.fulfill({ contentType: "image/png", body: imageBytes }),
		);
		await page.goto(peer.origin);
		const input = page.getByRole("textbox");
		const oversized = "x".repeat(
			(await page.evaluate(() => window.chatControlsAudit.messageLimit)) + 1,
		);
		await input.fill(oversized);
		await expect(
			page.getByRole("button", { name: "Send", exact: true }),
		).toBeDisabled();
		await input.press("Enter");
		await expect(input).toHaveValue(oversized);
		expect(await page.evaluate(() => window.chatControlsAudit.sent())).toEqual(
			[],
		);
		await input.fill("Keep this pending request");
		await page.evaluate(() =>
			window.chatControlsAudit.armAccessRefreshOnSubmit(),
		);
		await input.press("Enter");
		await expect
			.poll(() => page.evaluate(() => window.chatControlsAudit.accessPhase()))
			.toBe("refreshing");
		await expect(input).toHaveValue("Keep this pending request");
		expect(await page.evaluate(() => window.chatControlsAudit.sent())).toEqual(
			[],
		);
		await page.evaluate(() => window.chatControlsAudit.restoreAccess());
		await expect
			.poll(() => page.evaluate(() => window.chatControlsAudit.accessPhase()))
			.toBe("authorized");

		await input.fill("Keep this visit request");
		await page
			.getByRole("button", { name: "Attach a file", exact: true })
			.click();
		const dialog = page.getByRole("dialog", { name: "Attach media" });
		await expect(dialog).toBeVisible();
		await dialog.getByRole("tab", { name: "Library", exact: true }).click();
		await dialog
			.getByRole("button", { name: "Choose visit-photo.png", exact: true })
			.click();
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Remove visit-photo.png" }),
		).toBeVisible();
		await page.getByRole("button", { name: "Hide composer" }).click();
		await expect(input).toBeHidden();
		await page.getByRole("button", { name: "Restore composer" }).click();
		await expect(input).toHaveValue("Keep this visit request");
		await expect(
			page.getByRole("button", { name: "Remove visit-photo.png" }),
		).toBeVisible();
		await input.focus();
		await page.keyboard.press("Enter");
		await expect
			.poll(() => page.evaluate(() => window.chatControlsAudit.sent()))
			.toEqual([
				{
					text: "Keep this visit request",
					attachments: [
						{
							assetId: asset.id,
							kind: "image",
							filename: "visit-photo.png",
							mimeType: "image/png",
						},
					],
				},
			]);
		await expect(input).toHaveValue("");
		await expect(
			page.getByRole("button", { name: "Remove visit-photo.png" }),
		).toHaveCount(0);
	} finally {
		try {
			await page.evaluate(() => window.chatControlsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});
test("Chat native keyboard answers once, selects field identity, and leaves reader-owned reasoning open", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/chat-controls-client.tsx");
	try {
		await page.route("**/api/user/usage", (route) =>
			route.fulfill({
				json: {
					period: "2026-09",
					allowance: 1000,
					consumed: 0,
					bonus: 0,
					balance: 1000,
					lifetimeConsumed: 0,
				},
			}),
		);
		await page.goto(peer.origin);
		const outline = page.getByRole("article", { name: "Reviewed design" });
		const people = outline.getByRole("button", { name: /Who uses it/ });
		await expect(outline.getByText("Clinic nurses")).toBeHidden();
		await people.focus();
		await page.keyboard.press("Enter");
		await expect(outline.getByText("Clinic nurses")).toBeVisible();
		await page.getByRole("button", { name: "App materializes" }).click();
		await expect(outline).toHaveCount(0);
		const build = page.getByRole("region", { name: "Build progress" });
		await expect(build.getByRole("listitem")).toHaveText([
			"RegistrationBuilt",
			"Follow-upBuilding",
		]);
		const tools = page.getByRole("region", { name: "Tool changes" });
		const batch = tools.getByRole("button", { name: "2 changes" });
		await expect(tools.getByText("Adding fields")).toBeHidden();
		await batch.focus();
		await page.keyboard.press("Enter");
		await expect(tools.getByText("Adding fields")).toBeVisible();
		const findings = tools.getByRole("button", { name: "2 issues found" });
		await expect(tools.getByText("A field needs a label.")).toBeHidden();
		await findings.focus();
		await page.keyboard.press("Enter");
		await expect(tools.getByRole("listitem")).toHaveText([
			"A field needs a label.",
			"A form needs a question.",
		]);
		await page.keyboard.press("Enter");
		await expect(tools.getByText("A field needs a label.")).toBeHidden();

		const answer = page.getByRole("button", { name: "Clinic", exact: true });
		await answer.focus();
		await page.keyboard.press("Enter");
		await expect
			.poll(() => page.evaluate(() => window.chatControlsAudit.answers()))
			.toEqual([
				{
					tool: "askQuestions",
					toolCallId: "native-round",
					output: { "0": "Clinic" },
				},
			]);
		await expect(answer).toHaveCount(0);
		const picker = page.getByRole("combobox", { name: "Closing answer" });
		await expect(picker).toHaveValue("notes");
		await page
			.getByRole("button", { name: "Peer renames selected field" })
			.click();
		await expect(picker).toHaveValue("renamed_notes");
		await picker.fill("Visit");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect
			.poll(() => page.evaluate(() => window.chatControlsAudit.changes()))
			.toEqual([await page.evaluate(() => window.chatControlsAudit.fieldId)]);
		const reasoning = page.getByRole("region", { name: "Reasoning" });
		const trigger = reasoning.locator("[data-slot='collapsible-trigger']");
		await trigger.focus();
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "Finish streaming" }).click();
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
		await expect(trigger).toContainText("Thought for");
		await test.step("Reader keeps reasoning open beyond its automatic close deadline", async () => {
			// The production auto-close delay is 1000 ms. Real browser time must
			// pass that deadline to distinguish reader ownership from a close
			// that has merely not fired yet; Motion and RAF keep running normally.
			await page.evaluate(
				() =>
					new Promise<void>((resolve) => {
						window.setTimeout(resolve, 1100);
					}),
			);
			await expect(trigger).toHaveAttribute("aria-expanded", "true");
			await expect(
				reasoning.getByText("Check the visit workflow."),
			).toBeVisible();
		});
	} finally {
		try {
			await page.evaluate(() => window.chatControlsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});

test("Project toast retires visible text and actions synchronously with real Motion exit ownership", async ({
	page,
}) => {
	const peer = await componentPeer("e2e/lib/toast-controls-client.tsx");
	try {
		await page.goto(peer.origin);
		await page.getByRole("button", { name: "Show scoped notice" }).click();
		await expect(page.getByText("Source-only detail")).toBeVisible();
		await page.getByRole("button", { name: "Retire Project" }).click();
		expect(
			await page.evaluate(() =>
				window.toastControlsAudit.synchronouslyHidden(),
			),
		).toBe(true);
		await expect(page.getByText("Source-only detail")).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Apply source action" }),
		).toHaveCount(0);
		expect(await page.evaluate(() => window.toastControlsAudit.actions())).toBe(
			0,
		);
	} finally {
		try {
			await page.evaluate(() => window.toastControlsAudit?.dispose());
		} finally {
			try {
				await page.close();
			} finally {
				await peer.close();
			}
		}
	}
});
