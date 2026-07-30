import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	makeMcpTestContext,
	makeStubToolContext,
} from "@/lib/agent/__tests__/fixtures";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
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
		const { ctx, recordMutations } = makeStubToolContext();
		const outcome = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [
					{ formUuid: FIRST, connect: learnModule() },
					{ formUuid: SECOND, connect: learnModule() },
				],
			},
			ctx,
			doc,
		);

		expect(outcome.result).not.toHaveProperty("error");
		expect(recordMutations).toHaveBeenCalledTimes(1);
		expect(recordMutations.mock.calls[0]?.[1]).toBe("app");
		expect(outcome.mutations.map((mutation) => mutation.kind)).toEqual([
			"setConnectType",
			"updateForm",
			"updateForm",
		]);
		expect(outcome.newDoc.connectType).toBe("learn");
		expect(outcome.newDoc.forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
		);
		expect(outcome.newDoc.forms[SECOND]?.connect).toHaveProperty(
			"learn_module.id",
		);
		expect(new Set(connectIds(outcome.newDoc)).size).toBe(2);
	});

	it("reserves explicit ids and derives omissions in canonical document order", async () => {
		const base = fixture();
		const forward = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [
					{ formUuid: FIRST, connect: learnModule() },
					{ formUuid: SECOND, connect: learnModule("learning") },
				],
			},
			makeStubToolContext().ctx,
			structuredClone(base),
		);
		const reversed = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [
					{ formUuid: SECOND, connect: learnModule("learning") },
					{ formUuid: FIRST, connect: learnModule() },
				],
			},
			makeStubToolContext().ctx,
			structuredClone(base),
		);

		expect(forward.result).not.toHaveProperty("error");
		expect(reversed.result).not.toHaveProperty("error");
		expect(forward.newDoc).toEqual(reversed.newDoc);
		expect(forward.mutations).toEqual(reversed.mutations);
		expect(forward.newDoc.forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
			"learning_2",
		);
		expect(forward.newDoc.forms[SECOND]?.connect).toHaveProperty(
			"learn_module.id",
			"learning",
		);
	});

	it("preserves established same-form identities when ids are omitted", async () => {
		const enabled = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [
					{ formUuid: FIRST, connect: learnModule("lesson_identity") },
					{
						formUuid: SECOND,
						connect: learnModule("assessment_identity"),
					},
				],
			},
			makeStubToolContext().ctx,
			fixture(),
		);
		const reconfigured = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [
					{ formUuid: SECOND, connect: learnModule() },
					{ formUuid: FIRST, connect: learnModule() },
				],
			},
			makeStubToolContext().ctx,
			enabled.newDoc,
		);

		expect(reconfigured.result).not.toHaveProperty("error");
		expect(reconfigured.newDoc.forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
			"lesson_identity",
		);
		expect(reconfigured.newDoc.forms[SECOND]?.connect).toHaveProperty(
			"learn_module.id",
			"assessment_identity",
		);
	});

	it("keeps established ids across form and module display-name changes", async () => {
		const enabled = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [{ formUuid: FIRST, connect: learnModule() }],
			},
			makeStubToolContext().ctx,
			fixture(),
		);
		const renamed = structuredClone(enabled.newDoc);
		renamed.modules[MODULE].name = "Renamed module";
		renamed.forms[FIRST].name = "Renamed form";
		const reconfigured = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [{ formUuid: FIRST, connect: learnModule() }],
			},
			makeStubToolContext().ctx,
			renamed,
		);

		expect(reconfigured.result).not.toHaveProperty("error");
		expect(reconfigured.newDoc.forms[FIRST]?.connect).toHaveProperty(
			"learn_module.id",
			"learning",
		);
	});

	it("replaces participants, switches mode, and disables without dormant blocks", async () => {
		const doc = fixture();
		const firstContext = makeStubToolContext();
		const enabled = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: [
					{
						formUuid: FIRST,
						connect: learnModule("health_basics"),
					},
				],
			},
			firstContext.ctx,
			doc,
		);
		const switched = await configureConnectTool.execute(
			{
				mode: "deliver",
				participants: [
					{
						formUuid: SECOND,
						connect: deliverUnit("household_visit"),
					},
				],
			},
			makeStubToolContext().ctx,
			enabled.newDoc,
		);

		expect(switched.result).not.toHaveProperty("error");
		expect(switched.newDoc.connectType).toBe("deliver");
		expect(switched.newDoc.forms[FIRST]?.connect).toBeUndefined();
		expect(switched.newDoc.forms[SECOND]?.connect).toEqual(
			deliverUnit("household_visit"),
		);

		const disabled = await configureConnectTool.execute(
			{ mode: null },
			makeStubToolContext().ctx,
			switched.newDoc,
		);
		expect(disabled.result).not.toHaveProperty("error");
		expect(disabled.newDoc.connectType).toBeNull();
		expect(
			Object.values(disabled.newDoc.forms).every((form) => !form?.connect),
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
		const { ctx, recordMutations } = makeStubToolContext();
		const outcome = await configureConnectTool.execute(
			{
				mode: "learn",
				participants: participants as Array<{
					formUuid: Uuid;
					connect: ReturnType<typeof learnModule>;
				}>,
			},
			ctx,
			doc,
		);

		expect(outcome.result).toEqual({
			error: expect.stringContaining(error),
		});
		expect(outcome.mutations).toEqual([]);
		expect(outcome.newDoc).toBe(doc);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("is one shared SA/MCP implementation with identical accepted mutations", async () => {
		const doc = fixture();
		const input = {
			mode: "learn" as const,
			participants: [{ formUuid: FIRST, connect: learnModule() }],
		};
		const sa = await configureConnectTool.execute(
			input,
			makeStubToolContext().ctx,
			doc,
		);
		const { ctx: mcpContext } = makeMcpTestContext({ initialDoc: doc });
		const mcpRecord = vi.spyOn(mcpContext, "recordMutations");
		const mcp = await configureConnectTool.execute(input, mcpContext, doc);

		expect(mcpRecord).toHaveBeenCalledTimes(1);
		expect(mcp.result).not.toHaveProperty("error");
		expect(mcp.mutations).toEqual(sa.mutations);
		expect(mcp.newDoc).toEqual(sa.newDoc);
		expect(mcp.result).toEqual(sa.result);

		const entry = SHARED_TOOL_REGISTRY.find(
			(candidate) => candidate.saName === "configureConnect",
		);
		expect(entry).toEqual({
			saName: "configureConnect",
			mcpName: "configure_connect",
			tool: configureConnectTool,
			requires: "edit",
		});

		const wire = wireToolSchema(configureConnectInputSchema);
		expect(wire.jsonSchema).toMatchObject({
			type: "object",
			required: ["mode"],
			additionalProperties: false,
		});
	});
});
