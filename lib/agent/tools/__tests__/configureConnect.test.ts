import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	makeMcpTestContext,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	configureConnectInputSchema,
	configureConnectTool,
} from "../configureConnect";

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(async (args) => {
		const { commitApplyBlueprintChangeTestBatch } = await import(
			"@/lib/db/__tests__/applyBlueprintChangeTestWriter"
		);
		return commitApplyBlueprintChangeTestBatch(args);
	}),
}));

const MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const FIRST = testUuid("20000000-0000-4000-8000-000000000000");
const SECOND = testUuid("30000000-0000-4000-8000-000000000000");
const FOREIGN = testUuid("40000000-0000-4000-8000-000000000000");

function fixture(): BlueprintDoc {
	return buildDoc({
		appId: "connect-app",
		appName: "Connect app",
		modules: [
			{
				uuid: MODULE,
				name: "Learning",
				forms: [
					{
						uuid: FIRST,
						name: "Lesson",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "lesson_note",
								label: proseText("Lesson note"),
							}),
						],
					},
					{
						uuid: SECOND,
						name: "Assessment",
						type: "survey",
						fields: [
							f({
								kind: "int",
								id: "score",
								label: proseText("Score"),
							}),
						],
					},
				],
			},
		],
	});
}

const learnModule = (id?: string) => ({
	learn_module: {
		...(id === undefined ? {} : { id }),
		name: "Health basics",
		description: "Learn the basics",
		time_estimate: 10,
	},
});

const deliverUnit = (id?: string) => ({
	deliver_unit: {
		...(id === undefined ? {} : { id }),
		name: "Household visit",
	},
});

function connectIds(doc: BlueprintDoc): string[] {
	const ids: string[] = [];
	for (const form of Object.values(doc.forms)) {
		if (!form?.connect) continue;
		if ("learn_module" in form.connect && form.connect.learn_module) {
			ids.push(form.connect.learn_module.id);
		}
		if ("assessment" in form.connect && form.connect.assessment) {
			ids.push(form.connect.assessment.id);
		}
		if ("deliver_unit" in form.connect && form.connect.deliver_unit) {
			ids.push(form.connect.deliver_unit.id);
		}
		if ("task" in form.connect && form.connect.task) {
			ids.push(form.connect.task.id);
		}
	}
	return ids;
}

describe("configureConnect exact target-state tool", () => {
	it("admits only a complete nonempty target at the callable boundary", () => {
		expect(configureConnectInputSchema.safeParse({ mode: null }).success).toBe(
			true,
		);
		expect(
			configureConnectInputSchema.safeParse({
				mode: null,
				participants: [{ formUuid: FIRST, connect: learnModule() }],
			}).success,
		).toBe(false);
		expect(
			configureConnectInputSchema.safeParse({ mode: "learn" }).success,
		).toBe(false);
		expect(
			configureConnectInputSchema.safeParse({
				mode: "learn",
				participants: [],
			}).success,
		).toBe(false);
		expect(
			configureConnectInputSchema.safeParse({
				mode: "learn",
				participants: [
					{ formUuid: FIRST, connect: learnModule() },
					{ formUuid: FIRST, connect: learnModule() },
				],
			}).success,
		).toBe(false);
		expect(
			configureConnectInputSchema.safeParse({
				mode: "learn",
				participants: [{ formUuid: "lesson", connect: learnModule() }],
			}).success,
		).toBe(false);
	});

	it("enables Connect atomically and derives omitted wire ids exactly once", async () => {
		const doc = fixture();
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = await harness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [
				{ formUuid: FIRST, connect: learnModule() },
				{ formUuid: SECOND, connect: learnModule() },
			],
		});

		expect(outcome.result).not.toHaveProperty("error");
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		expect(harness.recordMutations.mock.calls[0]?.[1]).toBe("app");
		expect(outcome.mutations.map((mutation) => mutation.kind)).toEqual([
			"setConnectType",
			"updateForm",
			"updateForm",
		]);
		expect(harness.currentDoc().connectType).toBe("learn");
		expect(harness.currentDoc().forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
		);
		expect(harness.currentDoc().forms[SECOND]?.connect).toHaveProperty(
			"learn_module.id",
		);
		expect(new Set(connectIds(harness.currentDoc())).size).toBe(2);
	});

	it("explains that clearing an already-disabled target is not a list or form operation", async () => {
		const doc = fixture();
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = await harness.runTool(configureConnectTool, { mode: null });

		expect(outcome).toMatchObject({
			mutations: [],
			result: {
				error: expect.stringContaining("does not configure case lists"),
			},
		});
		expect(outcome.result).toEqual({
			error: expect.stringContaining("Continue without retrying"),
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();
		expect(harness.currentDoc()).toBe(doc);
	});

	it("explains an exact non-null target no-op without persisting", async () => {
		const harness = makeToolWorkspaceHarness(fixture());
		const input = {
			mode: "learn" as const,
			participants: [
				{ formUuid: FIRST, connect: learnModule("lesson_identity") },
			],
		};
		await harness.runTool(configureConnectTool, input);
		harness.recordMutations.mockClear();

		const outcome = await harness.runTool(configureConnectTool, input);

		expect(outcome).toMatchObject({
			mutations: [],
			result: { error: expect.stringContaining("already matches") },
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("reserves explicit ids and derives omissions in canonical document order", async () => {
		const base = fixture();
		const forwardHarness = makeToolWorkspaceHarness(structuredClone(base));
		const forward = await forwardHarness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [
				{ formUuid: FIRST, connect: learnModule() },
				{ formUuid: SECOND, connect: learnModule("learning") },
			],
		});
		const reversedHarness = makeToolWorkspaceHarness(structuredClone(base));
		const reversed = await reversedHarness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [
				{ formUuid: SECOND, connect: learnModule("learning") },
				{ formUuid: FIRST, connect: learnModule() },
			],
		});

		expect(forward.result).not.toHaveProperty("error");
		expect(reversed.result).not.toHaveProperty("error");
		expect(forwardHarness.currentDoc()).toEqual(reversedHarness.currentDoc());
		expect(forward.mutations).toEqual(reversed.mutations);
		expect(forwardHarness.currentDoc().forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
			"learning_2",
		);
		expect(forwardHarness.currentDoc().forms[SECOND]?.connect).toHaveProperty(
			"learn_module.id",
			"learning",
		);
	});

	it("preserves established same-form identities when ids are omitted", async () => {
		const harness = makeToolWorkspaceHarness(fixture());
		await harness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [
				{ formUuid: FIRST, connect: learnModule("lesson_identity") },
				{
					formUuid: SECOND,
					connect: learnModule("assessment_identity"),
				},
			],
		});
		const reconfigured = await harness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [
				{ formUuid: SECOND, connect: learnModule() },
				{ formUuid: FIRST, connect: learnModule() },
			],
		});

		expect(reconfigured.result).toEqual({
			error: expect.stringContaining("already matches"),
		});
		expect(harness.currentDoc().forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
			"lesson_identity",
		);
		expect(harness.currentDoc().forms[SECOND]?.connect).toHaveProperty(
			"learn_module.id",
			"assessment_identity",
		);
	});

	it("keeps established ids across form and module display-name changes", async () => {
		const enabledHarness = makeToolWorkspaceHarness(fixture());
		await enabledHarness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [{ formUuid: FIRST, connect: learnModule() }],
		});
		const renamed = structuredClone(enabledHarness.currentDoc());
		renamed.modules[MODULE].name = "Renamed module";
		renamed.forms[FIRST].name = "Renamed form";
		const renamedHarness = makeToolWorkspaceHarness(renamed);
		const reconfigured = await renamedHarness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [{ formUuid: FIRST, connect: learnModule() }],
		});

		expect(reconfigured.result).toEqual({
			error: expect.stringContaining("already matches"),
		});
		expect(renamedHarness.currentDoc().forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
			"learning",
		);
	});

	it("replaces participants, switches mode, and disables without dormant blocks", async () => {
		const harness = makeToolWorkspaceHarness(fixture());
		await harness.runTool(configureConnectTool, {
			mode: "learn",
			participants: [
				{
					formUuid: FIRST,
					connect: learnModule("health_basics"),
				},
			],
		});
		const switched = await harness.runTool(configureConnectTool, {
			mode: "deliver",
			participants: [
				{
					formUuid: SECOND,
					connect: deliverUnit("household_visit"),
				},
			],
		});

		expect(switched.result).not.toHaveProperty("error");
		expect(harness.currentDoc().connectType).toBe("deliver");
		expect(harness.currentDoc().forms[FIRST]?.connect).toBeUndefined();
		expect(harness.currentDoc().forms[SECOND]?.connect).toEqual(
			deliverUnit("household_visit"),
		);

		const disabled = await harness.runTool(configureConnectTool, {
			mode: null,
		});
		expect(disabled.result).not.toHaveProperty("error");
		expect(harness.currentDoc().connectType).toBeNull();
		expect(
			Object.values(harness.currentDoc().forms).every((form) => !form?.connect),
		).toBe(true);
	});

	it.each([
		{
			label: "foreign form",
			participants: [{ formUuid: FOREIGN, connect: learnModule() }],
			error: "not a form",
		},
		{
			label: "wrong mode family",
			participants: [{ formUuid: FIRST, connect: deliverUnit() }],
			error: "learn-mode",
		},
		{
			label: "duplicate explicit id",
			participants: [
				{ formUuid: FIRST, connect: learnModule("duplicate") },
				{ formUuid: SECOND, connect: learnModule("duplicate") },
			],
			error: "already used",
		},
	])("rejects $label before persistence", async ({ participants, error }) => {
		const doc = fixture();
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = await harness.runTool(configureConnectTool, {
			mode: "learn",
			participants: participants as Array<{
				formUuid: Uuid;
				connect: ReturnType<typeof learnModule>;
			}>,
		});

		expect(outcome.result).toEqual({
			error: expect.stringContaining(error),
		});
		expect(outcome.mutations).toEqual([]);
		expect(harness.currentDoc()).toBe(doc);
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("is one shared SA/MCP implementation with identical accepted mutations", async () => {
		const doc = fixture();
		const input = {
			mode: "learn" as const,
			participants: [{ formUuid: FIRST, connect: learnModule() }],
		};
		const saHarness = makeToolWorkspaceHarness(doc);
		const sa = await saHarness.runTool(configureConnectTool, input);
		const { ctx: mcpContext } = makeMcpTestContext({ initialDoc: doc });
		const mcpRecord = vi.spyOn(mcpContext, "recordMutations");
		// MCP drives the same shared tool through its own canonical workspace —
		// the per-call host is `McpContext` itself.
		const mcpWorkspace = new CanonicalMutationWorkspace({
			host: mcpContext,
			initialDoc: doc,
		});
		const mcp = await mcpWorkspace.invoke({
			toolName: "configure_connect",
			execute: (ctx) => configureConnectTool.execute(input, ctx),
		});

		expect(mcpRecord).toHaveBeenCalledTimes(1);
		expect(mcp.result).not.toHaveProperty("error");
		expect(mcp.mutations).toEqual(sa.mutations);
		expect(mcpWorkspace.currentSnapshot().doc).toEqual(saHarness.currentDoc());
		expect(mcp.result).toEqual(sa.result);

		const entry = SHARED_TOOL_REGISTRY.find(
			(candidate) => candidate.saName === "configureConnect",
		);
		expect(entry).toEqual({
			saName: "configureConnect",
			mcpName: "configure_connect",
			tool: configureConnectTool,
			requires: "edit",
			// The entry's exact execution policy is pinned once, for every tool,
			// in `sharedToolRegistryPolicy.test.ts`; this assertion stays about
			// the registration itself while remaining exhaustive over the keys.
			policy: expect.anything(),
		});

		const wire = wireToolSchema(configureConnectInputSchema);
		expect(wire.jsonSchema).toMatchObject({
			type: "object",
			required: ["mode"],
			additionalProperties: false,
		});
	});
});
