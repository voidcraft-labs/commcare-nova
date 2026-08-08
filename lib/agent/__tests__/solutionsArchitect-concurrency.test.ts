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

import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import type {
	Automation,
	BlueprintDoc,
	Field,
	Form,
	Module,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { GenerationContext } from "../generationContext";
import { createSolutionsArchitect } from "../solutionsArchitect";
import { makeTestContext } from "./fixtures";

/* The SA commits every batch through `commitGuardedBatch` (kind:'chat'). Mock
 * it to re-apply the batch onto a TRACKED server doc and return the hydrated
 * result — mirroring the real writer, so the SA's working doc advances across
 * serialized tool calls exactly as it would against Postgres. `__seedServerDoc`
 * seeds the tracked doc to the SA's initial doc per test. */
const {
	commitGuardedBatchMock,
	readOrganizationAuthoringSnapshotMock,
	seedServerDoc,
} = vi.hoisted(() => {
	let serverDoc: unknown = null;
	let seq = 0;
	return {
		seedServerDoc: (doc: unknown) => {
			serverDoc = doc;
			seq = 0;
		},
		commitGuardedBatchMock: vi.fn(async (args: { mutations: unknown[] }) => {
			// biome-ignore lint/suspicious/noExplicitAny: test re-applies onto the tracked doc.
			serverDoc = produce(serverDoc as any, (draft: any) => {
				// biome-ignore lint/suspicious/noExplicitAny: mutation union threaded verbatim.
				applyMutations(draft, args.mutations as any);
			});
			seq += 1;
			return {
				seq,
				committedDoc: serverDoc,
				deduped: false,
			};
		}),
		readOrganizationAuthoringSnapshotMock: vi.fn(),
	};
});

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
	commitGuardedBatch: commitGuardedBatchMock,
}));

vi.mock("@/lib/organization/service", () => ({
	readOrganization: vi.fn(),
	readOrganizationAuthoringSnapshot: readOrganizationAuthoringSnapshotMock,
}));

const MOD = testUuid("11111111-1111-1111-1111-111111111111");
const FORM = testUuid("22222222-2222-2222-2222-222222222222");
const SEED_FIELD = testUuid("33333333-3333-3333-3333-333333333333");

/** A doc with one module + one registration form + one seed field, so
 *  the test's two new addFields calls land on a real form. */
function makeDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD,
		id: "patient",
		name: "Patient",
		caseType: "patient",
		caseListConfig: caseListConfig([
			{ field: "case_name", header: "Patient name" },
		]),
	};
	const form: Form = {
		uuid: FORM,
		id: "enroll",
		name: "Enroll Patient",
		type: "followup",
	};
	const field: Field = {
		uuid: SEED_FIELD,
		id: "case_name",
		kind: "text",
		label: proseText("Patient name"),
		caseWrite: { caseType: "patient", property: "case_name" },
	} as Field;
	return {
		appId: "test-app",
		appName: "Concurrency Test",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Full name") }],
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
		const doc = makeDoc();
		seedServerDoc(doc);
		const sa = createSolutionsArchitect(ctx, doc);

		// Fire two `addFields` execute callbacks without awaiting between
		// them — this matches what the AI SDK does when the model emits
		// two tool_use blocks in one assistant turn. Without the
		// serializer, both bodies read the same pre-batch `doc` snapshot
		// inside the wrapper closure and the later resolver clobbers the
		// earlier resolver's `doc = newDoc` write; with the serializer,
		// the chain forces them to run end-to-end one after the other.
		const inFlightA = runTool(sa, "addFields", {
			moduleUuid: MOD,
			formUuid: FORM,
			fields: [{ id: "dob", kind: "date", label: proseText("Date of birth") }],
		});
		const inFlightB = runTool(sa, "addFields", {
			moduleUuid: MOD,
			formUuid: FORM,
			fields: [{ id: "phone", kind: "text", label: proseText("Phone") }],
		});
		await Promise.all([inFlightA, inFlightB]);

		// `getForm` reads the SA's working doc. If either parallel
		// addFields was lost from the closure, this read will be missing
		// it — the seed field plus only one of the two new fields.
		const formResult = (await runTool(sa, "getForm", {
			moduleUuid: MOD,
			formUuid: FORM,
		})) as { form: { fields: Array<{ id: string }> } };

		const fieldIds = formResult.form.fields.map((f) => f.id).sort();
		expect(fieldIds).toEqual(["case_name", "dob", "phone"]);
	});

	it("a read tool issued in parallel with a write observes the post-write state", async () => {
		// Validates that `wrapRead` is also in the chain — a parallel
		// [addFields, getForm] would otherwise let `getForm` race past
		// `addFields` and report stale state, which is the read-side
		// equivalent of the write-side data-loss race.
		const doc = makeDoc();
		seedServerDoc(doc);
		const sa = createSolutionsArchitect(ctx, doc);

		const inFlightWrite = runTool(sa, "addFields", {
			moduleUuid: MOD,
			formUuid: FORM,
			fields: [{ id: "dob", kind: "date", label: proseText("Date of birth") }],
		});
		const inFlightRead = runTool(sa, "getForm", {
			moduleUuid: MOD,
			formUuid: FORM,
		}) as Promise<{ form: { fields: Array<{ id: string }> } }>;

		const [, readResult] = await Promise.all([inFlightWrite, inFlightRead]);
		const fieldIds = readResult.form.fields.map((f) => f.id).sort();
		expect(fieldIds).toEqual(["case_name", "dob"]);
	});

	it("adopts an authoritative zero-diff automation snapshot in the chat working doc", async () => {
		const doc = makeDoc();
		const automation: Automation = {
			uuid: testUuid("automation-noop-snapshot"),
			kind: "conditional-alert",
			name: "Follow-up survey",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [
				{ uuid: testUuid("automation-noop-recipient"), kind: "self" },
			],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("automation-noop-event"),
						minutesToWait: 0,
						content: {
							kind: "sms-survey",
							formUuid: FORM,
							expirationHours: 24,
							reminderIntervalsMinutes: [],
							submitPartiallyCompletedForms: false,
							includeCaseUpdatesInPartialSubmissions: false,
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		};
		doc.automations = { [automation.uuid]: automation };
		doc.automationOrder = [automation.uuid];
		const authoritativeDoc = structuredClone(doc);
		const authoritativeForm = authoritativeDoc.forms[FORM];
		if (authoritativeForm === undefined) throw new Error("missing form");
		authoritativeForm.name = "Peer-renamed follow-up";
		readOrganizationAuthoringSnapshotMock.mockResolvedValue({
			blueprint: authoritativeDoc,
			blueprintSeq: 4,
			organization: { revision: "3", locations: [] },
		});
		seedServerDoc(doc);
		const sa = createSolutionsArchitect(ctx, doc);

		const updateResult = await runTool(sa, "updateAutomation", {
			automation,
		});
		expect(updateResult).toMatchObject({
			message:
				'Automation "Follow-up survey" already has the requested settings.',
		});

		const formResult = (await runTool(sa, "getForm", {
			moduleUuid: MOD,
			formUuid: FORM,
		})) as { form: { name: string } };
		expect(formResult.form.name).toBe("Peer-renamed follow-up");
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
	});
});
