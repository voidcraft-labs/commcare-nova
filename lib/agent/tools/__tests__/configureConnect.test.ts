/** Canonical commands over admitted documents and a controlled workspace host.
 * The actual gate and reducer run; persistence and SA/MCP transport are separate boundaries. */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import {
	mutationCommitVerdict,
	type PreparedMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import {
	configureConnectInputSchema,
	configureConnectTool,
} from "../configureConnect";

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
	it("reports every committed participant when another editor adds a form", async () => {
		const base = fixture();
		base.connectType = "learn";
		base.forms[FIRST].connect = {
			learn_module: {
				id: "lesson",
				name: "Lesson",
				description: "Read",
				time_estimate: 10,
			},
		};
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(base));
		h.recordMutations.mockImplementation(
			async (prepared: PreparedMutationCandidate) => {
				const peer = mutationCommitVerdict(
					base,
					[
						{
							kind: "updateForm",
							uuid: SECOND,
							patch: {
								connect: {
									learn_module: {
										id: "second",
										name: "Second",
										description: "Read second",
										time_estimate: 10,
									},
								},
							},
						},
					],
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				if (!peer.ok) throw new Error(JSON.stringify(peer));
				const committed = mutationCommitVerdict(
					peer.nextDoc,
					prepared.mutations,
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				if (!committed.ok) throw new Error(JSON.stringify(committed));
				return { events: [], committedDoc: committed.nextDoc };
			},
		);
		const result = await h.runTool(configureConnectTool, {
			mode: "learn",
			participants: [
				{
					formUuid: FIRST,
					connect: {
						learn_module: {
							id: "lesson",
							name: "Updated lesson",
							description: "Read",
							time_estimate: 10,
						},
					},
				},
			],
		});
		expect(result.result).toMatchObject({
			ok: true,
			mode: "learn",
			participants: [FIRST, SECOND],
			cleared: [],
			concurrentChanges: true,
			summary: { connect: "learn", count: 2 },
		});
		expect(h.currentDoc().forms[SECOND].connect).toMatchObject({
			learn_module: { id: "second" },
		});
	});

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
		const harness = makeToolWorkspaceHarness(expectAdmittedDoc(doc));
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

	it("reports an already-disabled target without committing or treating it as a failure", async () => {
		const doc = fixture();
		const harness = makeToolWorkspaceHarness(expectAdmittedDoc(doc));
		const outcome = await harness.runTool(configureConnectTool, { mode: null });

		expect(outcome).toMatchObject({
			mutations: [],
			result: {
				ok: true,
				unchanged: true,
				mode: null,
				participants: [],
				cleared: [],
			},
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();
		expect(harness.currentDoc()).toBe(doc);
	});

	it("reports an already-satisfied target without persisting", async () => {
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
			result: {
				ok: true,
				unchanged: true,
				mode: "learn",
				participants: [FIRST],
			},
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

		expect(reconfigured.result).toMatchObject({ ok: true, unchanged: true });
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

		expect(reconfigured.result).toMatchObject({ ok: true, unchanged: true });
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
		const harness = makeToolWorkspaceHarness(expectAdmittedDoc(doc));
		const outcome = await harness.runTool(configureConnectTool, {
			mode: "learn",
			participants,
		});

		expect(outcome.result).toEqual({
			error: expect.stringContaining(error),
		});
		expect(outcome.mutations).toEqual([]);
		expect(harness.currentDoc()).toBe(doc);
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("emits an independently executable closed Connect schema", async () => {
		const ajv = new Ajv({ strict: false });
		addFormats(ajv);
		const validate = ajv.compile(
			await wireToolSchema(configureConnectInputSchema).jsonSchema,
		);
		const valid = {
			mode: "learn",
			participants: [{ formUuid: FIRST, connect: learnModule() }],
		};
		expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
		expect(
			validate({
				...valid,
				participants: [{ ...valid.participants[0], typo: true }],
			}),
		).toBe(false);
		expect(validate({ ...valid, mode: "unknown" })).toBe(false);
	});
});
