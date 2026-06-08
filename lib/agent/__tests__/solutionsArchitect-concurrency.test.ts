/**
 * Regression test for the SA's tool-execution serializer.
 *
 * The SA exposes its tools to the AI SDK through wrappers that close
 * over a single mutable `let doc: BlueprintDoc`. The AI SDK invokes
 * parallel `tool_use` blocks from one assistant turn concurrently
 * (`Promise.all(toolCalls.map(executeToolCall))`), so without a
 * serializer two branches each read the same pre-batch `doc` snapshot,
 * each compute their own `newDoc`, and the last to resolve writes back
 * — silently dropping the earlier branch's mutation from the SA's
 * working state. The wire/UI sees both because mutations stream
 * unconditionally; only the SA's *own* doc is corrupted, which surfaces
 * later when the SA's next read tool reports the just-applied state as
 * missing and the SA bursts into a wasteful "edits aren't sticking"
 * rework loop (real incident: app FhFwcuDu2b7ztXAllX6I, run
 * 47e1fe7d…).
 *
 * The fix: a promise-chain mutex (`chain` + `serial<T>`) wraps every
 * tool body so only one runs at a time per agent instance. This file
 * exists to pin the property — without it, a future refactor that
 * inlined the wrappers, dropped `serial` on the read path "because
 * reads can't race," or otherwise removed the chain would silently
 * regress and only show up in production logs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Field, Form, Module } from "@/lib/domain";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import type { GenerationContext } from "../generationContext";
import { createSolutionsArchitect } from "../solutionsArchitect";
import { makeTestContext } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
}));

const MOD = asUuid("11111111-1111-1111-1111-111111111111");
const FORM = asUuid("22222222-2222-2222-2222-222222222222");
const SEED_FIELD = asUuid("33333333-3333-3333-3333-333333333333");

/** A doc with one module + one registration form + one seed field, so
 *  the test's two new addFields calls land on a real form. */
function makeDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD,
		id: "patient",
		name: "Patient",
		caseType: "patient",
	};
	const form: Form = {
		uuid: FORM,
		id: "enroll",
		name: "Enroll Patient",
		type: "registration",
	};
	const field: Field = {
		uuid: SEED_FIELD,
		id: "case_name",
		kind: "text",
		label: "Patient name",
		case_property_on: "case_name",
	} as Field;
	return {
		appId: "test-app",
		appName: "Concurrency Test",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: "Full name" }],
			},
		],
		modules: { [MOD]: mod },
		forms: { [FORM]: form },
		fields: { [SEED_FIELD]: field },
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [SEED_FIELD] },
		fieldParent: { [SEED_FIELD]: FORM },
	};
}

const EXEC_OPTS = { toolCallId: "test-call", messages: [] };

/** Invoke a wrapped tool's `execute` directly. The SA's tool record is
 *  a heterogeneous `ToolSet`; cast through `any` so the test harness can
 *  reach `execute` without re-deriving every input/output type. */
async function runTool(
	agent: ReturnType<typeof createSolutionsArchitect>,
	name: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: SA tool set is heterogeneous; test harness invokes execute directly.
	const tool = (agent.tools as Record<string, any>)[name];
	return tool.execute(input, EXEC_OPTS);
}

describe("solutionsArchitect — tool execution serializer", () => {
	let ctx: GenerationContext;

	beforeEach(() => {
		ctx = makeTestContext().ctx;
	});

	it("serializes parallel mutating tools so neither write to the SA's working doc is lost", async () => {
		const sa = createSolutionsArchitect(ctx, makeDoc(), false);

		// Fire two `addFields` execute callbacks without awaiting between
		// them — this matches what the AI SDK does when the model emits
		// two tool_use blocks in one assistant turn. Without the
		// serializer, both bodies read the same pre-batch `doc` snapshot
		// inside the wrapper closure and the later resolver clobbers the
		// earlier resolver's `doc = newDoc` write; with the serializer,
		// the chain forces them to run end-to-end one after the other.
		const inFlightA = runTool(sa, "addFields", {
			moduleIndex: 0,
			formIndex: 0,
			fields: [{ id: "dob", kind: "date", label: "Date of birth" }],
		});
		const inFlightB = runTool(sa, "addFields", {
			moduleIndex: 0,
			formIndex: 0,
			fields: [{ id: "phone", kind: "text", label: "Phone" }],
		});
		await Promise.all([inFlightA, inFlightB]);

		// `getForm` reads the SA's working doc. If either parallel
		// addFields was lost from the closure, this read will be missing
		// it — the seed field plus only one of the two new fields.
		const formResult = (await runTool(sa, "getForm", {
			moduleIndex: 0,
			formIndex: 0,
		})) as { form: { fields: Array<{ id: string }> } };

		const fieldIds = formResult.form.fields.map((f) => f.id).sort();
		expect(fieldIds).toEqual(["case_name", "dob", "phone"]);
	});

	it("a read tool issued in parallel with a write observes the post-write state", async () => {
		// Validates that `wrapRead` is also in the chain — a parallel
		// [addFields, getForm] would otherwise let `getForm` race past
		// `addFields` and report stale state, which is the read-side
		// equivalent of the write-side data-loss race.
		const sa = createSolutionsArchitect(ctx, makeDoc(), false);

		const inFlightWrite = runTool(sa, "addFields", {
			moduleIndex: 0,
			formIndex: 0,
			fields: [{ id: "dob", kind: "date", label: "Date of birth" }],
		});
		const inFlightRead = runTool(sa, "getForm", {
			moduleIndex: 0,
			formIndex: 0,
		}) as Promise<{ form: { fields: Array<{ id: string }> } }>;

		const [, readResult] = await Promise.all([inFlightWrite, inFlightRead]);
		const fieldIds = readResult.form.fields.map((f) => f.id).sort();
		expect(fieldIds).toEqual(["case_name", "dob"]);
	});
});
