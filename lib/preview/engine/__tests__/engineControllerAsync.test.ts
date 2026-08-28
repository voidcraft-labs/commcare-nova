import { afterEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	collectTranslationUnits,
	type Field,
	makeTranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import type { XPathWorkerEvaluateRequest } from "../../xpath/workerProtocol";
import { EngineController } from "../engineController";
import type { ResolvedPreviewIdentity } from "../identity";
import { previewLookupData } from "../lookupEvaluation";

const MODULE_UUID = testUuid("async-module");
const FORM_UUID = testUuid("async-form");
const FIELD_UUID = testUuid("async-field");
const SECOND_FIELD_UUID = testUuid("async-second-field");
const RESULT_FIELD_UUID = testUuid("async-result-field");
const REPEAT_UUID = testUuid("async-repeat-field");
const REPEAT_CHILD_UUID = testUuid("async-repeat-child-field");

function docWith(...fields: Field[]): PersistableDoc {
	return {
		appId: "app",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: { uuid: MODULE_UUID, id: "module", name: "Module" },
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "form",
				name: "Form",
				type: "survey",
			},
		},
		fields: Object.fromEntries(fields.map((field) => [field.uuid, field])),
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: fields.map((field) => field.uuid) as Uuid[] },
	};
}

function controller(...fields: Field[]): EngineController {
	const store = createBlueprintDocStore();
	store.getState().load(docWith(...fields));
	store.getState().startTracking();
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	const result = new EngineController(runtime);
	result.setDocStore(store);
	return result;
}

function controllerForDoc(
	doc: PersistableDoc,
	evaluate?: Parameters<typeof createInProcessXPathWorkerFactory>[0],
): EngineController {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.getState().startTracking();
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(evaluate),
	});
	const result = new EngineController(runtime);
	result.setDocStore(store);
	return result;
}

afterEach(() => vi.useRealTimers());

describe("EngineController async runtime", () => {
	it("retains every rapid raw edit and reconciles their shared async DAG once", async () => {
		const ctrl = controller(
			{
				uuid: FIELD_UUID,
				id: "first",
				kind: "text",
				label: proseText("First"),
			},
			{
				uuid: SECOND_FIELD_UUID,
				id: "second",
				kind: "text",
				label: proseText("Second"),
			},
			{
				uuid: RESULT_FIELD_UUID,
				id: "combined",
				kind: "hidden",
				calculate: xp("sleep(0, concat(/data/first, '-', /data/second))"),
			},
		);
		await ctrl.activateFormAsync(FORM_UUID);

		const first = ctrl.onValueChangeAsync(FIELD_UUID, "A");
		const second = ctrl.onValueChangeAsync(SECOND_FIELD_UUID, "B");
		await Promise.all([first, second]);

		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("A");
		expect(ctrl.store.getState()[SECOND_FIELD_UUID]?.value).toBe("B");
		expect(ctrl.store.getState()[RESULT_FIELD_UUID]?.value).toBe("A-B");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("preserves typed default values in later worker-world deltas", async () => {
		const ctrl = controller(
			{
				uuid: FIELD_UUID,
				id: "count",
				kind: "int",
				label: proseText("Count"),
				default_value: xp("0"),
			},
			{
				uuid: RESULT_FIELD_UUID,
				id: "count_is_true",
				kind: "hidden",
				calculate: xp("boolean(/data/count)"),
			},
		);

		await ctrl.activateFormAsync(FORM_UUID);

		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("0");
		expect(ctrl.store.getState()[RESULT_FIELD_UUID]?.value).toBe("false");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("settles a staged value before a superseding blur validates it", async () => {
		const ctrl = controller(
			{
				uuid: FIELD_UUID,
				id: "first",
				kind: "text",
				label: proseText("First"),
			},
			{
				uuid: RESULT_FIELD_UUID,
				id: "copy",
				kind: "hidden",
				calculate: xp("sleep(0, /data/first)"),
			},
		);
		await ctrl.activateFormAsync(FORM_UUID);

		const edit = ctrl.onValueChangeAsync(FIELD_UUID, "latest");
		const blur = ctrl.onTouchAsync(FIELD_UUID);
		await Promise.all([edit, blur]);

		expect(ctrl.store.getState()[FIELD_UUID]).toMatchObject({
			value: "latest",
			touched: true,
		});
		expect(ctrl.store.getState()[RESULT_FIELD_UUID]?.value).toBe("latest");
		expect(await ctrl.validateAllAsync()).toBe(true);
		ctrl.dispose();
	});

	it("finishes each queued repeat addition before the next mutates topology", async () => {
		vi.useFakeTimers();
		const doc = docWith(
			{
				uuid: REPEAT_UUID,
				id: "items",
				kind: "repeat",
				label: proseText("Items"),
				repeat_mode: "user_controlled",
			},
			{
				uuid: REPEAT_CHILD_UUID,
				id: "name",
				kind: "text",
				label: proseText("Name"),
				default_value: xp("sleep(1, 'ready')"),
			},
		);
		doc.fieldOrder = {
			[FORM_UUID]: [REPEAT_UUID],
			[REPEAT_UUID]: [REPEAT_CHILD_UUID],
		};
		const ctrl = controllerForDoc(doc);
		const activation = ctrl.activateFormAsync(FORM_UUID);
		await vi.runAllTimersAsync();
		await activation;

		const first = ctrl.addRepeatAsync(REPEAT_UUID);
		const second = ctrl.addRepeatAsync(REPEAT_UUID);
		await vi.runAllTimersAsync();
		await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);

		expect(ctrl.getRepeatCount(REPEAT_UUID)).toBe(3);
		expect(ctrl.store.getState()["/data/items[1]/name"]?.value).toBe("ready");
		expect(ctrl.store.getState()["/data/items[2]/name"]?.value).toBe("ready");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();

		const compactions: unknown[] = [];
		ctrl.subscribeRepeatCompaction((event) => compactions.push(event));
		const removal = ctrl.removeRepeatAsync(REPEAT_UUID, 0);
		const replacement = ctrl.addRepeatAsync(REPEAT_UUID);
		await vi.runAllTimersAsync();
		await expect(Promise.all([removal, replacement])).resolves.toEqual([
			true,
			2,
		]);
		expect(compactions).toHaveLength(1);
		expect(ctrl.getRepeatCount(REPEAT_UUID)).toBe(3);
		expect(ctrl.store.getState()["/data/items[2]/name"]?.value).toBe("ready");
		ctrl.dispose();
	});

	it("reapplies untouched defaults when an async rebuild restores repeat rows", async () => {
		const doc = docWith(
			{
				uuid: REPEAT_UUID,
				id: "items",
				kind: "repeat",
				label: proseText("Items"),
				repeat_mode: "user_controlled",
			},
			{
				uuid: REPEAT_CHILD_UUID,
				id: "name",
				kind: "text",
				label: proseText("Name"),
				default_value: xp("sleep(0, 'ready')"),
			},
		);
		doc.fieldOrder = {
			[FORM_UUID]: [REPEAT_UUID],
			[REPEAT_UUID]: [REPEAT_CHILD_UUID],
		};
		const ctrl = controllerForDoc(doc);
		await ctrl.activateFormAsync(FORM_UUID);
		await ctrl.addRepeatAsync(REPEAT_UUID);
		expect(ctrl.store.getState()["/data/items[1]/name"]?.value).toBe("ready");

		await ctrl.rebuildActiveFormAsync(FORM_UUID);

		expect(ctrl.getRepeatCount(REPEAT_UUID)).toBe(2);
		expect(ctrl.store.getState()["/data/items[0]/name"]?.value).toBe("ready");
		expect(ctrl.store.getState()["/data/items[1]/name"]?.value).toBe("ready");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("rejects a positional edit while repeat compaction owns topology", async () => {
		vi.useFakeTimers();
		const doc = docWith(
			{
				uuid: REPEAT_UUID,
				id: "items",
				kind: "repeat",
				label: proseText("Items"),
				repeat_mode: "user_controlled",
			},
			{
				uuid: REPEAT_CHILD_UUID,
				id: "name",
				kind: "text",
				label: proseText("Name"),
				default_value: xp("sleep(1, 'ready')"),
			},
		);
		doc.fieldOrder = {
			[FORM_UUID]: [REPEAT_UUID],
			[REPEAT_UUID]: [REPEAT_CHILD_UUID],
		};
		const ctrl = controllerForDoc(doc);
		const activation = ctrl.activateFormAsync(FORM_UUID);
		await vi.runAllTimersAsync();
		await activation;
		const additions = [
			ctrl.addRepeatAsync(REPEAT_UUID),
			ctrl.addRepeatAsync(REPEAT_UUID),
		];
		await vi.runAllTimersAsync();
		await Promise.all(additions);
		await ctrl.setValueAtAsync("/data/items[0]/name", "first");
		await ctrl.setValueAtAsync("/data/items[1]/name", "second");
		await ctrl.setValueAtAsync("/data/items[2]/name", "third");

		const removal = ctrl.removeRepeatAsync(REPEAT_UUID, 0);
		expect(ctrl.entryStore.getState().topologySettling).toBe(true);
		await expect(
			ctrl.setValueAtAsync("/data/items[1]/name", "stale positional edit"),
		).resolves.toBe(false);
		await vi.runAllTimersAsync();
		await expect(removal).resolves.toBe(true);

		expect(ctrl.store.getState()["/data/items[0]/name"]?.value).toBe("second");
		expect(ctrl.store.getState()["/data/items[1]/name"]?.value).toBe("third");
		expect(ctrl.entryStore.getState().topologySettling).toBe(false);
		ctrl.dispose();
	});

	it("initializes one worker world per revision and reuses its snapshots", async () => {
		const requests: XPathWorkerEvaluateRequest[] = [];
		const ctrl = controllerForDoc(
			docWith(
				{
					uuid: FIELD_UUID,
					id: "answer",
					kind: "text",
					label: proseText("Answer"),
				},
				{
					uuid: RESULT_FIELD_UUID,
					id: "copy",
					kind: "hidden",
					calculate: xp("/data/answer"),
				},
				{
					uuid: SECOND_FIELD_UUID,
					id: "result",
					kind: "hidden",
					calculate: xp("/data/copy"),
				},
			),
			(request) => {
				requests.push(request);
				return request.source === "/data/answer" ? "computed" : "done";
			},
		);
		await ctrl.activateFormAsync(FORM_UUID);
		requests.length = 0;
		await ctrl.onValueChangeAsync(FIELD_UUID, "changed");

		expect(requests.length).toBeGreaterThan(1);
		expect(requests[0]?.instances).toMatchObject({ initializeWorld: true });
		expect(requests[0]?.instances.main).toBeDefined();
		for (const request of requests.slice(1)) {
			expect(request.instances.initializeWorld).toBe(false);
			expect(request.instances.main).toBeUndefined();
			expect(request.instances.secondary).toBeUndefined();
		}
		ctrl.dispose();
	});

	it("publishes case-write-only edits without starting a worker revision", async () => {
		const requests: XPathWorkerEvaluateRequest[] = [];
		const doc = docWith(
			{
				uuid: FIELD_UUID,
				id: "answer",
				kind: "hidden",
				calculate: xp("sleep(0, 'ready')"),
				caseWrite: { caseType: "patient", property: "age" },
			},
			{
				uuid: SECOND_FIELD_UUID,
				id: "case_name",
				kind: "hidden",
				calculate: xp("'Patient'"),
				caseWrite: { caseType: "patient", property: "case_name" },
			},
		);
		doc.caseTypes = [
			{
				name: "patient",
				properties: [
					{
						name: "case_name",
						label: proseText("Name"),
						data_type: "text",
					},
					{
						name: "age",
						label: proseText("Age"),
						data_type: "text",
					},
					{
						name: "nickname",
						label: proseText("Nickname"),
						data_type: "text",
					},
				],
			},
		];
		doc.modules[MODULE_UUID] = {
			...doc.modules[MODULE_UUID],
			caseType: "patient",
		};
		doc.forms[FORM_UUID] = {
			...doc.forms[FORM_UUID],
			type: "registration",
		};
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		store.getState().startTracking();
		const ctrl = new EngineController(
			new XPathRuntime({
				workerFactory: createInProcessXPathWorkerFactory((request) => {
					requests.push(request);
					return "ready";
				}),
			}),
		);
		ctrl.setDocStore(store);
		await ctrl.activateFormAsync(FORM_UUID);
		const entryKey = ctrl.entryKey;
		if (entryKey === undefined) throw new Error("Expected entry");
		requests.length = 0;
		const before = store.getState();

		store.getState().applyMany([
			{
				kind: "updateField",
				uuid: FIELD_UUID,
				targetKind: "hidden",
				patch: { caseWrite: { caseType: "patient", property: "nickname" } },
			},
		]);
		await ctrl.awaitSettled();

		expect(store.getState().caseTypes).toBe(before.caseTypes);
		expect(store.getState().forms[FORM_UUID]).toBe(before.forms[FORM_UUID]);
		expect(store.getState().fieldOrder).toBe(before.fieldOrder);
		expect(
			requests.map((request) => ({
				profile: request.profile,
				source: request.source,
			})),
		).toEqual([]);
		const snapshot = await ctrl.computeSubmissionMutationAsync({}, entryKey);
		expect(snapshot?.documentState).toBe(store.getState());
		const submittedField = snapshot?.documentState.fields[FIELD_UUID] as
			| Extract<Field, { kind: "hidden" }>
			| undefined;
		expect(submittedField?.caseWrite).toEqual({
			caseType: "patient",
			property: "nickname",
		});
		expect(snapshot?.mutation).toMatchObject({
			kind: "registration",
			primary: {
				caseType: "patient",
				caseName: "ready",
				properties: { nickname: "ready" },
			},
		});
		expect(snapshot?.mutation).not.toHaveProperty("primary.properties.age");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("retains a neutral document snapshot while a successor value revision settles", async () => {
		vi.useFakeTimers();
		const store = createBlueprintDocStore();
		store.getState().load(
			docWith(
				{
					uuid: FIELD_UUID,
					id: "answer",
					kind: "text",
					label: proseText("Answer"),
				},
				{
					uuid: RESULT_FIELD_UUID,
					id: "copy",
					kind: "hidden",
					calculate: xp("sleep(20, /data/answer)"),
				},
			),
		);
		store.getState().startTracking();
		const ctrl = new EngineController(
			new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() }),
		);
		ctrl.setDocStore(store);
		const activation = ctrl.activateFormAsync(FORM_UUID);
		await vi.runAllTimersAsync();
		await expect(activation).resolves.toBe(true);
		const entryKey = ctrl.entryKey;
		if (entryKey === undefined) throw new Error("Expected entry");

		const firstEdit = ctrl.onValueChangeAsync(FIELD_UUID, "first");
		await vi.advanceTimersByTimeAsync(0);
		store.getState().applyMany([
			{
				kind: "updateField",
				uuid: FIELD_UUID,
				targetKind: "text",
				patch: { label: proseText("Renamed answer") },
			},
		]);
		const secondEdit = ctrl.onValueChangeAsync(FIELD_UUID, "second");
		expect(ctrl.entryStore.getState().settling).toBe(true);
		await vi.runAllTimersAsync();
		await Promise.all([firstEdit, secondEdit]);

		const snapshot = await ctrl.computeSubmissionMutationAsync({}, entryKey);
		expect(snapshot?.documentState).toBe(store.getState());
		expect(ctrl.store.getState()[RESULT_FIELD_UUID]?.value).toBe("second");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("exposes the lookup snapshot captured by the active entry", async () => {
		const first = previewLookupData({
			projectRevision: "1",
			definitions: [],
			rowsByTable: new Map(),
		});
		const refreshed = previewLookupData({
			projectRevision: "2",
			definitions: [],
			rowsByTable: new Map(),
		});
		const ctrl = controller({
			uuid: FIELD_UUID,
			id: "answer",
			kind: "text",
			label: proseText("Answer"),
		});
		ctrl.setLookupData(first);
		await ctrl.activateFormAsync(FORM_UUID);
		ctrl.setLookupData(refreshed);

		expect(ctrl.previewLookupDataSnapshot).toBe(first);
		await ctrl.restartActiveEntryAsync();
		expect(ctrl.previewLookupDataSnapshot).toBe(refreshed);
		ctrl.dispose();
	});

	it("surfaces a form-link worker failure instead of choosing a route", async () => {
		const ctrl = controllerForDoc(
			docWith({
				uuid: FIELD_UUID,
				id: "answer",
				kind: "text",
				label: proseText("Answer"),
			}),
			(request) => {
				if (request.profile === "form-link") throw new Error("worker failed");
				return "";
			},
		);
		await ctrl.activateFormAsync(FORM_UUID);
		const entryKey = ctrl.entryKey;
		if (entryKey === undefined) throw new Error("Expected entry");

		await expect(
			ctrl.evaluateFormLinkXPath(
				"true()",
				{ contextPath: "", position: 1 },
				entryKey,
			),
		).rejects.toThrow("after-submit route");
		expect(ctrl.entryStore.getState().fault?.operation).toBe("submission");
		ctrl.dispose();
	});

	it("runs every after-submit XPath in one worker revision and world", async () => {
		const requests: XPathWorkerEvaluateRequest[] = [];
		const ctrl = controllerForDoc(
			docWith({
				uuid: FIELD_UUID,
				id: "answer",
				kind: "text",
				label: proseText("Answer"),
			}),
			(request) => {
				requests.push(request);
				return request.source;
			},
		);
		await ctrl.activateFormAsync(FORM_UUID);
		const entryKey = ctrl.entryKey;
		if (entryKey === undefined) throw new Error("Expected entry");
		requests.length = 0;

		await expect(
			ctrl.evaluateFormLinkXPaths(entryKey, async (evaluate) => {
				const first = await evaluate("first", {
					worldKey: "after-submit-world",
					initializeWorld: true,
					secondary: [],
					contextPath: "",
				});
				const second = await evaluate("second", {
					worldKey: "after-submit-world",
					initializeWorld: false,
					contextPath: "",
				});
				return [first, second];
			}),
		).resolves.toEqual(["first", "second"]);

		expect(requests).toHaveLength(2);
		expect(new Set(requests.map((request) => request.revision)).size).toBe(1);
		expect(
			requests.map((request) => request.instances.initializeWorld),
		).toEqual([true, false]);
		expect(requests[1]?.instances.secondary).toBeUndefined();
		ctrl.dispose();
	});

	it("publishes a staged entry only after worker defaults settle", async () => {
		const ctrl = controller({
			uuid: FIELD_UUID,
			id: "answer",
			kind: "text",
			label: proseText("Answer"),
			default_value: xp("sleep(0, 'ready')"),
		});

		const activation = ctrl.activateFormAsync(FORM_UUID);
		expect(ctrl.entryStore.getState().settling).toBe(true);
		await expect(activation).resolves.toBe(true);
		expect(ctrl.entryStore.getState()).toMatchObject({
			formUuid: FORM_UUID,
			settling: false,
			fault: undefined,
		});
		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("ready");
		ctrl.dispose();
	});

	it("restarts activation from the latest document when an edit lands while the worker settles", async () => {
		vi.useFakeTimers();
		const store = createBlueprintDocStore();
		store.getState().load(
			docWith({
				uuid: FIELD_UUID,
				id: "answer",
				kind: "text",
				label: proseText("Answer"),
				default_value: xp("sleep(10, 'old-default')"),
			}),
		);
		store.getState().startTracking();
		const ctrl = new EngineController(
			new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() }),
		);
		ctrl.setDocStore(store);

		const activation = ctrl.activateFormAsync(FORM_UUID);
		store.getState().applyMany([
			{
				kind: "updateField",
				uuid: FIELD_UUID,
				targetKind: "text",
				patch: { default_value: xp("sleep(0, 'new-default')") },
			},
		]);
		await vi.runAllTimersAsync();

		await expect(activation).resolves.toBe(true);
		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("new-default");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("re-derives untouched worker-backed defaults after a property rename", async () => {
		const propertyUuid = testUuid("async-worker-property");
		const doc = docWith({
			uuid: FIELD_UUID,
			id: "region",
			kind: "text",
			label: proseText("Region"),
			default_value: {
				parts: [{ kind: "user-property-ref", userPropertyUuid: propertyUuid }],
			},
		});
		doc.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "assigned_region",
				label: "Assigned region",
			},
		};
		doc.userPropertyOrder = [propertyUuid];
		const identity: ResolvedPreviewIdentity = {
			actorUserId: "worker",
			ownerId: "worker",
			session: {
				context: { userid: "worker" },
				user: { assigned_region: "north", supervision_area: "south" },
				userPropertySlugs: { [propertyUuid]: "assigned_region" },
			},
			usercase: { assigned_region: "north", supervision_area: "south" },
		};
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		store.getState().startTracking();
		const ctrl = new EngineController(
			new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() }),
		);
		ctrl.setDocStore(store);
		ctrl.setPreviewIdentity(identity);
		await ctrl.activateFormAsync(FORM_UUID);
		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("north");

		store.getState().applyMany([
			{
				kind: "updateUserProperty",
				uuid: propertyUuid,
				patch: { slug: "supervision_area", label: "Supervision area" },
			},
		]);
		await ctrl.awaitSettled();

		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("south");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("applies worker defaults added, edited, and retyped into a live form", async () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			docWith({
				uuid: FIELD_UUID,
				id: "answer",
				kind: "text",
				label: proseText("Answer"),
			}),
		);
		store.getState().startTracking();
		const ctrl = new EngineController(
			new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() }),
		);
		ctrl.setDocStore(store);
		await ctrl.activateFormAsync(FORM_UUID);

		store.getState().applyMany([
			{
				kind: "updateField",
				uuid: FIELD_UUID,
				targetKind: "text",
				patch: { default_value: xp("sleep(0, 'edited-default')") },
			},
		]);
		await ctrl.awaitSettled();
		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("edited-default");

		await ctrl.onValueChangeAsync(FIELD_UUID, "typed");
		store
			.getState()
			.applyMany([
				{ kind: "convertField", uuid: FIELD_UUID, toKind: "secret" },
			]);
		await ctrl.awaitSettled();
		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("edited-default");

		store.getState().applyMany([
			{
				kind: "addField",
				parentUuid: FORM_UUID,
				field: {
					uuid: SECOND_FIELD_UUID,
					id: "added",
					kind: "text",
					label: proseText("Added"),
					default_value: xp("sleep(0, 'added-default')"),
				},
			},
		]);
		await ctrl.awaitSettled();
		expect(ctrl.store.getState()[SECOND_FIELD_UUID]?.value).toBe(
			"added-default",
		);
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("rebuilds localization changes through the worker while preserving the entry", async () => {
		const greeting = {
			parts: [
				{ kind: "text" as const, text: "Hello " },
				{ kind: "field-ref" as const, uuid: FIELD_UUID },
			],
		};
		const translated = {
			parts: [
				{ kind: "text" as const, text: "Hola " },
				{ kind: "field-ref" as const, uuid: FIELD_UUID },
			],
		};
		const doc = docWith(
			{
				uuid: FIELD_UUID,
				id: "name",
				kind: "text",
				label: proseText("Name"),
			},
			{
				uuid: SECOND_FIELD_UUID,
				id: "greeting",
				kind: "text",
				label: greeting,
			},
			{
				uuid: RESULT_FIELD_UUID,
				id: "copy",
				kind: "hidden",
				calculate: xp("sleep(0, /data/name)"),
			},
		);
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		store.getState().startTracking();
		const unitId = makeTranslationUnitId("field", SECOND_FIELD_UUID, "label");
		const unit = collectTranslationUnits(store.getState()).find(
			(candidate) => candidate.id === unitId,
		);
		if (unit === undefined) throw new Error("Expected translation unit");
		store.getState().applyMany([
			{ kind: "addLanguage", language: { language: "spa" } },
			{
				kind: "setTranslation",
				language: "spa",
				unitId,
				entry: {
					value: translated,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		]);
		const ctrl = new EngineController(
			new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() }),
		);
		ctrl.setDocStore(store);
		ctrl.setPresentationLanguage("spa");
		await ctrl.activateFormAsync(FORM_UUID);
		await ctrl.onValueChangeAsync(FIELD_UUID, "Amina");
		const entryKey = ctrl.entryKey;

		store.getState().applyMany([
			{
				kind: "setTranslation",
				language: "spa",
				unitId,
				entry: {
					value: {
						parts: [
							{ kind: "text", text: "Paciente: " },
							{ kind: "field-ref", uuid: FIELD_UUID },
						],
					},
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		]);
		await ctrl.awaitSettled();

		expect(ctrl.entryKey).toBe(entryKey);
		expect(ctrl.store.getState()[FIELD_UUID]?.value).toBe("Amina");
		expect(ctrl.store.getState()[RESULT_FIELD_UUID]?.value).toBe("Amina");
		expect(ctrl.store.getState()[SECOND_FIELD_UUID]?.resolvedLabel).toBe(
			"Paciente: Amina",
		);
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("keeps an explicitly carried closed case database through provider refresh", async () => {
		const ctrl = controller({
			uuid: RESULT_FIELD_UUID,
			id: "status",
			kind: "hidden",
			calculate: xp(
				"string(instance('casedb')/casedb/case[@case_id='closed-1']/@status)",
			),
		});
		const closedCase = {
			case_id: "closed-1",
			app_id: "app",
			case_type: "patient",
			owner_id: "worker-1",
			status: "closed",
			opened_on: null,
			modified_on: null,
			closed_on: null,
			case_name: "Closed patient",
			external_id: null,
			parent_case_id: null,
			properties: {},
		} as const;
		await ctrl.activateFormAsync(FORM_UUID, undefined, {
			rows: [closedCase],
			indices: [],
		});
		expect(ctrl.store.getState()[RESULT_FIELD_UUID]?.value).toBe("closed");

		ctrl.setCaseDatabaseState({
			required: true,
			status: "ready",
			snapshot: { rows: [], indices: [] },
		});
		await ctrl.awaitSettled();
		expect(ctrl.store.getState()[RESULT_FIELD_UUID]?.value).toBe("closed");
		expect(ctrl.entryStore.getState().fault).toBeUndefined();
		ctrl.dispose();
	});

	it("cancels worker delay and fences the late activation on navigation", async () => {
		vi.useFakeTimers();
		const ctrl = controller({
			uuid: FIELD_UUID,
			id: "answer",
			kind: "text",
			label: proseText("Answer"),
			default_value: xp("sleep(60000, 'late')"),
		});
		const activation = ctrl.activateFormAsync(FORM_UUID);
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);

		ctrl.deactivate();
		await expect(activation).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctrl.formUuid).toBeUndefined();
		expect(ctrl.store.getState()).toEqual({});
		expect(vi.getTimerCount()).toBe(0);
		ctrl.dispose();
	});

	it("submission fences on the entry that finished validation", async () => {
		const ctrl = controller({
			uuid: FIELD_UUID,
			id: "answer",
			kind: "text",
			label: proseText("Answer"),
			required: xp("sleep(0, true())"),
		});
		await ctrl.activateFormAsync(FORM_UUID);
		const entryKey = ctrl.entryKey;
		if (entryKey === undefined) throw new Error("Expected entry");
		expect(await ctrl.validateAllAsync()).toBe(false);
		await ctrl.restartActiveEntryAsync();
		await expect(
			ctrl.computeSubmissionMutationAsync({}, entryKey),
		).resolves.toBe(undefined);
		ctrl.dispose();
	});
});
