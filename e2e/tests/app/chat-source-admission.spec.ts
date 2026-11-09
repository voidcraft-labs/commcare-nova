import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

for (const mode of ["build", "edit"] as const) {
	test(
		`a late source rejection preserves the ${mode} request for explicit ${mode === "build" ? "retry" : "removal"}`,
		{ tag: "@seed:open" },
		async ({ scenario, page }, testInfo) => {
			const seed = seedFor(scenario, "open");
			const assetId = "019a0000-0000-7000-8000-000000000063";
			await page.route("**/api/media/library?*", (route) =>
				route.fulfill({
					json: {
						assets: [
							{
								id: assetId,
								contentHash: "a".repeat(64),
								kind: "text",
								mimeType: "text/markdown",
								extension: ".md",
								sizeBytes: 14,
								originalFilename: "workflow.md",
								status: "ready",
								createdAt: "2026-11-01T00:00:00Z",
								extract: {
									status: "ready",
									version: EXTRACTOR_VERSION,
									truncated: false,
									charCount: 14,
									title: "Visit workflow",
								},
							},
						],
						nextCursor: null,
					},
				}),
			);
			const preparation = Promise.withResolvers<void>();
			let preparationRequests = 0;
			await page.route(`**/api/media/${assetId}/extract`, async (route) => {
				preparationRequests += 1;
				await preparation.promise;
				await route.fulfill({
					contentType: "application/x-ndjson",
					body: `${JSON.stringify({ type: "done", extract: { status: "ready", version: EXTRACTOR_VERSION, truncated: false, charCount: 14 } })}\n`,
				});
			});
			const posts: { messages: NovaUIMessage[] }[] = [];
			try {
				await page.route("**/api/chat", async (route) => {
					if (route.request().method() !== "POST") return route.fallback();
					const body = route.request().postDataJSON() as {
						messages: NovaUIMessage[];
					};
					posts.push(body);
					if (posts.length === 1) {
						const last = body.messages.at(-1);
						if (!last) throw new Error("No submitted message");
						await route.fulfill({
							status: 409,
							json: {
								code: "source_not_admitted",
								type: "attachment_unavailable",
								error:
									"I couldn't read workflow.md. You can try again or send without its files.",
								references: [{ messageId: last.id, assetId }],
							},
						});
						return;
					}
					const chunks = [
						{ type: "start", messageId: "source-recovery-reply" },
						{ type: "start-step" },
						{ type: "text-start", id: "reply" },
						{
							type: "text-delta",
							id: "reply",
							delta: "Your request can continue.",
						},
						{ type: "text-end", id: "reply" },
						{ type: "finish-step" },
						{ type: "finish" },
					];
					await route.fulfill({
						contentType: "text/event-stream",
						headers: {
							"x-workflow-run-id": "00000000-0000-4000-8000-000000000098",
						},
						body: `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					});
				});
				await openBuilder(
					page,
					mode === "build" ? "/build/new" : `/build/${seed.openAppId}`,
				);
				// The textarea is named by its placeholder in the ordinary composer.
				const composer = page.getByPlaceholder(
					mode === "build"
						? "Describe your app"
						: "What would you like to change?",
				);
				await composer.fill("Use this workflow for household visits");
				await page
					.getByRole("button", { name: "Attach a file", exact: true })
					.click();
				const picker = page.getByRole("dialog", { name: "Attach media" });
				await picker.getByRole("tab", { name: "Library", exact: true }).click();
				await picker
					.getByRole("button", {
						name: "Choose Visit workflow, file workflow.md",
						exact: true,
					})
					.click();
				await expect(picker).toBeHidden();
				await page.getByRole("button", { name: "Send", exact: true }).click();
				const recovery = page
					.getByRole("alert")
					.filter({ hasText: "Message not sent" });
				await expect(recovery).toBeVisible();
				expect(posts).toHaveLength(1);
				await expect(
					page.getByPlaceholder("What would you like to change?"),
				).toBeDisabled();
				await expect(
					page.getByRole("button", { name: "Send", exact: true }),
				).toBeDisabled();
				await page.screenshot({
					path: testInfo.outputPath("source-recovery.png"),
				});
				await recovery
					.getByRole("button", {
						name:
							mode === "build" ? "Read files and retry" : "Send without files",
						exact: true,
					})
					.click();
				if (mode === "build") {
					await expect(
						recovery.getByRole("button", {
							name: "Reading files",
							exact: true,
						}),
					).toBeDisabled();
					await expect(
						recovery.getByRole("button", {
							name: "Send without files",
							exact: true,
						}),
					).toBeDisabled();
					await expect.poll(() => preparationRequests).toBe(1);
					expect(posts).toHaveLength(1);
					preparation.resolve();
				}
				await expect(
					page.getByText("Your request can continue.", { exact: true }),
				).toBeVisible();
				await expect(recovery).toBeHidden();
				expect(posts).toHaveLength(2);
				const first = posts[0].messages.at(-1);
				const retried = posts[1].messages.at(-1);
				expect(retried?.id).toBe(first?.id);
				expect(retried?.parts).toEqual(first?.parts);
				expect(retried?.metadata?.attachments).toEqual(
					mode === "build" ? first?.metadata?.attachments : [],
				);
				if (mode === "edit") expect(preparationRequests).toBe(0);
			} finally {
				preparation.resolve();
			}
		},
	);
}
