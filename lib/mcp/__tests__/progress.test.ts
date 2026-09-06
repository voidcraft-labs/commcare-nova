import { expect, it } from "vitest";
import { z } from "zod";
import { createProgressEmitter } from "../progress";
import { withMcpClient } from "./client";

it("delivers ordered progress through the real request context and resets the counter for each call", async () => {
	await withMcpClient(
		(server) => {
			server.registerTool(
				"progress",
				{ inputSchema: z.object({}) },
				async (_, ctx) => {
					const progress = createProgressEmitter(
						ctx.mcpReq.notify,
						ctx.mcpReq._meta?.progressToken,
					);
					progress.notify("app_created", "Created");
					progress.notify("module_added", "Added", { app_id: "app", count: 2 });
					return { content: [{ type: "text", text: "Complete" }] };
				},
			);
		},
		async (client) => {
			for (let call = 0; call < 2; call++) {
				const updates: unknown[] = [];
				const result = await client.callTool(
					{ name: "progress", arguments: {} },
					{ onprogress: (update) => updates.push(update) },
				);
				expect(result.content).toEqual([{ type: "text", text: "Complete" }]);
				expect(result.isError).not.toBe(true);
				expect(updates).toEqual([
					{ progress: 1, message: "[app_created] Created" },
					{ progress: 2, message: "[module_added] Added | app_id=app count=2" },
				]);
			}
		},
	);
});

it("preserves zero and string tokens on the notification wire and does not send without opt-in", async () => {
	await withMcpClient(
		(server) => {
			server.registerTool(
				"progress",
				{ inputSchema: z.object({}) },
				async (_, ctx) => {
					createProgressEmitter(
						ctx.mcpReq.notify,
						ctx.mcpReq._meta?.progressToken,
					).notify("upload_started", "Uploading");
					return { content: [] };
				},
			);
		},
		async (client) => {
			const updates: unknown[] = [];
			client.setNotificationHandler(
				"notifications/progress",
				(notification) => {
					updates.push(notification.params);
				},
			);
			await client.callTool({ name: "progress", arguments: {} });
			expect(updates).toEqual([]);
			for (const progressToken of [0, "request"] as const) {
				await client.callTool({
					name: "progress",
					arguments: {},
					_meta: { progressToken },
				});
			}
			expect(updates).toEqual([
				{
					progressToken: 0,
					progress: 1,
					message: "[upload_started] Uploading",
				},
				{
					progressToken: "request",
					progress: 1,
					message: "[upload_started] Uploading",
				},
			]);
		},
	);
});

it("contains notification failure after the real client disconnects", async () => {
	const lateEmitters: ReturnType<typeof createProgressEmitter>[] = [];
	await withMcpClient(
		(server) => {
			server.registerTool(
				"progress",
				{ inputSchema: z.object({}) },
				async (_, ctx) => {
					lateEmitters.push(createProgressEmitter(ctx.mcpReq.notify, "late"));
					return { content: [] };
				},
			);
		},
		async (client) => {
			await client.callTool({ name: "progress", arguments: {} });
		},
	);
	expect(lateEmitters).toHaveLength(1);
	lateEmitters[0].notify("upload_complete", "Complete");
	// Let Node deliver rejected-promise notifications from the closed transport.
	// No test-side catch masks a missing rejection handler in the emitter.
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(() =>
		createProgressEmitter(undefined, 0).notify("upload_complete", "Complete"),
	).not.toThrow();
});
