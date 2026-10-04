import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { collectTranslationUnits, makeTranslationUnitId } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import {
	XPathRuntime,
	type XPathWorkerFactory,
	type XPathWorkerMessageEvent,
	type XPathWorkerPort,
} from "../../xpath/workerClient";
import type { XPathWorkerEvaluateRequest } from "../../xpath/workerProtocol";
import { EngineController } from "../engineController";
import { previewAsMe } from "../identity";
import {
	admittedControllerDoc,
	applyControllerEdit,
} from "./fixtures/controllerDoc";

/** Hold one real transport request; every released expression still runs in
 * the production dispatcher. Retirement discards the old port's held work. */
function workerBarrier() {
	const actualFactory = createInProcessXPathWorkerFactory();
	let waiting:
		| ((message: XPathWorkerEvaluateRequest | undefined) => void)
		| undefined;
	let held: { release: () => void; fail: () => void } | undefined;
	const factory: XPathWorkerFactory = () => {
		const actual = actualFactory();
		const errors = new Set<() => void>();
		let terminated = false;
		const port: XPathWorkerPort = {
			postMessage(message) {
				if (message.operation === "evaluate" && waiting !== undefined) {
					const accept = waiting;
					waiting = undefined;
					held = {
						release: () => {
							if (!terminated) actual.postMessage(message);
						},
						fail: () => {
							if (!terminated) for (const listener of errors) listener();
						},
					};
					accept(message);
				} else actual.postMessage(message);
			},
			addEventListener(
				type: "message" | "error",
				listener: (() => void) | ((event: XPathWorkerMessageEvent) => void),
			) {
				if (type === "error") {
					const onError = listener as () => void;
					errors.add(onError);
					actual.addEventListener(type, onError);
				} else
					actual.addEventListener(
						type,
						listener as (event: XPathWorkerMessageEvent) => void,
					);
			},
			removeEventListener(
				type: "message" | "error",
				listener: (() => void) | ((event: XPathWorkerMessageEvent) => void),
			) {
				if (type === "error") {
					const onError = listener as () => void;
					errors.delete(onError);
					actual.removeEventListener(type, onError);
				} else
					actual.removeEventListener(
						type,
						listener as (event: XPathWorkerMessageEvent) => void,
					);
			},
			terminate() {
				terminated = true;
				errors.clear();
				actual.terminate();
			},
		};
		return port;
	};
	return {
		factory,
		holdNext() {
			if (waiting || held) throw new Error("A worker request is already held");
			return new Promise<XPathWorkerEvaluateRequest | undefined>((resolve) => {
				waiting = resolve;
			});
		},
		release() {
			const request = held;
			held = undefined;
			request?.release();
		},
		fail() {
			const request = held;
			held = undefined;
			request?.fail();
		},
		close() {
			this.release();
			waiting?.(undefined);
			waiting = undefined;
		},
	};
}

function fixture(sectioned = false) {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: sectioned ? "section" : "group",
								id: "visit",
								label: proseText("Visit"),
								children: [
									f({ kind: "text", id: "name", label: proseText("Name") }),
									f({
										kind: "text",
										id: "greeting",
										label: proseText("Greeting"),
									}),
									f({
										kind: "datetime",
										id: "when",
										label: proseText("Time"),
										default_value: "'2024-01-15T14:30:00.000-05:00'",
									}),
									f({
										kind: "geopoint",
										id: "point",
										label: proseText("Location"),
									}),
									f({
										kind: "text",
										id: "worker",
										label: proseText("Worker"),
										default_value: "#user/username",
									}),
									f({
										kind: "hidden",
										id: "copy",
										calculate: "#form/visit/name",
									}),
									f({
										kind: "int",
										id: "count",
										label: proseText("Visit count"),
										default_value: "2",
									}),
									f({
										kind: "repeat",
										id: "visits",
										label: proseText("Visits"),
										...(sectioned
											? {
													repeat_mode: "count_bound",
													repeat_count: "#form/visit/count",
												}
											: { repeat_mode: "user_controlled" }),
										children: [
											f({ kind: "text", id: "note", label: proseText("Note") }),
											f({
												kind: "image",
												id: "photo",
												label: proseText("Photo"),
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
	const form = doc.formOrder[doc.moduleOrder[0]][0];
	const otherForm = testUuid("publication-other-form");
	const otherField = testUuid("publication-other-question");
	doc.forms[otherForm] = {
		uuid: otherForm,
		id: "other",
		name: "Another entry",
		type: "survey",
	};
	doc.fields[otherField] = {
		uuid: otherField,
		id: "answer",
		kind: "text",
		label: proseText("Other answer"),
		default_value: xp("'New entry'"),
	};
	doc.formOrder[doc.moduleOrder[0]].push(otherForm);
	doc.fieldOrder[otherForm] = [otherField];
	const fields = Object.fromEntries(
		Object.values(doc.fields).map((field) => [field.id, field]),
	);
	const greeting = fields.greeting;
	if (greeting.kind !== "text")
		throw new Error("Expected the greeting question");
	doc.fields[fields.greeting.uuid] = {
		...greeting,
		label: {
			parts: [
				{ kind: "text", text: "Hello " },
				{ kind: "field-ref", uuid: fields.name.uuid },
			],
		},
	};
	const store = createBlueprintDocStore();
	store.getState().load(admittedControllerDoc(doc));
	store.getState().startTracking();
	const unitId = makeTranslationUnitId("field", fields.greeting.uuid, "label");
	const unit = collectTranslationUnits(store.getState()).find(
		(item) => item.id === unitId,
	);
	if (!unit)
		throw new Error("Expected the greeting's admitted translation unit");
	applyControllerEdit(store, [
		{ kind: "addLanguage", language: { language: "spa" } },
		{
			kind: "setTranslation",
			language: "spa",
			unitId,
			entry: {
				value: {
					parts: [
						{ kind: "text", text: "Hola " },
						{ kind: "field-ref", uuid: fields.name.uuid },
					],
				},
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			},
		},
	]);
	const barrier = workerBarrier();
	const ctrl = new EngineController(
		new XPathRuntime({ workerFactory: barrier.factory }),
	);
	ctrl.setDocStore(store);
	ctrl.setPresentationLanguage("eng");
	return { ctrl, store, barrier, form, fields, otherForm, otherField };
}

async function seed(subject: ReturnType<typeof fixture>) {
	const { ctrl, form, fields } = subject;
	expect(await ctrl.activateFormAsync(form)).toBe(true);
	expect(await ctrl.onValueChangeAsync(fields.name.uuid, "Amina")).toBe(true);
	expect(await ctrl.onValueChangeAsync(fields.point.uuid, "40 -74 0 0")).toBe(
		true,
	);
	if (fields.visit.kind === "group")
		expect(
			await ctrl.addRepeatAsync(fields.visits.uuid, "/data/visit/visits"),
		).toBe(1);
	expect(
		await ctrl.setValueAtAsync("/data/visit/visits[1]/note", "Second visit"),
	).toBe(true);
}

async function cleanup(subject: ReturnType<typeof fixture>) {
	subject.ctrl.dispose();
	subject.barrier.close();
	await subject.ctrl.awaitSettled();
}

describe("same-entry runtime publication", () => {
	it.each(["synchronous", "worker"] as const)(
		"refreshes a restored local error in the selected language with %s execution",
		async (mode) => {
			const doc = buildDoc({
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({
										kind: "datetime",
										id: "when",
										label: proseText("Time"),
										default_value: "'2024-01-15T14:30:00.000-05:00'",
									}),
									f({
										kind: "text",
										id: "untouched",
										label: proseText("Required answer"),
										required: "true()",
									}),
								],
							},
						],
					},
				],
			});
			const form = doc.formOrder[doc.moduleOrder[0]][0];
			const clock = doc.fieldOrder[form][0];
			const untouched = doc.fieldOrder[form][1];
			const store = createBlueprintDocStore();
			store.getState().load(admittedControllerDoc(doc));
			store.getState().startTracking();
			applyControllerEdit(store, [
				{ kind: "addLanguage", language: { language: "spa" } },
			]);
			const ctrl = new EngineController(
				mode === "worker"
					? new XPathRuntime({
							workerFactory: createInProcessXPathWorkerFactory(),
						})
					: undefined,
			);
			ctrl.setDocStore(store);
			ctrl.setPresentationLanguage("eng");
			try {
				expect(await ctrl.activateFormAsync(form)).toBe(true);
				expect(await ctrl.onValueChangeAsync(clock, "2024-01-15T2:4")).toBe(
					true,
				);
				expect(await ctrl.onTouchAsync(clock)).toBe(true);
				const before = ctrl.store.getState()[clock];
				const clean = ctrl.store.getState()[untouched];
				const entryKey = ctrl.entryKey;
				expect(before).toMatchObject({
					value: "2024-01-15T2:4",
					valid: false,
					touched: true,
					edited: true,
					errorMessage:
						"“2:4” isn't a time yet. Enter a clock time like 2:30 PM.",
				});
				expect(clean).toMatchObject({
					value: "",
					required: true,
					valid: true,
					touched: false,
				});
				expect(clean.errorMessage).toBeUndefined();
				for (const [language, errorMessage] of [
					["spa", "«2:4» no es una hora. Introduzca una hora como 14:30."],
					["eng", "“2:4” isn't a time yet. Enter a clock time like 2:30 PM."],
				] as const) {
					ctrl.setPresentationLanguage(language);
					expect(await ctrl.awaitSettled(entryKey)).toBe(true);
					expect(ctrl.store.getState()[clock]).toEqual({
						...before,
						errorMessage,
					});
					expect(ctrl.store.getState()[untouched]).toEqual(clean);
					expect(ctrl.entryStore.getState()).toMatchObject({
						entryKey,
						ready: true,
						rebuilding: false,
						settling: false,
						fault: undefined,
					});
				}
			} finally {
				ctrl.dispose();
				await ctrl.awaitSettled();
			}
		},
	);

	it("retains the actual concrete renderer paths through group, repeat and leaf renames", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields, store } = subject;
		let unsubscribe = () => {};
		try {
			await seed(subject);
			const previous = ctrl.store.getState();
			const previousDocument = ctrl.presentationDocument;
			const repeatPath = `/data/${fields.visit.id}/${fields.visits.id}`;
			const keys = [0, 1].map((index) =>
				ctrl.getRepeatInstanceKey(fields.visits.uuid, index, repeatPath),
			);
			const publications: (typeof previous)[] = [];
			unsubscribe = ctrl.store.subscribe((state) => {
				publications.push(state);
				expect(ctrl.presentationDocument).toBe(store.getState());
				expect(state["/data/encounter/journeys[1]/detail"]?.value).toBe(
					"Second visit",
				);
				expect(
					[0, 1].map((index) =>
						ctrl.getRepeatInstanceKey(
							fields.visits.uuid,
							index,
							"/data/encounter/journeys",
						),
					),
				).toEqual(keys);
			});
			const held = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await held).toBeDefined();
			applyControllerEdit(store, [
				{
					kind: "updateField",
					uuid: fields.visit.uuid,
					targetKind: "group",
					patch: { id: "encounter" },
				},
				{
					kind: "updateField",
					uuid: fields.visits.uuid,
					targetKind: "repeat",
					patch: { id: "journeys" },
				},
				{
					kind: "updateField",
					uuid: fields.note.uuid,
					targetKind: "text",
					patch: { id: "detail" },
				},
			]);
			expect(ctrl.presentationDocument).toBe(previousDocument);
			const document = ctrl.presentationDocument;
			if (!document) throw new Error("The published document is missing");
			const actualPath = `/data/${document.fields[fields.visit.uuid].id}/${document.fields[fields.visits.uuid].id}`;
			expect(actualPath).toBe(repeatPath);
			expect(
				[0, 1].map((index) =>
					ctrl.getRepeatInstanceKey(fields.visits.uuid, index, actualPath),
				),
			).toEqual(keys);
			expect(
				ctrl.store.getState()[
					`${actualPath}[1]/${document.fields[fields.note.uuid].id}`
				]?.value,
			).toBe("Second visit");
			expect(ctrl.store.getState()).toBe(previous);
			barrier.release();
			expect(await ctrl.awaitSettled()).toBe(true);
			expect(publications).toHaveLength(1);
			expect(ctrl.store.getState()["/data/visit/visits[1]/note"]).toMatchObject(
				{ value: "" },
			);
		} finally {
			unsubscribe();
			await cleanup(subject);
		}
	});

	it("acknowledges a capture at its current stable repeated path after a held rename", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields, store } = subject;
		let completion: Promise<boolean> | undefined;
		try {
			await seed(subject);
			const entryKey = ctrl.entryKey;
			if (!entryKey) throw new Error("The active entry is missing");
			const instanceKey = ctrl.getRepeatInstanceKey(
				fields.visits.uuid,
				1,
				"/data/visit/visits",
			);
			const accepted: string[] = [];
			const held = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await held).toBeDefined();
			completion = ctrl.commitCaptureAnswer(
				entryKey,
				{
					fieldUuid: fields.photo.uuid,
					kind: "image",
					repeatInstances: [{ fieldUuid: fields.visits.uuid, instanceKey }],
				},
				"confirmed.png",
				{ signal: new AbortController().signal, isCurrent: () => true },
				(path) => {
					accepted.push(path);
					expect(ctrl.store.getState()[path]?.value).toBe("confirmed.png");
				},
			);
			applyControllerEdit(store, [
				{
					kind: "updateField",
					uuid: fields.visit.uuid,
					targetKind: "group",
					patch: { id: "encounter" },
				},
				{
					kind: "updateField",
					uuid: fields.visits.uuid,
					targetKind: "repeat",
					patch: { id: "journeys" },
				},
				{
					kind: "updateField",
					uuid: fields.photo.uuid,
					targetKind: "image",
					patch: { id: "evidence" },
				},
			]);
			expect(accepted).toEqual([]);
			barrier.release();
			expect(await completion).toBe(true);
			expect(accepted).toEqual(["/data/encounter/journeys[1]/evidence"]);
			expect(
				ctrl.store.getState()["/data/encounter/journeys[0]/evidence"]?.value,
			).toBe("");
			expect(ctrl.entryKey).toBe(entryKey);
		} finally {
			await cleanup(subject);
			await completion;
		}
	});

	it.each(["abort", "deactivate", "new-entry", "fault"] as const)(
		"%s cancels a confirmed capture waiting on replacement without accepting its answer",
		async (boundary) => {
			const subject = fixture();
			const { ctrl, barrier, fields } = subject;
			let completion: Promise<boolean> | undefined;
			try {
				await seed(subject);
				const entryKey = ctrl.entryKey;
				if (!entryKey) throw new Error("The active entry is missing");
				const instanceKey = ctrl.getRepeatInstanceKey(
					fields.visits.uuid,
					0,
					"/data/visit/visits",
				);
				const held = barrier.holdNext();
				ctrl.setPresentationLanguage("spa");
				expect(await held).toBeDefined();
				const abort = new AbortController();
				const accepted: string[] = [];
				completion = ctrl.commitCaptureAnswer(
					entryKey,
					{
						fieldUuid: fields.photo.uuid,
						kind: "image",
						repeatInstances: [{ fieldUuid: fields.visits.uuid, instanceKey }],
					},
					"obsolete.png",
					{ signal: abort.signal, isCurrent: () => true },
					(path) => accepted.push(path),
				);
				if (boundary === "abort") abort.abort();
				else if (boundary === "deactivate") ctrl.deactivate();
				else if (boundary === "new-entry")
					expect(await ctrl.restartActiveEntryAsync()).not.toBe(entryKey);
				else barrier.fail();
				expect(await completion).toBe(false);
				expect(accepted).toEqual([]);
				if (boundary === "abort")
					expect(ctrl.entryStore.getState().rebuilding).toBe(true);
				barrier.release();
				await ctrl.awaitSettled();
				expect(
					Object.values(ctrl.store.getState()).some(
						(state) => state.value === "obsolete.png",
					),
				).toBe(false);
			} finally {
				await cleanup(subject);
				await completion;
			}
		},
	);

	it.each(["removed", "converted", "hidden"] as const)(
		"refuses a %s capture before React needs to commit new props",
		async (change) => {
			const subject = fixture();
			const { ctrl, barrier, fields, store } = subject;
			let completion: Promise<boolean> | undefined;
			try {
				await seed(subject);
				const entryKey = ctrl.entryKey;
				if (!entryKey) throw new Error("The active entry is missing");
				const instanceKey = ctrl.getRepeatInstanceKey(
					fields.visits.uuid,
					0,
					"/data/visit/visits",
				);
				const held = barrier.holdNext();
				ctrl.setPresentationLanguage("spa");
				expect(await held).toBeDefined();
				const accepted: string[] = [];
				completion = ctrl.commitCaptureAnswer(
					entryKey,
					{
						fieldUuid: fields.photo.uuid,
						kind: "image",
						repeatInstances: [{ fieldUuid: fields.visits.uuid, instanceKey }],
					},
					"obsolete.png",
					{ signal: new AbortController().signal, isCurrent: () => true },
					(path) => accepted.push(path),
				);
				applyControllerEdit(
					store,
					change === "removed"
						? [{ kind: "removeField", uuid: fields.photo.uuid }]
						: change === "converted"
							? [
									{
										kind: "convertField",
										uuid: fields.photo.uuid,
										toKind: "audio",
									},
								]
							: [
									{
										kind: "updateField",
										uuid: fields.photo.uuid,
										targetKind: "image",
										patch: { relevant: xp("false()") },
									},
								],
				);
				barrier.release();
				expect(await completion).toBe(false);
				expect(accepted).toEqual([]);
				expect(
					Object.values(ctrl.store.getState()).some(
						(state) => state.value === "obsolete.png",
					),
				).toBe(false);
			} finally {
				await cleanup(subject);
				await completion;
			}
		},
	);

	it("refuses a removed manual row and accepts its compacted survivor without minting repeat identities", async () => {
		const subject = fixture();
		const { ctrl, fields } = subject;
		try {
			await seed(subject);
			const entryKey = ctrl.entryKey;
			if (!entryKey) throw new Error("The active entry is missing");
			const instanceKey = ctrl.getRepeatInstanceKey(
				fields.visits.uuid,
				0,
				"/data/visit/visits",
			);
			const survivingKey = ctrl.getRepeatInstanceKey(
				fields.visits.uuid,
				1,
				"/data/visit/visits",
			);
			expect(
				await ctrl.removeRepeatAsync(
					fields.visits.uuid,
					0,
					"/data/visit/visits",
				),
			).toBe(true);
			await ctrl.awaitSettled();
			expect(ctrl.getRepeatCount(fields.visits.uuid)).toBe(1);
			const accepted: string[] = [];
			expect(
				await ctrl.commitCaptureAnswer(
					entryKey,
					{
						fieldUuid: fields.photo.uuid,
						kind: "image",
						repeatInstances: [{ fieldUuid: fields.visits.uuid, instanceKey }],
					},
					"retired.png",
					{ signal: new AbortController().signal, isCurrent: () => true },
					(path) => accepted.push(path),
				),
			).toBe(false);
			expect(accepted).toEqual([]);
			expect(
				ctrl.getRepeatInstanceKey(fields.visits.uuid, 0, "/data/visit/visits"),
			).toBe(survivingKey);
			expect(
				Object.values(ctrl.store.getState()).some(
					(state) => state.value === "retired.png",
				),
			).toBe(false);
			expect(
				await ctrl.commitCaptureAnswer(
					entryKey,
					{
						fieldUuid: fields.photo.uuid,
						kind: "image",
						repeatInstances: [
							{ fieldUuid: fields.visits.uuid, instanceKey: survivingKey },
						],
					},
					"surviving.png",
					{ signal: new AbortController().signal, isCurrent: () => true },
					(path) => accepted.push(path),
				),
			).toBe(true);
			expect(accepted).toEqual(["/data/visit/visits[0]/photo"]);
			expect(ctrl.store.getState()["/data/visit/visits[0]/photo"].value).toBe(
				"surviving.png",
			);
		} finally {
			await cleanup(subject);
		}
	});

	it("keeps the published presentation and rejects stale events until the replacement is ready", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields } = subject;
		let unsubscribe = () => {};
		try {
			await seed(subject);
			const previous = ctrl.store.getState();
			const entryKey = ctrl.entryKey;
			const pages = ctrl.sectionPages();
			const keys = [0, 1].map((index) =>
				ctrl.getRepeatInstanceKey(fields.visits.uuid, index),
			);
			const publications: (typeof previous)[] = [];
			unsubscribe = ctrl.store.subscribe((state) => {
				publications.push(state);
				expect(ctrl.sectionPages()).toEqual(pages);
				expect(
					[0, 1].map((index) =>
						ctrl.getRepeatInstanceKey(fields.visits.uuid, index),
					),
				).toEqual(keys);
			});
			const request = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await request).toBeDefined();
			expect(ctrl.store.getState()).toBe(previous);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: false,
				rebuilding: true,
				settling: true,
			});
			expect(ctrl.getPath(fields.name.uuid)).toBe("/data/visit/name");
			expect(ctrl.sectionPages()).toEqual(pages);
			expect(ctrl.getRepeatCount(fields.visits.uuid)).toBe(2);
			expect(
				[0, 1].map((index) =>
					ctrl.getRepeatInstanceKey(fields.visits.uuid, index),
				),
			).toEqual(keys);
			expect(await ctrl.setValueAtAsync("/data/visit/name", "Stale")).toBe(
				false,
			);
			expect(await ctrl.touchAtAsync("/data/visit/name")).toBe(false);
			expect(
				await ctrl.addRepeatAsync(fields.visits.uuid, "/data/visit/visits"),
			).toBe(0);
			expect(
				await ctrl.removeRepeatAsync(
					fields.visits.uuid,
					1,
					"/data/visit/visits",
				),
			).toBe(false);
			expect(await ctrl.enterSectionAsync(fields.visit.uuid)).toBe(false);
			expect(await ctrl.validateAllAsync()).toBe(false);
			expect(await ctrl.validateSectionAsync(fields.visit.uuid)).toBe(false);
			expect(await ctrl.resetAsync()).toBe(false);
			ctrl.resetValidation();
			expect(() => ctrl.computeSubmissionMutation({})).toThrow(
				"Preview is preparing this form.",
			);
			expect(publications).toHaveLength(0);
			barrier.release();
			expect(await ctrl.awaitSettled(entryKey)).toBe(true);
			expect(publications).toHaveLength(1);
			expect(ctrl.store.getState()[fields.greeting.uuid]?.resolvedLabel).toBe(
				"Hola Amina",
			);
			expect(ctrl.store.getState()[fields.name.uuid]?.value).toBe("Amina");
			expect(ctrl.store.getState()[fields.point.uuid]?.value).toBe(
				"40 -74 0 0",
			);
			expect(ctrl.store.getState()[fields.when.uuid]?.value).toBe(
				previous[fields.when.uuid]?.value,
			);
			expect(ctrl.store.getState()["/data/visit/visits[1]/note"]?.value).toBe(
				"Second visit",
			);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: true,
				rebuilding: false,
				settling: false,
			});
		} finally {
			unsubscribe();
			await cleanup(subject);
		}
	});

	it("keeps settled answers through queued language changes and identity recovery", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields } = subject;
		let unsubscribe = () => {};
		try {
			await seed(subject);
			const previous = ctrl.store.getState();
			const entryKey = ctrl.entryKey;
			const repeatKeys = [0, 1].map((index) =>
				ctrl.getRepeatInstanceKey(fields.visits.uuid, index),
			);
			const publications: (typeof previous)[] = [];
			unsubscribe = ctrl.store.subscribe((state) => {
				publications.push(state);
				expect(state[fields.name.uuid]?.value).toBe("Amina");
				expect(state[fields.point.uuid]?.value).toBe("40 -74 0 0");
				expect(state["/data/visit/visits[1]/note"]?.value).toBe("Second visit");
				expect(ctrl.entryKey).toBe(entryKey);
				expect(
					[0, 1].map((index) =>
						ctrl.getRepeatInstanceKey(fields.visits.uuid, index),
					),
				).toEqual(repeatKeys);
			});
			const request = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await request).toBeDefined();
			ctrl.setPresentationLanguage("eng");
			ctrl.setPreviewIdentity(
				previewAsMe({ id: "worker-2", email: "second@example.org" }),
			);
			expect(ctrl.store.getState()).toBe(previous);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: false,
				rebuilding: true,
			});
			barrier.release();
			expect(await ctrl.awaitSettled(entryKey)).toBe(true);
			expect(publications.length).toBeGreaterThan(0);
			expect(ctrl.store.getState()[fields.greeting.uuid]?.resolvedLabel).toBe(
				"Hello Amina",
			);
			expect(ctrl.store.getState()[fields.worker.uuid]?.value).toBe(
				"second@example.org",
			);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: true,
				rebuilding: false,
				fault: undefined,
			});
		} finally {
			unsubscribe();
			await cleanup(subject);
		}
	});

	it("an overlapping same-entry mount retains the original settled checkpoint and fences the retired initializer", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields, form } = subject;
		let unsubscribe = () => {};
		try {
			await seed(subject);
			const entryKey = ctrl.entryKey;
			const previous = ctrl.store.getState();
			const repeatKeys = [0, 1].map((index) =>
				ctrl.getRepeatInstanceKey(fields.visits.uuid, index),
			);
			const publications: (typeof previous)[] = [];
			unsubscribe = ctrl.store.subscribe((state) => {
				publications.push(state);
				expect(state[fields.name.uuid]?.value).toBe("Amina");
				expect(state[fields.point.uuid]?.value).toBe("40 -74 0 0");
				expect(state[fields.when.uuid]?.value).toBe(
					previous[fields.when.uuid]?.value,
				);
				expect(state["/data/visit/visits[1]/note"]?.value).toBe("Second visit");
				expect(
					[0, 1].map((index) =>
						ctrl.getRepeatInstanceKey(fields.visits.uuid, index),
					),
				).toEqual(repeatKeys);
			});
			const request = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await request).toBeDefined();
			expect(ctrl.store.getState()).toBe(previous);
			ctrl.rebuildActiveForm(form, undefined, true);
			expect(ctrl.entryKey).toBe(entryKey);
			expect(ctrl.store.getState()[fields.greeting.uuid]?.resolvedLabel).toBe(
				"Hola Amina",
			);
			const replacement = ctrl.store.getState();
			barrier.release();
			expect(await ctrl.awaitSettled(entryKey)).toBe(true);
			expect(ctrl.store.getState()).toBe(replacement);
			expect(publications).toHaveLength(1);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: true,
				rebuilding: false,
				fault: undefined,
			});
		} finally {
			unsubscribe();
			await cleanup(subject);
		}
	});

	it("publishes a document edit during initialization only after its default and path are reconciled", async () => {
		const subject = fixture(true);
		const { ctrl, barrier, fields, store } = subject;
		let unsubscribe = () => {};
		try {
			await seed(subject);
			const previous = ctrl.store.getState();
			const added = testUuid("publication-added-question");
			const publications: (typeof previous)[] = [];
			unsubscribe = ctrl.store.subscribe((state) => {
				publications.push(state);
				expect(state[added]?.value).toBe("new default");
				expect(ctrl.getPath(fields.name.uuid)).toBe(
					"/data/encounter/patient_name",
				);
				expect(ctrl.sectionPages()).toMatchObject([
					{ path: "/data/encounter" },
				]);
			});
			const request = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await request).toBeDefined();
			expect(ctrl.sectionPages()).toMatchObject([{ path: "/data/visit" }]);
			expect(await ctrl.enterSectionAsync(fields.visit.uuid)).toBe(false);
			applyControllerEdit(store, [
				{
					kind: "updateField",
					uuid: fields.visit.uuid,
					targetKind: "section",
					patch: { id: "encounter" },
				},
				{
					kind: "updateField",
					uuid: fields.name.uuid,
					targetKind: "text",
					patch: { id: "patient_name" },
				},
				{
					kind: "addField",
					parentUuid: fields.visit.uuid,
					field: {
						uuid: added,
						id: "added",
						kind: "text",
						label: proseText("Added"),
						default_value: xp("'new default'"),
					},
				},
			]);
			expect(ctrl.store.getState()).toBe(previous);
			expect(ctrl.getPath(fields.name.uuid)).toBe("/data/visit/name");
			barrier.release();
			expect(await ctrl.awaitSettled()).toBe(true);
			expect(publications).toHaveLength(1);
			expect(ctrl.store.getState()[fields.name.uuid]?.value).toBe("Amina");
			expect(ctrl.store.getState()[fields.greeting.uuid]?.resolvedLabel).toBe(
				"Hola Amina",
			);
			expect(ctrl.entryStore.getState()).toMatchObject({
				ready: true,
				rebuilding: false,
				fault: undefined,
			});
		} finally {
			unsubscribe();
			await cleanup(subject);
		}
	});

	it.each(["deactivate", "restart"] as const)(
		"%s retires the retained presentation and fences obsolete replacement work",
		async (boundary) => {
			const subject = fixture();
			const { ctrl, barrier, fields } = subject;
			try {
				await seed(subject);
				const oldEntry = ctrl.entryKey;
				const request = barrier.holdNext();
				ctrl.setPresentationLanguage("spa");
				expect(await request).toBeDefined();
				if (boundary === "deactivate") {
					ctrl.deactivate();
					expect(ctrl.store.getState()).toEqual({});
					expect(ctrl.entryStore.getState()).toMatchObject({
						entryKey: undefined,
						ready: false,
						rebuilding: false,
					});
				} else {
					const restarted = ctrl.restartActiveEntryAsync();
					expect(ctrl.store.getState()).toEqual({});
					expect(ctrl.entryStore.getState().rebuilding).toBe(false);
					expect(await restarted).not.toBe(oldEntry);
				}
				barrier.release();
				await ctrl.awaitSettled();
				if (boundary === "deactivate")
					expect(ctrl.store.getState()).toEqual({});
				else {
					expect(ctrl.store.getState()[fields.name.uuid]?.value).toBe("");
					expect(ctrl.getRepeatCount(fields.visits.uuid)).toBe(1);
				}
				expect(ctrl.entryStore.getState().fault).toBeUndefined();
			} finally {
				await cleanup(subject);
			}
		},
	);

	it("contains a failed replacement and clears its retained answers and render identity", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields } = subject;
		try {
			await seed(subject);
			const request = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await request).toBeDefined();
			barrier.fail();
			expect(await ctrl.awaitSettled()).toBe(false);
			expect(ctrl.store.getState()).toEqual({});
			expect(ctrl.getPath(fields.name.uuid)).toBeUndefined();
			expect(ctrl.sectionPages()).toEqual([]);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey: undefined,
				ready: false,
				rebuilding: false,
				fault: { operation: "activate", failureKind: "xpath:worker-failed" },
			});
		} finally {
			await cleanup(subject);
		}
	});

	it("a different form clears the old presentation and cannot be overwritten by its obsolete initializer", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields, otherForm, otherField } = subject;
		try {
			await seed(subject);
			const oldEntry = ctrl.entryKey;
			const request = barrier.holdNext();
			ctrl.setPresentationLanguage("spa");
			expect(await request).toBeDefined();
			const activation = ctrl.activateFormAsync(otherForm);
			expect(ctrl.store.getState()).toEqual({});
			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: otherForm,
				ready: false,
				rebuilding: false,
			});
			expect(await activation).toBe(true);
			const newEntry = ctrl.entryKey;
			expect(newEntry).not.toBe(oldEntry);
			barrier.release();
			expect(await ctrl.awaitSettled(newEntry)).toBe(true);
			expect(ctrl.store.getState()[fields.name.uuid]).toBeUndefined();
			expect(ctrl.store.getState()[otherField]?.value).toBe("New entry");
			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: otherForm,
				entryKey: newEntry,
				ready: true,
				rebuilding: false,
				fault: undefined,
			});
		} finally {
			await cleanup(subject);
		}
	});

	it("an explicit reset publishes empty loading state rather than retaining the answered presentation", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields } = subject;
		try {
			await seed(subject);
			const entryKey = ctrl.entryKey;
			const request = barrier.holdNext();
			const resetting = ctrl.resetAsync();
			expect(await request).toBeDefined();
			expect(ctrl.store.getState()).toEqual({});
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: false,
				rebuilding: false,
			});
			barrier.release();
			expect(await resetting).toBe(true);
			expect(ctrl.store.getState()[fields.name.uuid]?.value).toBe("");
			expect(ctrl.getRepeatCount(fields.visits.uuid)).toBe(1);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: true,
				rebuilding: false,
			});
		} finally {
			await cleanup(subject);
		}
	});

	it("publishes legitimately changed untouched defaults after the same-entry context arrives", async () => {
		const subject = fixture();
		const { ctrl, barrier, fields } = subject;
		try {
			await seed(subject);
			const entryKey = ctrl.entryKey;
			const previous = ctrl.store.getState();
			const request = barrier.holdNext();
			ctrl.setPreviewIdentity(
				previewAsMe({ id: "worker-1", email: "inspector@example.org" }),
			);
			expect(await request).toBeDefined();
			expect(ctrl.store.getState()).toBe(previous);
			barrier.release();
			expect(await ctrl.awaitSettled(entryKey)).toBe(true);
			expect(ctrl.store.getState()[fields.worker.uuid]?.value).toBe(
				"inspector@example.org",
			);
			expect(ctrl.store.getState()[fields.name.uuid]?.value).toBe("Amina");
			expect(ctrl.store.getState()[fields.point.uuid]?.value).toBe(
				"40 -74 0 0",
			);
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey,
				ready: true,
				rebuilding: false,
			});
		} finally {
			await cleanup(subject);
		}
	});
});
