/** Pure result projection, plus the SDK's input grammar; actual dispatch and
 * persistence live in the Postgres suite. The adapter and registry load at
 * import (about a second locally, several on a loaded CI shard), so the module
 * graph is paid once by the file rather than inside one test's timeout; the
 * SDK calls themselves take milliseconds. */
import { expect, it, vi } from "vitest";
import { executeWorkTool } from "@/lib/agent/authoring/session";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { savedDataReview } from "@/lib/agent/toolResults";
import { log } from "@/lib/logger";
import { registerSharedTool } from "../adapters/sharedToolAdapter";
import { projectResult } from "../resultProjection";
import { withMcpClient } from "./client";
import { resultContentText } from "./resultText";

vi.mock("@/lib/agent/authoring/session", () => ({ executeWorkTool: vi.fn() }));

it("preserves read data, including keys also used by the chat UI", () => {
	for (const data of [
		null,
		"Text",
		[1, 2],
		{ summary: "a data field", message: "stored text" },
	]) {
		expect(projectResult({ kind: "read", data })).toEqual(data);
	}
});

it("removes write presentation while retaining identities, confirmation and errors", () => {
	for (const result of [
		{ ok: true },
		{ ok: true, uuid: "identity", options: [{ uuid: "option" }] },
		{ needsConfirmation: { confirmConversion: true } },
		{ error: "Choose a different name." },
	]) {
		expect(
			projectResult({
				kind: "mutate",
				mutations: [],
				result: { ...result, summary: { subject: "private UI" } },
			}),
		).toEqual(result);
	}
});

it("retains a saved-data consequence even when later tool reporting fails", () => {
	const dataReview = savedDataReview({
		parked: 2,
		failureReasons: ["a", "b", "c", "d"],
	});
	expect(dataReview).toEqual({
		values: 2,
		reasons: ["a", "b", "c"],
		additionalReasons: 1,
		location: "Case data",
	});
	for (const result of [
		{ ok: true, uuid: "field" },
		{ error: "Could not finish reporting the change." },
	]) {
		expect(
			projectResult({ kind: "mutate", mutations: [], result }, dataReview),
		).toEqual({ ...result, dataReview });
	}
});

// The transport grammar must reject ambiguous targets before authorizing either
// resource, and old nested creation input must never disappear by stripping.
it("rejects ambiguous read targets and obsolete creation grammar through the real SDK", async () => {
	await withMcpClient(
		(server) => {
			const ctx = {
				userId: "unused",
				scopes: ["nova.read", "nova.write"],
				authKind: "oauth" as const,
			};
			for (const entry of SHARED_TOOL_REGISTRY) {
				if (["getForm", "createModule", "createForm"].includes(entry.saName))
					registerSharedTool(server, entry, ctx);
			}
		},
		async (client) => {
			for (const [name, input] of [
				[
					"get_form",
					{
						app_id: "saved",
						work_id: "private",
						moduleUuid: "Module",
						formUuid: "Form",
					},
				],
				["get_form", { moduleUuid: "Module", formUuid: "Form" }],
				[
					"create_module",
					{ work_id: "private", request_id: "old", name: "Module", forms: [] },
				],
				[
					"create_form",
					{
						work_id: "private",
						request_id: "old",
						moduleUuid: "Module",
						name: "Form",
						type: "survey",
						fields: [],
					},
				],
			] as const) {
				const result = await client.callTool({ name, arguments: input });
				expect(result).toHaveProperty("isError", true);
				expect(resultContentText(result)).toMatch(/Input validation error/);
			}
		},
	);
});

it("reports private-work failures with the tool and work identity, without arguments", async () => {
	const error = new Error("projection failed");
	vi.mocked(executeWorkTool).mockRejectedValueOnce(error);
	const workId = "11111111-1111-4111-8111-111111111111";
	await withMcpClient(
		(server) => {
			const entry = SHARED_TOOL_REGISTRY.find(
				(item) => item.saName === "getForm",
			);
			if (!entry) throw new Error("Missing getForm registration");
			registerSharedTool(server, entry, {
				userId: "actor",
				scopes: ["nova.read"],
				authKind: "oauth",
			});
		},
		async (client) => {
			const result = await client.callTool({
				name: "get_form",
				arguments: {
					work_id: workId,
					moduleUuid: "Module",
					formUuid: "Form",
				},
			});
			expect(result.isError).toBe(true);
			expect(log.error).toHaveBeenCalledWith(
				"[mcp] tool handler failed",
				error,
				{
					error_type: "internal",
					userId: "actor",
					appId: null,
					projectId: undefined,
					toolName: "get_form",
					workId,
					requestId: undefined,
					runId: undefined,
				},
			);
		},
	);
});
