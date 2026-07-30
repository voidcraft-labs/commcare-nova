/**
 * `addFields` identifier guard — pre-dispatch rejection tests.
 *
 * The tool runs every incoming field id through the shared verdict
 * module (`lib/doc/identifierVerdicts.ts`) BEFORE persisting anything:
 * a sibling-id conflict, an XML-illegal name, a reserved `__nova_`
 * prefix, or an over-long case-property name fails the WHOLE call with
 * an `{ error }` envelope naming EVERY failing item, and
 * `ctx.recordMutations` never fires. The `DUPLICATE_FIELD_ID` /
 * `INVALID_FIELD_ID` / `RESERVED_FIELD_ID_PREFIX` validator rules stay
 * as backstops — this guard is the at-source twin (the connect-id
 * pattern).
 *
 * Tests drive the REAL tool handler with both execution contexts (chat
 * `GenerationContext`, MCP `McpContext`) to prove both surfaces hit the
 * same guard — the MCP adapter calls this same `execute` body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, Field, Form, Module, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	makeMcpTestContext,
	makeStubToolContext,
} from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(async (args) => {
		const { commitApplyBlueprintChangeTestBatch } = await import(
			"@/lib/db/__tests__/applyBlueprintChangeTestWriter"
		);
		return commitApplyBlueprintChangeTestBatch(args);
	}),
}));

const MOD = testUuid("11111111-1111-1111-1111-111111111111");
const FORM = testUuid("22222222-2222-2222-2222-222222222222");
const AGE = testUuid("33333333-3333-3333-3333-333333333333");
const GRP = testUuid("44444444-4444-4444-4444-444444444444");
const NOTE = testUuid("55555555-5555-5555-5555-555555555555");

/** One form holding a top-level `age` field and a group `grp` with a
 *  child `note` — enough structure to exercise sibling vs cousin scope. */
function makeDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD,
		id: "patients",
		name: "Patients",
	};
	const form: Form = {
		uuid: FORM,
		id: "register",
		name: "Register",
		type: "survey",
	};
	const age = {
		uuid: AGE,
		id: "age",
		kind: "int",
		label: proseText("Age"),
	} as Field;
	const grp = {
		uuid: GRP,
		id: "grp",
		kind: "group",
		label: proseText("Group"),
	} as Field;
	const note = {
		uuid: NOTE,
		id: "note",
		kind: "text",
		label: proseText("Note"),
	} as Field;
	return {
		appId: "test-app",
		appName: "Clinic",
		connectType: null,
		caseTypes: null,
		modules: { [MOD]: mod },
		forms: { [FORM]: form },
		fields: { [AGE]: age, [GRP]: grp, [NOTE]: note },
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [AGE, GRP], [GRP]: [NOTE] },
		fieldParent: { [AGE]: FORM, [GRP]: FORM, [NOTE]: GRP },
	};
}

/** Shorthand for the minimal valid text item the add pipeline accepts. */
function textItem(id: string, parentUuid?: Uuid) {
	return {
		id,
		kind: "text" as const,
		label: proseText(id),
		...(parentUuid && { parentUuid }),
	};
}

const ADDRESS = { moduleUuid: MOD, formUuid: FORM };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("addFields — identifier guard (chat surface)", () => {
	it("rejects a duplicate sibling id and persists nothing", async () => {
		const { ctx } = makeStubToolContext();
		const recordSpy = vi.spyOn(ctx, "recordMutations");
		const result = await addFieldsTool.execute(
			{ ...ADDRESS, fields: [textItem("age")] },
			ctx,
			makeDoc(),
		);

		expect(result.result).toHaveProperty("error");
		const error = (result.result as { error: string }).error;
		expect(error).toContain('"age"');
		expect(result.mutations).toHaveLength(0);
		expect(recordSpy).not.toHaveBeenCalled();
	});

	it("names EVERY failing item, not just the first", async () => {
		const { ctx } = makeStubToolContext();
		const result = await addFieldsTool.execute(
			{
				...ADDRESS,
				fields: [textItem("age"), textItem("bad name"), textItem("__nova_x")],
			},
			ctx,
			makeDoc(),
		);

		const error = (result.result as { error: string }).error;
		expect(error).toContain('"age"');
		expect(error).toContain('"bad name"');
		expect(error).toContain('"__nova_x"');
	});

	it("rejects two in-batch fields landing on the same parent with the same id", async () => {
		const { ctx } = makeStubToolContext();
		const recordSpy = vi.spyOn(ctx, "recordMutations");
		const result = await addFieldsTool.execute(
			{
				...ADDRESS,
				fields: [textItem("dup"), textItem("dup")],
			},
			ctx,
			makeDoc(),
		);

		const error = (result.result as { error: string }).error;
		expect(error).toContain('"dup"');
		expect(recordSpy).not.toHaveBeenCalled();
	});

	it("rejects a duplicate against a group's existing children", async () => {
		const { ctx } = makeStubToolContext();
		const result = await addFieldsTool.execute(
			{
				...ADDRESS,
				fields: [textItem("note", GRP)],
			},
			ctx,
			makeDoc(),
		);

		expect((result.result as { error: string }).error).toContain('"note"');
	});

	it("accepts a cousin id (same id under a different parent) and persists", async () => {
		const { ctx } = makeStubToolContext();
		const recordSpy = vi.spyOn(ctx, "recordMutations");
		const result = await addFieldsTool.execute(
			{
				...ADDRESS,
				fields: [textItem("age", GRP)],
			},
			ctx,
			makeDoc(),
		);

		expect(result.result).toHaveProperty("message");
		expect(result.mutations).toHaveLength(1);
		expect(recordSpy).toHaveBeenCalledTimes(1);
	});

	it("accepts a legal batch and persists it", async () => {
		const { ctx } = makeStubToolContext();
		const recordSpy = vi.spyOn(ctx, "recordMutations");
		const result = await addFieldsTool.execute(
			{
				...ADDRESS,
				fields: [textItem("weight"), textItem("height")],
			},
			ctx,
			makeDoc(),
		);

		expect(result.result).toHaveProperty("message");
		expect(result.mutations).toHaveLength(2);
		expect(recordSpy).toHaveBeenCalledTimes(1);
		const ids = Object.values(result.newDoc.fields).map((f) => f?.id);
		expect(ids).toContain("weight");
		expect(ids).toContain("height");
	});
});

describe("addFields — identifier guard (MCP surface, same tool body)", () => {
	it("rejects the same duplicate sibling id through an McpContext", async () => {
		const doc = makeDoc();
		const { ctx } = makeMcpTestContext({ initialDoc: doc });
		const recordSpy = vi.spyOn(ctx, "recordMutations");
		const result = await addFieldsTool.execute(
			{ ...ADDRESS, fields: [textItem("age")] },
			ctx,
			doc,
		);

		const error = (result.result as { error: string }).error;
		expect(error).toContain('"age"');
		expect(recordSpy).not.toHaveBeenCalled();
	});
});
