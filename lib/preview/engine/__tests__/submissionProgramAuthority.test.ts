import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	addFixtureField,
	buildDoc,
	caseListConfig,
	f,
} from "@/lib/__tests__/docHelpers";
import { sharedWorkerRepeat } from "@/lib/__tests__/sharedWorkerRepeat";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { CaseOperation } from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import {
	androidDevice,
	webAppsDevice,
} from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { sharedVisitEntries } from "../../../../proof/targeted/documents/sharedVisitEntries";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	buildCaseOperationProgramFromDoc,
	buildSubmissionOperationProgram,
	submissionEnvelopeArgs,
} from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import type { ResolvedPreviewIdentity } from "../identity";
import {
	acceptanceDoc,
	conditionalCloseDoc,
	engineFor,
	ordinaryAuthorityDoc,
	ordinaryAuthorityMutation,
} from "./fixtures/submissionProgram";

const ACTOR = "worker-1";
const SESSION_CASE = "50000000-0000-0000-0000-000000000001";
const SECOND_SESSION_CASE = "50000000-0000-0000-0000-000000000002";
const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const OP_ROOT = testUuid("60000000-0000-7000-8000-00000000a001");
const IDENTITY: ResolvedPreviewIdentity = {
	actorUserId: ACTOR,
	ownerId: ACTOR,
	session: {
		context: { userid: ACTOR, username: "ada" },
		user: { role: "supervisor" },
		userPropertySlugs: {},
	},
	usercase: { role: "supervisor" },
};

describe("automatic submission location", () => {
	it("records the entry fix separately from answers and refuses a fix outside the committed form or platform", async () => {
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const mutation = ordinaryAuthorityMutation(doc, formUuid);
		const fix = { latitude: 12, longitude: -73, altitude: 7, accuracy: 4 };
		const requested = {
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: { ...doc.forms[formUuid], captureLocation: true as const },
			},
		};
		const build = async (
			blueprint: typeof doc,
			device: ReturnType<typeof webAppsDevice>,
			locationFix?: typeof fix,
		) => {
			const submitted = {
				...mutation,
				...(locationFix !== undefined && { locationFix }),
			};
			const built = await buildSubmissionOperationProgram({
				appId: doc.appId,
				committedApp: { blueprint, mutation_seq: 2 },
				blueprintDigest: "b".repeat(64),
				identity: IDENTITY,
				device,
				lookupScope: {
					projectId: "local-project",
					actorId: ACTOR,
					role: "editor",
				},
				lookupTableSchemas: new Map(),
				mutation: submitted,
				projection: validateCaptureSubmissionProjection(submitted),
			});
			return submissionEnvelopeArgs(submitted, doc.appId, built);
		};
		expect(
			(await build(requested, androidDevice(), fix)).submissionLocation,
		).toEqual(fix);
		expect(
			(await build(requested, androidDevice())).submissionLocation,
		).toBeNull();
		expect(
			(await build(requested, webAppsDevice())).submissionLocation,
		).toBeNull();
		expect(await build(doc, androidDevice())).not.toHaveProperty(
			"submissionLocation",
		);
		await expect(build(requested, webAppsDevice(), fix)).rejects.toThrow(
			"device location",
		);
		await expect(build(doc, androidDevice(), fix)).rejects.toThrow(
			"device location",
		);
	});
});

it("authorizes the shared worker selection without executing its empty advanced load", () => {
	const { doc, form, shared, worker } = sharedWorkerRepeat(false);
	const build = (formUuid: typeof shared) => {
		const input = buildEngineInput(doc, formUuid, null);
		if (!input) throw new Error("Expected the committed follow-up entry");
		const mutation = new FormEngine(input).computeSubmissionMutation({
			caseIds: [SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		return buildCaseOperationProgramFromDoc({
			blueprint: doc,
			identity: IDENTITY,
			device: webAppsDevice(),
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
		});
	};
	const selected = build(shared);
	expect(selected.ordinaryAction).toMatchObject({
		kind: "followup",
		caseType: "commcare-user",
		caseIds: [SESSION_CASE],
	});
	expect(
		selected.program?.operations.map(({ operation }) => operation.uuid),
	).toEqual([worker]);
	expect(selected.program?.scopes[1]?.iterations).toEqual([]);
	expect(
		build(form).program?.operations.map(({ operation }) => operation.action),
	).toEqual(["own", "update"]);
});

describe("automatic submission location on a shared entry", () => {
	// A shared entry holds no location request of its own: whether a submission
	// carries the device's fix follows the form it opens.
	it("takes the fix where the form the entry opens asks for location, and refuses it where that form does not", async () => {
		const shared = hydratePersistedBlueprint(sharedVisitEntries().doc);
		const entry = Object.values(shared.forms).find(
			(form) => form.name === "Follow a referral",
		);
		if (!entry?.shadowOf) throw new Error("Expected the referral entry.");
		const parent = entry.shadowOf.form;
		const asking = {
			...shared,
			forms: {
				...shared.forms,
				[parent]: { ...shared.forms[parent], captureLocation: true as const },
			},
		};
		const fix = { latitude: 12, longitude: -73, altitude: 7, accuracy: 4 };
		const build = async (
			blueprint: typeof shared,
			locationFix?: typeof fix,
		) => {
			const input = buildEngineInput(blueprint, entry.uuid, null);
			if (!input) throw new Error("Expected the shared visit form.");
			const engine = new FormEngine(input);
			engine.setValue("/data/visit_note", "Reached at home");
			const mutation = engine.computeSubmissionMutation({
				caseIds: [SECOND_SESSION_CASE],
				entryKey: ENTRY_KEY,
			});
			const submitted = {
				...mutation,
				...(locationFix !== undefined && { locationFix }),
			};
			const built = await buildSubmissionOperationProgram({
				appId: blueprint.appId,
				committedApp: { blueprint, mutation_seq: 2 },
				blueprintDigest: "b".repeat(64),
				identity: IDENTITY,
				device: androidDevice(),
				lookupScope: {
					projectId: "local-project",
					actorId: ACTOR,
					role: "editor",
				},
				lookupTableSchemas: new Map(),
				mutation: submitted,
				projection: validateCaptureSubmissionProjection(submitted),
			});
			return submissionEnvelopeArgs(submitted, blueprint.appId, built);
		};
		expect((await build(asking, fix)).submissionLocation).toEqual(fix);
		expect((await build(asking)).submissionLocation).toBeNull();
		expect(await build(shared)).not.toHaveProperty("submissionLocation");
		await expect(build(shared, fix)).rejects.toThrow("device location");
	});
});

describe("committed program input rejection", () => {
	it("builds every case change from the committed form, whatever case structure the client sends", () => {
		// The client names answers. A client that also names destinations, a
		// worker-record write or a close answer changes nothing the program
		// does: the own case, the child creates and the close all come from
		// the committed form.
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const mutation = ordinaryAuthorityMutation(doc, formUuid);
		const build = (submitted: SubmissionMutation, committed = doc) =>
			buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: committed,
				mutation: submitted,
				projection: validateCaptureSubmissionProjection(submitted),
				identity: IDENTITY,
			});
		const built = build(mutation);
		const forged = {
			...mutation,
			primary: {
				caseType: "visit",
				caseName: "Forged",
				properties: { nickname: "The Countess" },
			},
			children: [{ caseType: "lab_result", properties: {} }],
			ordinaryChildBuckets: [{ caseType: "lab_result" }],
			usercase: { role: "admin" },
			closeConditionAnswers: { fieldUuid: formUuid, values: ["done"] },
		} as SubmissionMutation;
		expect(build(forged)).toEqual(built);
		expect(built.ordinaryAction).toEqual({ kind: "registration" });
		expect(
			built.program?.operations.map(({ operation }) => [
				operation.action,
				operation.action === "own" ? undefined : operation.caseType,
				operation.forEach !== undefined,
			]),
		).toEqual([
			["own", undefined, false],
			["create", "visit", false],
			["create", "medication_order", true],
		]);

		const close = conditionalCloseDoc();
		const closeEngine = engineFor(close.doc, close.formUuid);
		closeEngine.setValue("/data/close_when", "done");
		const closeMutation = closeEngine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const closeProgram = build(closeMutation, close.doc).program;
		expect(closeProgram?.ownCase).toEqual({
			caseType: "patient",
			formType: "close",
			closeCondition: close.doc.forms[close.formUuid]?.closeCondition,
		});
		expect(closeProgram?.scopes[0]?.iterations[0]?.formFields).toEqual(
			new Map([[close.conditionFieldUuid, "done"]]),
		);
	});

	it("rejects supplied case IDs when the committed form no longer has the deep link or case operation", () => {
		const { doc, formUuid } = acceptanceDoc(() => []);
		const engine = engineFor(doc, formUuid);
		const mutation = {
			...engine.computeSubmissionMutation({
				caseIds: [SESSION_CASE],
				entryKey: ENTRY_KEY,
			}),
			entrySupplies: {
				entryPointUuid: OP_ROOT,
				creations: [{ operationUuid: formUuid, caseId: "planned-visit" }],
			},
		};
		expect(() =>
			buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation,
				projection: validateCaptureSubmissionProjection(mutation),
				identity: IDENTITY,
			}),
		).toThrow("The deep link no longer opens this form");
	});

	it("rejects a forged batch-close discriminator against a committed followup form before effects", () => {
		const { doc, formUuid } = acceptanceDoc(() => []);
		const engine = engineFor(doc, formUuid);
		const authored = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		expect(authored.kind).toBe("followup");
		const forged = { ...authored, kind: "close" } as SubmissionMutation;
		const projection = validateCaptureSubmissionProjection(forged);

		expect(() =>
			buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation: forged,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("an operation reading an answer the client did not send rejects the final protocol", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_root",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
			} as CaseOperation,
		]);
		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "collected");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const missingAnswers = { ...mutation, operationAnswers: undefined };
		const projection = validateCaptureSubmissionProjection(missingAnswers);
		// A stale client must neither run blank bindings nor silently skip the
		// committed operation program.
		expect(() =>
			buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation: missingAnswers,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("requires the committed owner predicate's answer inside its concrete row", () => {
		const { doc, formUuid, uuids } = acceptanceDoc((fields) => [
			{
				uuid: OP_ROOT,
				id: "repeat_create",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				name: term(literal("Patient from repeat")),
				owner: term(literal("worker-2")),
				ownerCondition: eq(formField(fields.visitNote), literal("assign")),
				forEach: { repeat: fields.visits },
			},
		]);
		const engine = engineFor(doc, formUuid);
		engine.addRepeat("/data/visits");
		engine.setValue("/data/visits[0]/visit_note", "assign");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const answers = mutation.operationAnswers;
		if (!answers) throw new Error("Expected the operation's row answers.");
		const build = (submitted: SubmissionMutation) =>
			buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation: submitted,
				projection: validateCaptureSubmissionProjection(submitted),
				identity: IDENTITY,
			}).program;
		expect(
			build(mutation)
				?.scopes.find(({ repeat }) => repeat === uuids.visits)
				?.iterations[0]?.formFields.get(uuids.visitNote),
		).toBe("assign");
		expect(() =>
			build({
				...mutation,
				operationAnswers: {
					...answers,
					repeats: answers.repeats.map((scope) => ({
						...scope,
						iterations: scope.iterations.map((row) =>
							row.filter(({ fieldUuid }) => fieldUuid !== uuids.visitNote),
						),
					})),
				},
			}),
		).toThrow("missing an answer its committed case operations read");
	});
});

it("binds nested operation order to the committed repeat and the enclosing answers", () => {
	const outer = testUuid("outer-repeat");
	const inner = testUuid("inner-repeat");
	const answer = testUuid("outer-answer");
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "seen", label: proseText("Seen") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "repeat",
								uuid: outer,
								id: "visits",
								label: proseText("Visits"),
								children: [
									f({
										kind: "text",
										uuid: answer,
										id: "outer_value",
										label: proseText("Outer"),
									}),
									f({
										kind: "repeat",
										uuid: inner,
										id: "checks",
										label: proseText("Checks"),
										children: [
											f({
												kind: "text",
												id: "inner_value",
												label: proseText("Inner"),
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const engine = engineFor(doc, formUuid);
	engine.addRepeat("/data/visits");
	engine.addRepeat("/data/visits");
	engine.addRepeat("/data/visits");
	engine.setValue("/data/visits[0]/outer_value", "one");
	engine.setValue("/data/visits[1]/outer_value", "two");
	engine.setValue("/data/visits[2]/outer_value", "three");
	engine.addRepeat("/data/visits[0]/checks");
	engine.addRepeat("/data/visits[0]/checks");
	engine.addRepeat("/data/visits[2]/checks");
	const submitted = engine.computeSubmissionMutation({
		caseIds: [SESSION_CASE],
		entryKey: ENTRY_KEY,
	});
	const answers = submitted.operationAnswers;
	if (!answers)
		throw new Error("Expected the form's case operations to collect answers.");
	const build = (mutation: SubmissionMutation) =>
		buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
			identity: IDENTITY,
		}).program;
	expect(build(submitted)?.scopeOrder).toEqual([
		{ iteration: 0 },
		{ repeat: inner, iteration: 0 },
		{ repeat: inner, iteration: 1 },
		{ repeat: outer, iteration: 0 },
		{ repeat: outer, iteration: 1 },
		{ repeat: inner, iteration: 2 },
		{ repeat: outer, iteration: 2 },
	]);
	for (const parentIterations of [undefined, [0, 1, 2], [0, 0, 3]]) {
		expect(() =>
			build({
				...submitted,
				operationAnswers: {
					...answers,
					repeats: answers.repeats.map((scope) =>
						scope.repeat === inner ? { ...scope, parentIterations } : scope,
					),
				},
			}),
		).toThrow("could not match its nested repeat rows");
	}

	const placed = structuredClone(doc);
	const group = testUuid("conditional-case-group");
	const field = testUuid("placed-change");
	const beforeInner = testUuid("placed-before-inner");
	const insideInner = testUuid("generated-inner");
	const afterInner = testUuid("generated-outer");
	const update = (
		uuid: typeof OP_ROOT,
		id: string,
		repeat: typeof OP_ROOT,
	): CaseOperation => ({
		uuid,
		id,
		action: "update",
		caseType: "patient",
		target: { kind: "expression", expr: term(literal(SESSION_CASE)) },
		forEach: { repeat },
		writes: [{ property: "seen", value: term(literal(id)) }],
	});
	const form = placed.forms[formUuid];
	form.caseOperations = [
		...(form.caseOperations ?? []),
		update(insideInner, "nested", inner),
		update(afterInner, "last", outer),
		update(beforeInner, "placed", outer),
	];
	addFixtureField(placed, outer, {
		uuid: group,
		id: "optional",
		kind: "group",
		label: proseText("Optional"),
		relevant: eq(formField(answer), literal("one")),
	});
	addFixtureField(placed, group, {
		uuid: field,
		id: "case_change",
		kind: "case_change",
		operationUuid: beforeInner,
	});
	placed.fieldOrder[outer] = [answer, group, inner];
	const authored = engineFor(placed, formUuid);
	authored.addRepeat("/data/visits");
	authored.addRepeat("/data/visits");
	authored.setValue("/data/visits[0]/outer_value", "one");
	authored.setValue("/data/visits[1]/outer_value", "two");
	authored.addRepeat("/data/visits[0]/checks");
	authored.addRepeat("/data/visits[1]/checks");
	const positioned = authored.computeSubmissionMutation({
		caseIds: [SESSION_CASE],
		entryKey: ENTRY_KEY,
	});
	const buildPositioned = (mutation: SubmissionMutation) =>
		buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: placed,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
			identity: IDENTITY,
		}).program;
	const root = form.caseOperations.find(
		(operation) => operation.action === "own",
	);
	expect(root).toBeDefined();
	expect(buildPositioned(positioned)?.effectOrder).toEqual([
		{ iteration: 0, operationUuids: [root?.uuid] },
		{ repeat: outer, iteration: 0, operationUuids: [beforeInner] },
		{ repeat: inner, iteration: 0, operationUuids: [insideInner] },
		{ repeat: outer, iteration: 0, operationUuids: [afterInner] },
		{
			repeat: outer,
			iteration: 1,
			operationUuids: [beforeInner],
			absent: true,
		},
		{ repeat: inner, iteration: 1, operationUuids: [insideInner] },
		{ repeat: outer, iteration: 1, operationUuids: [afterInner] },
	]);
	const positionedAnswers = positioned.operationAnswers;
	if (!positionedAnswers)
		throw new Error("Expected positioned operation answers.");
	expect(() =>
		buildPositioned({
			...positioned,
			operationAnswers: {
				...positionedAnswers,
				repeats: positionedAnswers.repeats.map((scope) => ({
					...scope,
					iterations: scope.iterations.map((entries) =>
						entries.filter((entry) => entry.fieldUuid !== field),
					),
				})),
			},
		}),
	).toThrow("missing the position of a case change");
});

describe("an own-case answer that takes no part in the submission", () => {
	it("saves nothing to the case while its question is not relevant, as the wire's update does", () => {
		const { doc, formUuid, uuids } = acceptanceDoc(() => []);
		const shown = eq(formField(uuids.note), literal("show"));
		const gated = {
			...doc,
			fields: {
				...doc.fields,
				[uuids.externalCode]: {
					...doc.fields[uuids.externalCode],
					relevant: shown,
				},
			},
		} as typeof doc;
		const ownWrites = (note: string) => {
			const engine = engineFor(gated, formUuid);
			engine.setValue("/data/note", note);
			engine.setValue("/data/external_code", "EX-1");
			const mutation = engine.computeSubmissionMutation({
				caseIds: [SESSION_CASE],
				entryKey: ENTRY_KEY,
			});
			const program = buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: gated,
				mutation,
				projection: validateCaptureSubmissionProjection(mutation),
				identity: IDENTITY,
			}).program;
			const own = program?.operations.find(
				({ operation }) => operation.action === "own",
			);
			return own?.operation.writes?.map((write) => write.property);
		};
		expect(ownWrites("show")).toEqual(["external_id"]);
		expect(ownWrites("hide")).toEqual([]);
	});
});
