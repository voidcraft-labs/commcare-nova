/** Pure result projection; actual dispatch and persistence live in the Postgres suite. */
import { expect, it } from "vitest";
import { savedDataReview } from "@/lib/agent/toolResults";
import { projectResult } from "../resultProjection";

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
	const { withMcpClient } = await import("./client");
	const { resultContentText } = await import("./resultText");
	const { registerSharedTool } = await import("../adapters/sharedToolAdapter");
	const { SHARED_TOOL_REGISTRY } = await import(
		"@/lib/agent/sharedToolRegistry"
	);
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
