/**
 * Staged tool × transactional guard — the composition that makes
 * `editField`'s "a rejected call saved nothing" hold on the MCP surface.
 *
 * `editField` builds up to three stages (convert → rename → patch) and
 * commits through `guardedMutateStages`, which persists via
 * `ctx.recordMutationStages`. On MCP that MUST be one transactional
 * guarded save over the concatenated sequence: a per-stage save would run
 * an independent fresh-doc re-verdict per stage, so a contention
 * rejection mid-sequence would leave the earlier stages PERSISTED while
 * the tool reports nothing was saved. These tests drive the REAL
 * `editFieldTool` through a REAL `McpContext` with only the saga module
 * mocked, pinning:
 *
 *   1. one `applyBlueprintChange` call per multi-stage edit, whose guard
 *      carries the concatenated mutations and whose prospective snapshot
 *      is the final post-edit doc;
 *   2. a contention rejection (the transactional re-verdict throwing
 *      `BlueprintCommitRejectedError`) surfaces as the tool's `{ error }`
 *      envelope with ZERO persisted prefix — the single save was the only
 *      write the call could make, and it never committed, and nothing
 *      reached the event log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { editFieldTool } from "@/lib/agent/tools/editField";
import {
	applyBlueprintChange,
	BlueprintCommitRejectedError,
} from "@/lib/db/applyBlueprintChange";
import type { BlueprintDoc } from "@/lib/domain";
import type { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";

vi.mock("@/lib/db/applyBlueprintChange", async () => {
	const actual = (await vi.importActual(
		"@/lib/db/applyBlueprintChange",
	)) as Record<string, unknown>;
	return {
		...actual,
		applyBlueprintChange: vi.fn().mockResolvedValue(undefined),
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
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
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
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
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
		runId: "run-1",
		commitPhase: "complete",
		logWriter,
		progress: { notify: vi.fn() },
	});
	return {
		ctx,
		logEvent: (logWriter as unknown as { logEvent: ReturnType<typeof vi.fn> })
			.logEvent,
	};
}

beforeEach(() => {
	vi.mocked(applyBlueprintChange).mockReset();
	vi.mocked(applyBlueprintChange).mockResolvedValue(undefined);
});

describe("editField through McpContext — one transactional save per edit", () => {
	it("a passing rename+patch edit issues exactly one guarded save over the concatenated batch", async () => {
		const doc = minDoc();
		const { ctx, logEvent } = makeMcpCtx();

		const out = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "village",
				updates: {
					kind: "text",
					id: "village_name",
					label: "Home village",
				} as never,
			},
			ctx,
			doc,
		);

		expect("message" in out.result).toBe(true);
		expect(vi.mocked(applyBlueprintChange)).toHaveBeenCalledTimes(1);
		const args = vi.mocked(applyBlueprintChange).mock.calls[0]?.[0];
		// The guard carries the WHOLE edit (rename cascade + scalar patch) so
		// the transaction's fresh-doc re-verdict evaluates the same candidate
		// the optimistic gate approved — never a lone stage.
		expect(args?.guard?.commitPhase).toBe("complete");
		const kinds = (args?.guard?.mutations ?? []).map((m) => m.kind);
		expect(kinds).toContain("renameField");
		expect(kinds).toContain("updateField");
		// The persisted snapshot is the FINAL doc — rename and patch applied.
		const persisted = args?.prospective as BlueprintDoc;
		const renamed = Object.values(persisted.fields).find(
			(fl) => fl.id === "village_name",
		);
		expect(renamed && "label" in renamed && renamed.label).toBe("Home village");
		// Both stages' envelopes reached the log, tagged per stage.
		const stages = logEvent.mock.calls.map(
			(c) => (c[0] as { stage?: string }).stage,
		);
		expect(new Set(stages)).toEqual(new Set(["rename:0-0", "edit:0-0"]));
	});

	it("a contention rejection surfaces as { error } with ZERO persisted prefix", async () => {
		const doc = minDoc();
		const { ctx, logEvent } = makeMcpCtx();
		// The fresh-doc re-verdict inside the transaction rejects — a
		// concurrent commit landed between the tool's snapshot and the write.
		vi.mocked(applyBlueprintChange).mockRejectedValueOnce(
			new BlueprintCommitRejectedError(
				"This change wasn't applied — it would introduce a new problem:\n- (concurrent state)\nNothing was changed.",
			),
		);

		const out = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "village",
				updates: {
					kind: "text",
					id: "village_name",
					label: "Home village",
				} as never,
			},
			ctx,
			doc,
		);

		// The tool reports the rejection honestly…
		expect("error" in out.result && out.result.error).toContain(
			"This change wasn't applied",
		);
		expect(out.mutations).toEqual([]);
		expect(out.newDoc).toBe(doc);
		// …and "nothing was saved" is structurally true: the ONE
		// transactional save was the call's only write, it never committed,
		// and no envelope reached the event log — there is no committed
		// rename for the agent to trip over on its corrected re-issue.
		expect(vi.mocked(applyBlueprintChange)).toHaveBeenCalledTimes(1);
		expect(logEvent).not.toHaveBeenCalled();
	});
});
