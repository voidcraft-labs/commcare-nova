/**
 * Staged tool × transactional guard — the composition that makes
 * `editField`'s "a rejected call saved nothing" hold on the MCP surface.
 *
 * `editField` builds conversion and property-update stages (when needed) and
 * commits through `guardedMutateStages`, whose workspace persists via the
 * host's `recordMutationStages`. On MCP that MUST be one transactional
 * guarded save over the concatenated sequence: a per-stage save would run
 * an independent fresh-doc re-verdict per stage, so a contention
 * rejection mid-sequence would leave the earlier stages PERSISTED while
 * the tool reports nothing was saved. These tests drive the REAL
 * `editFieldTool` through a REAL `McpContext` with only the guarded boundary
 * mocked, pinning:
 *
 *   1. one `applyBlueprintChange` call per multi-stage edit, whose guard
 *      carries the concatenated mutations;
 *   2. a contention rejection (the transactional re-verdict throwing
 *      `BlueprintCommitRejectedError`) surfaces as the tool's `{ error }`
 *      envelope with ZERO persisted prefix — the single save was the only
 *      write the call could make, and it never committed, and nothing
 *      reached the event log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";

vi.mock("@/lib/db/applyBlueprintChange", async () => {
	const actual = (await vi.importActual(
		"@/lib/db/applyBlueprintChange",
	)) as Record<string, unknown>;
	return {
		...actual,
		applyBlueprintChange: vi.fn(),
	};
});

/** Valid one-module registration doc writing two case properties. */
function minDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Form",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
		],
	});
}

function makeMcpCtx() {
	const logWriter = {
		logEvent: vi.fn(),
		flush: vi.fn(),
	} as unknown as LogWriter;
	const ctx = new McpContext({
		appId: "app-1",
		userId: "user-1",
		projectId: "project-1",
		runId: "run-1",
		logWriter,
		progress: { notify: vi.fn() },
		conversionImpact: async () => ({
			totalWithValue: 0,
			uncastable: 0,
			alreadyHeld: 0,
			samples: [],
		}),
	});
	return {
		ctx,
		logEvent: (logWriter as unknown as { logEvent: ReturnType<typeof vi.fn> })
			.logEvent,
	};
}

/** Drive the real tool through a per-call canonical workspace over the real
 *  McpContext host — the exact composition the MCP adapter uses. */
function invokeEditField(ctx: McpContext, doc: BlueprintDoc, input: unknown) {
	const workspace = new CanonicalMutationWorkspace({
		host: ctx,
		initialDoc: doc,
	});
	return workspace.invoke({
		toolName: "edit_field",
		execute: (invocationCtx) =>
			editFieldTool.execute(input as never, invocationCtx),
	});
}

beforeEach(() => {
	vi.mocked(applyBlueprintChange).mockReset();
	vi.mocked(applyBlueprintChange).mockResolvedValue({
		seq: 0,
		committedDoc: minDoc(),
	});
});

describe("editField through McpContext — one transactional save per edit", () => {
	it("a passing ID+label edit issues one guarded save with one canonical field patch", async () => {
		const doc = minDoc();
		const { ctx, logEvent } = makeMcpCtx();
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const fieldUuid = doc.fieldOrder[formUuid].find(
			(uuid) => doc.fields[uuid]?.id === "village",
		);
		if (fieldUuid === undefined) throw new Error("village fixture is missing");

		const out = await invokeEditField(ctx, doc, {
			moduleUuid,
			formUuid,
			fieldUuid,
			updates: {
				kind: "text",
				id: "village_name",
				label: proseText("Home village"),
			},
		});

		expect("message" in out.result).toBe(true);
		expect(vi.mocked(applyBlueprintChange)).toHaveBeenCalledTimes(1);
		const args = vi.mocked(applyBlueprintChange).mock.calls[0]?.[0];
		// The guard carries the WHOLE semantic edit in one updateField patch so
		// the transaction's fresh-doc re-verdict evaluates the same candidate
		// the optimistic gate approved. ID and case binding must remain together
		// for the reducer to distinguish a property rename from a retarget.
		expect(args?.guard?.mutations).toEqual([
			expect.objectContaining({
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: expect.objectContaining({
					id: "village_name",
					label: proseText("Home village"),
				}),
			}),
		]);
		// The one canonical edit stage reached the log.
		const stages = logEvent.mock.calls.map(
			(c) => (c[0] as { stage?: string }).stage,
		);
		expect(new Set(stages)).toEqual(new Set([`edit:${formUuid}`]));
	});

	it("a contention rejection PROPAGATES out of the tool with ZERO persisted prefix", async () => {
		const doc = minDoc();
		const { ctx, logEvent } = makeMcpCtx();
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const fieldUuid = doc.fieldOrder[formUuid].find(
			(uuid) => doc.fields[uuid]?.id === "village",
		);
		if (fieldUuid === undefined) throw new Error("village fixture is missing");
		// The fresh-doc re-verdict inside the transaction rejects — a
		// concurrent commit landed between the tool's snapshot and the write.
		vi.mocked(applyBlueprintChange).mockRejectedValueOnce(
			new BlueprintCommitRejectedError(
				"This change wasn't applied — it would introduce a new problem:\n- (concurrent state)\nNothing was changed.",
			),
		);

		// The tool's blanket catch re-throws `BlueprintCommitRejectedError` (via
		// `toToolErrorResult`) rather than swallowing it into `{ error }` — it is
		// the authoritative commit conflict. On the chat surface `wrapMutating`
		// catches it (reload + continue); on MCP the `sharedToolAdapter`'s
		// `toMcpErrorResult` maps it to the `invalid_input` wire envelope. Either
		// way the RAW tool `execute` propagates it here.
		await expect(
			invokeEditField(ctx, doc, {
				moduleUuid,
				formUuid,
				fieldUuid,
				updates: {
					kind: "text",
					id: "village_name",
					label: proseText("Home village"),
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		// "Nothing was saved" is structurally true: the ONE transactional save
		// was the call's only write, it never committed, and no envelope reached
		// the event log — there is no committed field edit for the agent to trip
		// over on its corrected re-issue.
		expect(vi.mocked(applyBlueprintChange)).toHaveBeenCalledTimes(1);
		expect(logEvent).not.toHaveBeenCalled();
	});
});
