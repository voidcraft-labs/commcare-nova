/** Per-SA invocation ordering through real provider HTTP decoding and SDK
 * sibling dispatch. Controlled persistence receipts do not prove SQL locking. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
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
import { expectAdmittedDoc } from "./admittedFixture";
import { makeTestContext } from "./fixtures";
import { withResponsesPeer } from "./responsesPeer";
import { receiptWriter, runSaTool as runTool } from "./saHarness";

/** Only persistence/organization receipts are controlled; workspace and tools run normally. */
const { commitGuardedBatchMock, readOrganizationAuthoringSnapshotMock } =
	vi.hoisted(() => ({
		commitGuardedBatchMock: vi.fn(),
		readOrganizationAuthoringSnapshotMock: vi.fn(),
	}));
let receipts: ReturnType<typeof receiptWriter>;
function seedServerDoc(doc: BlueprintDoc) {
	receipts = receiptWriter(doc);
	commitGuardedBatchMock.mockImplementation(
		async (args: { mutations: Mutation[] }) => receipts.commit(args.mutations),
	);
}

vi.mock("@/lib/db/apps", () => ({
	refreshBuildLiveness: vi.fn().mockResolvedValue(undefined),
	refreshEditLease: vi.fn().mockResolvedValue(undefined),
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
	};
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

describe("solutionsArchitect — tool execution serializer", () => {
	let ctx: GenerationContext;

	beforeEach(() => {
		ctx = makeTestContext().ctx;
	});

	afterEach(async () => {
		await ctx.stopRunLeaseHeartbeat();
	});

	it("holds native SDK sibling writes and reads behind the first commit", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const doc = makeDoc();
		seedServerDoc(doc);
		commitGuardedBatchMock.mockImplementationOnce(
			async (args: { mutations: Mutation[] }) => {
				entered.resolve();
				await release.promise;
				return receipts.commit(args.mutations);
			},
		);
		const observedBodies: Array<{
			input: Array<{ type?: string; call_id?: string; output?: string }>;
		}> = [];
		await withResponsesPeer(
			(request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					body += chunk;
				});
				request.on("end", () => {
					observedBodies.push(JSON.parse(body));
					const calls = [
						{
							name: "addFields",
							input: {
								moduleUuid: MOD,
								formUuid: FORM,
								fields: [
									{
										id: "dob",
										kind: "date",
										label: "Date of birth",
									},
								],
							},
						},
						{
							name: "addFields",
							input: {
								moduleUuid: MOD,
								formUuid: FORM,
								fields: [{ id: "phone", kind: "text", label: "Phone" }],
							},
						},
						{ name: "getForm", input: { moduleUuid: MOD, formUuid: FORM } },
					];
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							id: "resp_local",
							created_at: 1,
							model: "local-model",
							output:
								observedBodies.length === 1
									? calls.map((call, index) => ({
											type: "function_call",
											id: `fc_${index}`,
											call_id: `call_${index}`,
											name: call.name,
											arguments: JSON.stringify(call.input),
										}))
									: [
											{
												type: "message",
												role: "assistant",
												id: "msg_done",
												content: [
													{
														type: "output_text",
														text: "Edits complete.",
														annotations: [],
													},
												],
											},
										],
							usage: { input_tokens: 11, output_tokens: 7 },
						}),
					);
				});
			},
			async (_provider, transport) => {
				ctx = makeTestContext({ transport }).ctx;
				const sa = createSolutionsArchitect(ctx, doc);
				const work = sa.generate({
					prompt: "Add date of birth and phone, then read the form.",
				});
				// Observe failure promptly without leaving a rejection unhandled while waiting for entry.
				const settled = work.then(
					(value) => ({ ok: true as const, value }),
					(error) => ({ ok: false as const, error }),
				);
				try {
					await Promise.race([
						entered.promise,
						settled.then((result) => {
							if (!result.ok) throw result.error;
							throw new Error("Run ended before committing");
						}),
					]);
					// A macrotask gives every SDK sibling dispatch an opportunity to enter.
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
					expect(observedBodies).toHaveLength(1);
					expect(receipts.currentDoc()).toEqual(doc);
					release.resolve();
					const result = await work;
					expect(result.text).toBe("Edits complete.");
					expect(commitGuardedBatchMock).toHaveBeenCalledTimes(2);
					const read = observedBodies[1]?.input.find(
						(item) =>
							item.type === "function_call_output" && item.call_id === "call_2",
					);
					expect(read?.output).toBeDefined();
					const output = JSON.parse(read?.output ?? "null");
					expect(
						output.form.fields.map((field: { id: string }) => field.id),
					).toEqual(["case_name", "dob", "phone"]);
					expectAdmittedDoc(receipts.currentDoc());
				} finally {
					release.resolve();
					await settled;
					await ctx.stopRunLeaseHeartbeat();
				}
			},
		);
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
			blueprint: expectAdmittedDoc(authoritativeDoc),
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
