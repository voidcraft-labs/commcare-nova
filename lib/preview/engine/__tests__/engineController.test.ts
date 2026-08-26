/**
 * EngineController tests — verifies the controller correctly subscribes
 * to the BlueprintDoc store for per-field reactivity, structural changes,
 * and form activation.
 *
 * Fixtures are built directly in the normalized `PersistableDoc` shape.
 * The doc store's `load()` accepts this shape and rebuilds `fieldParent`
 * on load.
 */

import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	type CaseType,
	collectTranslationUnits,
	type Field,
	makeTranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";
import { DEFAULT_RUNTIME_STATE, EngineController } from "../engineController";
import { FormEngine } from "../formEngine";
import { previewAsMe, type ResolvedPreviewIdentity } from "../identity";

// ── Fixtures ───────────────────────────────────────────────────────────

const MODULE_UUID = testUuid("module-1-uuid");
const FORM_UUID = testUuid("form-1-uuid");
const Q1_UUID = testUuid("aaaaaaaa-0001-0001-0001-000000000001");
const Q2_UUID = testUuid("aaaaaaaa-0002-0002-0002-000000000002");

/** Build a minimal survey doc with the given fields attached to a single form. */
function makeDoc(
	fields: Record<string, Field> = {
		[Q1_UUID]: {
			uuid: Q1_UUID,
			id: "name",
			kind: "text",
			label: proseText("Name"),
		},
		[Q2_UUID]: {
			uuid: Q2_UUID,
			id: "age",
			kind: "int",
			label: proseText("Age"),
		},
	},
	fieldOrder: Record<string, Uuid[]> = {
		[FORM_UUID]: [Q1_UUID, Q2_UUID],
	},
): PersistableDoc {
	return {
		appId: "test-app",
		appName: "Test App",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "module-1",
				name: "Module 1",
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "form-1",
				name: "Form 1",
				type: "survey",
			},
		},
		fields,
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder,
	};
}

/** Create a doc store loaded with the given doc. Undo tracking is resumed
 *  so mutations create live state changes. */
function createLoadedStore(doc: PersistableDoc = makeDoc()) {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.getState().startTracking();
	return store;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("EngineController", () => {
	describe("activateForm", () => {
		it("waits for a required case database and resumes the requested form", () => {
			const ctrl = new EngineController();
			ctrl.setDocStore(createLoadedStore());
			ctrl.setCaseDatabaseState({ required: true, status: "loading" });

			ctrl.activateForm(FORM_UUID);
			expect(ctrl.formUuid).toBeUndefined();
			expect(ctrl.entryKey).toBeUndefined();
			expect(ctrl.entryStore.getState().caseDatabaseWait).toEqual({
				formUuid: FORM_UUID,
				status: "loading",
			});
			expect(ctrl.validateAll()).toBe(false);
			const ready = {
				required: true as const,
				status: "ready" as const,
				snapshot: { rows: [], indices: [] },
			};
			ctrl.setCaseDatabaseState(ready);

			expect(ctrl.formUuid).toBe(FORM_UUID);
			expect(ctrl.entryKey).toBeDefined();
			expect(ctrl.entryStore.getState().caseDatabaseWait).toBeUndefined();
		});

		it("contains an impossible runtime activation fault and can open a valid form afterward", () => {
			const invalidStore = createLoadedStore(
				makeDoc(
					{
						[Q1_UUID]: {
							uuid: Q1_UUID,
							id: "name",
							kind: "text",
							label: proseText("Name"),
							default_value: xp("definitely-not-a-function()"),
						},
					},
					{ [FORM_UUID]: [Q1_UUID] },
				),
			);
			const ctrl = new EngineController();
			const report = vi.fn();
			ctrl.setFaultReporter(report);
			ctrl.setDocStore(invalidStore);

			expect(() => ctrl.activateForm(FORM_UUID)).not.toThrow();
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey: undefined,
				formUuid: undefined,
				fault: { formUuid: FORM_UUID, operation: "activate" },
			});
			expect(ctrl.store.getState()).toEqual({});
			expect(report).toHaveBeenCalledTimes(1);

			ctrl.setDocStore(createLoadedStore());
			ctrl.activateForm(FORM_UUID);
			expect(ctrl.entryStore.getState().fault).toBeUndefined();
			expect(ctrl.formUuid).toBe(FORM_UUID);
			expect(Object.keys(ctrl.store.getState())).toHaveLength(2);
		});

		it("retires the active engine when live evaluation violates an invariant", () => {
			const ctrl = new EngineController();
			const report = vi.fn();
			ctrl.setFaultReporter(report);
			ctrl.setDocStore(createLoadedStore());
			ctrl.activateForm(FORM_UUID);
			const setValue = vi
				.spyOn(FormEngine.prototype, "setValue")
				.mockImplementationOnce(() => {
					throw new Error("private answer must not reach UI state");
				});

			expect(() => ctrl.onValueChange(Q1_UUID, "secret")).not.toThrow();
			expect(ctrl.entryStore.getState()).toMatchObject({
				entryKey: undefined,
				formUuid: undefined,
				fault: { formUuid: FORM_UUID, operation: "value-change" },
			});
			expect(ctrl.validateAll()).toBe(false);
			expect(() => ctrl.computeSubmissionMutation({})).toThrow(
				"Preview could not run this form.",
			);
			expect(report).toHaveBeenCalledTimes(1);
			setValue.mockRestore();
		});

		it("keeps a failing telemetry seam inside the containment boundary", () => {
			const ctrl = new EngineController();
			ctrl.setFaultReporter(() => {
				throw new Error("telemetry unavailable");
			});
			ctrl.setDocStore(
				createLoadedStore(
					makeDoc(
						{
							[Q1_UUID]: {
								uuid: Q1_UUID,
								id: "name",
								kind: "text",
								label: proseText("Name"),
								default_value: xp("definitely-not-a-function()"),
							},
						},
						{ [FORM_UUID]: [Q1_UUID] },
					),
				),
			);

			expect(() => ctrl.activateForm(FORM_UUID)).not.toThrow();
			expect(ctrl.entryStore.getState().fault).toEqual({
				formUuid: FORM_UUID,
				operation: "activate",
			});
		});

		it("initializes runtime state for every field in the form", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(FORM_UUID);

			/* Runtime store should have entries for both fields */
			const runtime = ctrl.store.getState();
			expect(runtime[Q1_UUID]).toBeDefined();
			expect(runtime[Q2_UUID]).toBeDefined();
			expect(runtime[Q1_UUID].visible).toBe(true);
			expect(runtime[Q2_UUID].visible).toBe(true);
		});

		it("preserves one entry key across cold rebuilds and rotates it only for a new entry", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			const entryKey = ctrl.entryKey;

			ctrl.rebuildActiveForm(FORM_UUID, new Map());
			expect(ctrl.entryKey).toBe(entryKey);

			ctrl.setPreviewIdentity(
				previewAsMe({ id: "worker-1", email: "amina@example.org" }),
			);
			expect(ctrl.entryKey).toBe(entryKey);

			ctrl.activateForm(FORM_UUID);
			expect(ctrl.entryKey).toEqual(expect.any(String));
			expect(ctrl.entryKey).not.toBe(entryKey);
		});

		it("evaluates localized dynamic prose and preserves the live entry across language changes", () => {
			const referencedLabel = {
				parts: [
					{ kind: "text" as const, text: "Hello " },
					{ kind: "field-ref" as const, uuid: Q1_UUID },
				],
			};
			const translatedLabel = {
				parts: [
					{ kind: "text" as const, text: "Hola " },
					{ kind: "field-ref" as const, uuid: Q1_UUID },
				],
			};
			const doc = makeDoc({
				[Q1_UUID]: {
					uuid: Q1_UUID,
					id: "name",
					kind: "text",
					label: proseText("Name"),
				},
				[Q2_UUID]: {
					uuid: Q2_UUID,
					id: "greeting",
					kind: "text",
					label: referencedLabel,
				},
			});
			const store = createLoadedStore(doc);
			const unitId = makeTranslationUnitId("field", Q2_UUID, "label");
			const unit = collectTranslationUnits(store.getState()).find(
				(candidate) => candidate.id === unitId,
			);
			expect(unit).toBeDefined();
			if (unit === undefined) return;
			store.getState().applyMany([
				{
					kind: "addLanguage",
					language: { language: "spa" },
				},
				{
					kind: "setTranslation",
					language: "spa",
					unitId,
					entry: {
						value: translatedLabel,
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			]);

			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.setValueAt("/data/name", "Amina");
			const entryKey = ctrl.entryKey;
			expect(ctrl.store.getState()[Q2_UUID].resolvedLabel).toBe("Hello Amina");

			ctrl.setPresentationLanguage("spa");
			expect(ctrl.entryKey).toBe(entryKey);
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("Amina");
			expect(ctrl.store.getState()[Q2_UUID].resolvedLabel).toBe("Hola Amina");

			store.getState().applyMany([
				{
					kind: "setTranslation",
					language: "spa",
					unitId,
					entry: {
						value: {
							parts: [
								{ kind: "text", text: "Paciente: " },
								{ kind: "field-ref", uuid: Q1_UUID },
							],
						},
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			]);
			expect(ctrl.entryKey).toBe(entryKey);
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("Amina");
			expect(ctrl.store.getState()[Q2_UUID].resolvedLabel).toBe(
				"Paciente: Amina",
			);

			const remote = prepareMutationCandidate(
				store.getState(),
				admitMutationBatch([{ kind: "removeLanguage", code: "spa" }]),
			);
			store.getState().beginRemoteApply();
			try {
				store.getState().commitDoc(remote.nextDoc, remote.mutations);
			} finally {
				store.getState().endRemoteApply();
			}
			expect(ctrl.entryKey).toBe(entryKey);
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("Amina");
			expect(ctrl.store.getState()[Q2_UUID].resolvedLabel).toBe("Hello Amina");
		});

		it("starts a fresh entry immediately without changing the active form", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.setValueAt("/data/name", "Old answer");
			const previousEntryKey = ctrl.entryKey;

			const nextEntryKey = ctrl.restartActiveEntry();

			expect(nextEntryKey).toEqual(expect.any(String));
			expect(nextEntryKey).not.toBe(previousEntryKey);
			expect(ctrl.entryKey).toBe(nextEntryKey);
			expect(ctrl.formUuid).toBe(FORM_UUID);
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("");
		});

		it("classifies capture blockers through hide, re-show, and field deletion", async () => {
			const captureUuid = testUuid("aaaaaaaa-0020-0020-0020-000000000020");
			const store = createLoadedStore(
				makeDoc(
					{
						[captureUuid]: {
							uuid: captureUuid,
							id: "signature",
							kind: "signature",
							label: proseText("Signature"),
							relevant: xp("false()"),
						},
					},
					{ [FORM_UUID]: [captureUuid] },
				),
			);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			expect(ctrl.attachmentPathDisposition("/data/signature")).toBe("dormant");

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: captureUuid,
					targetKind: "signature",
					patch: { relevant: xp("true()") },
				},
			]);
			await vi.waitFor(() =>
				expect(ctrl.attachmentPathDisposition("/data/signature")).toBe(
					"active",
				),
			);

			store.getState().applyMany([{ kind: "removeField", uuid: captureUuid }]);
			await vi.waitFor(() =>
				expect(ctrl.attachmentPathDisposition("/data/signature")).toBe(
					"removed",
				),
			);
		});

		it("retires a capture path when its repeat instance is removed", () => {
			const repeatUuid = testUuid("aaaaaaaa-0030-0030-0030-000000000030");
			const captureUuid = testUuid("aaaaaaaa-0031-0031-0031-000000000031");
			const store = createLoadedStore(
				makeDoc(
					{
						[repeatUuid]: {
							uuid: repeatUuid,
							id: "visits",
							kind: "repeat",
							label: proseText("Visits"),
							repeat_mode: "user_controlled",
						},
						[captureUuid]: {
							uuid: captureUuid,
							id: "photo",
							kind: "image",
							label: proseText("Photo"),
						},
					},
					{
						[FORM_UUID]: [repeatUuid],
						[repeatUuid]: [captureUuid],
					},
				),
			);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);

			expect(ctrl.attachmentPathDisposition("/data/visits[1]/photo")).toBe(
				"active",
			);

			ctrl.removeRepeat(repeatUuid, 1);

			expect(ctrl.attachmentPathDisposition("/data/visits[1]/photo")).toBe(
				"removed",
			);
		});

		it("preserves repeat render identities across a same-entry rebuild", () => {
			const repeatUuid = testUuid("aaaaaaaa-0010-0010-0010-000000000010");
			const childUuid = testUuid("aaaaaaaa-0011-0011-0011-000000000011");
			const store = createLoadedStore(
				makeDoc(
					{
						[repeatUuid]: {
							uuid: repeatUuid,
							id: "members",
							kind: "repeat",
							label: proseText("Members"),
							repeat_mode: "user_controlled",
						},
						[childUuid]: {
							uuid: childUuid,
							id: "name",
							kind: "text",
							label: proseText("Name"),
						},
					},
					{
						[FORM_UUID]: [repeatUuid],
						[repeatUuid]: [childUuid],
					},
				),
			);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			const keys = [
				ctrl.getRepeatInstanceKey(repeatUuid, 0),
				ctrl.getRepeatInstanceKey(repeatUuid, 1),
			];

			ctrl.rebuildActiveForm(FORM_UUID, new Map());

			expect([
				ctrl.getRepeatInstanceKey(repeatUuid, 0),
				ctrl.getRepeatInstanceKey(repeatUuid, 1),
			]).toEqual(keys);
		});

		it("returns early for an unknown form uuid", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(testUuid("does-not-exist"));

			/* Runtime store should be empty — no form was activated */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});

		it("refuses to load a form that is not referenced by any module", () => {
			/* Closed topology prevents an orphan form from becoming preview
			 * state at all. The controller's unknown-form guard still covers
			 * a stale route, while hydration rejects a structurally detached
			 * entity before the engine can observe it. */
			const orphanDoc = makeDoc();
			orphanDoc.formOrder = { [MODULE_UUID]: [] };
			const store = createBlueprintDocStore();
			expect(() => store.getState().load(orphanDoc)).toThrow(
				/invalid blueprint topology/,
			);
		});

		it("returns early when no doc store is installed", () => {
			const ctrl = new EngineController();
			ctrl.activateForm(FORM_UUID);
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});
	});

	describe("per-field subscription", () => {
		it("fires on field relevant update via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Mutate the field's relevant expression to hide it */
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: Q1_UUID,
					targetKind: "text",
					patch: { relevant: xp("false()") },
				},
			]);

			/* Zustand's subscribeWithSelector fires synchronously on the
			 * next microtask — flush with a short wait. */
			await new Promise((r) => setTimeout(r, 10));

			const state = ctrl.store.getState()[Q1_UUID];
			expect(state).toBeDefined();
			/* The field should now be hidden because relevant = "false()" */
			expect(state.visible).toBe(false);
		});
	});

	describe("structural subscription", () => {
		it("detects field addition via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Initial state should have 2 fields */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(2);

			const newUuid = testUuid("bbbbbbbb-0003-0003-0003-000000000003");
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						uuid: newUuid,
						id: "new_q",
						kind: "text",
						label: proseText("New Field"),
					},
				},
			]);

			await new Promise((r) => setTimeout(r, 10));

			/* The new field should appear in the runtime store */
			const runtime = ctrl.store.getState();
			expect(runtime[newUuid]).toBeDefined();
			expect(runtime[newUuid].visible).toBe(true);
		});

		it("detects field removal via doc mutation", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Remove the first field */
			store.getState().applyMany([
				{
					kind: "removeField",
					uuid: Q1_UUID,
				},
			]);

			await new Promise((r) => setTimeout(r, 10));

			/* The removed field should revert to the frozen default state */
			const runtime = ctrl.store.getState();
			expect(runtime[Q1_UUID]).toBe(DEFAULT_RUNTIME_STATE);
		});
	});

	describe("kind change (remote retype)", () => {
		it("re-initializes the value on a same-id retype — no stale value resurfaces", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* A user (or a peer) typed into the text field before the retype. */
			ctrl.onValueChange(Q1_UUID, "typed answer");
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("typed answer");

			/* A remote `convertField` retypes the field (uuid + id preserved).
			 * The stale text value is meaningless under the new kind. */
			store
				.getState()
				.applyMany([{ kind: "convertField", uuid: Q1_UUID, toKind: "secret" }]);

			await new Promise((r) => setTimeout(r, 10));

			/* The value is dropped and the field re-seeds empty — a same-id
			 * retype must not leave the old answer in place. */
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("");
		});

		it("re-applies the new field's default value on retype", async () => {
			const groupUuid = testUuid("dddddddd-0001-0001-0001-000000000001");
			const doc = makeDoc(
				{
					[groupUuid]: {
						uuid: groupUuid,
						id: "container",
						kind: "group",
						label: proseText("Container"),
					},
				},
				{ [FORM_UUID]: [groupUuid], [groupUuid]: [] },
			);
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* group → repeat is a valid convert target; the retype must not throw
			 * and the container's state re-inits at the new kind. */
			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: groupUuid, toKind: "repeat" },
				]);

			await new Promise((r) => setTimeout(r, 10));

			/* A repeat carries a `repeatCount` — its presence proves the field
			 * was re-seeded under the new kind rather than left as a group. */
			expect(ctrl.store.getState()[groupUuid].repeatCount).toBe(1);
		});

		it("preserves answered child values across a group→repeat conversion (re-path, not drop)", async () => {
			const groupUuid = testUuid("dddddddd-0002-0002-0002-000000000001");
			const childAUuid = testUuid("dddddddd-0002-0002-0002-000000000002");
			const childBUuid = testUuid("dddddddd-0002-0002-0002-000000000003");
			const doc = makeDoc(
				{
					[groupUuid]: {
						uuid: groupUuid,
						id: "container",
						kind: "group",
						label: proseText("Container"),
					},
					[childAUuid]: {
						uuid: childAUuid,
						id: "child_a",
						kind: "text",
						label: proseText("Child A"),
					},
					[childBUuid]: {
						uuid: childBUuid,
						id: "child_b",
						kind: "text",
						label: proseText("Child B"),
					},
				},
				{
					[FORM_UUID]: [groupUuid],
					[groupUuid]: [childAUuid, childBUuid],
				},
			);
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Both children answered while the container is still a group
			 * (child paths `/data/container/child_*`). */
			ctrl.onValueChange(childAUuid, "answer A");
			ctrl.onValueChange(childBUuid, "answer B");
			expect(ctrl.getPath(childAUuid)).toBe("/data/container/child_a");

			/* A peer converts the group to a repeat — the child paths gain the
			 * `[0]` template segment. The in-progress answers must survive. */
			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: groupUuid, toKind: "repeat" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			/* Children re-pathed to the reindexed repeat template, values intact. */
			expect(ctrl.getPath(childAUuid)).toBe("/data/container[0]/child_a");
			expect(ctrl.store.getState()[childAUuid].value).toBe("answer A");
			expect(ctrl.store.getState()[childBUuid].value).toBe("answer B");
		});

		it("preserves answered child values across a repeat→group conversion", async () => {
			const repeatUuid = testUuid("dddddddd-0003-0003-0003-000000000001");
			const childUuid = testUuid("dddddddd-0003-0003-0003-000000000002");
			const doc = makeDoc(
				{
					[repeatUuid]: {
						uuid: repeatUuid,
						id: "container",
						kind: "repeat",
						label: proseText("Container"),
						repeat_mode: "user_controlled",
					},
					[childUuid]: {
						uuid: childUuid,
						id: "child",
						kind: "text",
						label: proseText("Child"),
					},
				},
				{
					[FORM_UUID]: [repeatUuid],
					[repeatUuid]: [childUuid],
				},
			);
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Child answered while the container is a repeat (template `[0]`). */
			ctrl.onValueChange(childUuid, "answer");
			expect(ctrl.getPath(childUuid)).toBe("/data/container[0]/child");

			/* Convert the repeat back to a group — the `[0]` segment drops. */
			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: repeatUuid, toKind: "group" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.getPath(childUuid)).toBe("/data/container/child");
			expect(ctrl.store.getState()[childUuid].value).toBe("answer");
		});

		it("a converted group→repeat's child value reaches computeSubmissionMutation at the reindexed path", async () => {
			/* A registration form whose primary case type is `patient`. The group
			 * holds an admitted direct-child bucket; after group→repeat its values
			 * must survive the re-path so submission materializes that same bucket
			 * from `/data/container[0]/...`. */
			const patientCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
				],
			};
			const noteCaseType: CaseType = {
				name: "note_entry",
				parent_type: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "note", label: proseText("Note"), data_type: "text" },
				],
			};
			const moduleUuid = testUuid("eeeeeeee-0001-0001-0001-000000000001");
			const formUuid = testUuid("eeeeeeee-0002-0002-0002-000000000001");
			const nameUuid = testUuid("eeeeeeee-0003-0003-0003-000000000001");
			const groupUuid = testUuid("eeeeeeee-0004-0004-0004-000000000001");
			const childNameUuid = testUuid("eeeeeeee-0004-0004-0004-000000000002");
			const noteUuid = testUuid("eeeeeeee-0005-0005-0005-000000000001");
			const doc: PersistableDoc = {
				appId: "test-app",
				appName: "Test App",
				connectType: null,
				caseTypes: [patientCaseType, noteCaseType],
				modules: {
					[moduleUuid]: {
						uuid: moduleUuid,
						id: "patients",
						name: "Patients",
						caseType: "patient",
					},
				},
				forms: {
					[formUuid]: {
						uuid: formUuid,
						id: "register",
						name: "Register",
						type: "registration",
					},
				},
				fields: {
					[nameUuid]: {
						uuid: nameUuid,
						id: "case_name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					[groupUuid]: {
						uuid: groupUuid,
						id: "container",
						kind: "group",
						label: proseText("Container"),
					},
					[childNameUuid]: {
						uuid: childNameUuid,
						id: "entry_name",
						kind: "hidden",
						calculate: xp("'Note entry'"),
						caseWrite: {
							caseType: "note_entry",
							property: "case_name",
						},
					},
					[noteUuid]: {
						uuid: noteUuid,
						id: "note",
						kind: "text",
						label: proseText("Note"),
						caseWrite: { caseType: "note_entry", property: "note" },
					},
				},
				moduleOrder: [moduleUuid],
				formOrder: { [moduleUuid]: [formUuid] },
				fieldOrder: {
					[formUuid]: [nameUuid, groupUuid],
					[groupUuid]: [childNameUuid, noteUuid],
				},
			};
			const store = createBlueprintDocStore();
			store.getState().load(doc);
			store.getState().startTracking();

			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(formUuid);

			ctrl.onValueChange(nameUuid, "Alice");
			ctrl.onValueChange(noteUuid, "in-progress note");

			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: groupUuid, toKind: "repeat" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			/* The child value survived the re-path and lands in the canonical
			 * direct-child bucket for this concrete repeat instance. */
			const mutation = ctrl.computeSubmissionMutation({});
			expect(mutation.kind).toBe("registration");
			if (mutation.kind === "registration") {
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.children).toEqual([
					{
						caseType: "note_entry",
						caseName: "Note entry",
						properties: { note: "in-progress note" },
					},
				]);
			}
		});
	});

	describe("field removal drops the value", () => {
		it("clears the value on remote delete, and a re-add seeds empty", async () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Someone typed an answer, then the field is removed remotely. */
			ctrl.onValueChange(Q1_UUID, "answer before delete");
			store.getState().applyMany([{ kind: "removeField", uuid: Q1_UUID }]);
			await new Promise((r) => setTimeout(r, 10));
			expect(ctrl.store.getState()[Q1_UUID]).toBe(DEFAULT_RUNTIME_STATE);

			/* Re-adding a field at the SAME id/path must start empty — the delete
			 * dropped the DataInstance value, so `addFieldState` seeds `""`
			 * rather than resurrecting the pre-delete answer. */
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						uuid: Q1_UUID,
						id: "name",
						kind: "text",
						label: proseText("Name"),
					},
				},
			]);
			await new Promise((r) => setTimeout(r, 10));
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("");
		});
	});

	describe("deactivate", () => {
		it("clears runtime store and subscriptions", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			/* Verify we have state */
			expect(Object.keys(ctrl.store.getState()).length).toBeGreaterThan(0);

			ctrl.deactivate();

			/* Runtime store should be empty after deactivation */
			expect(Object.keys(ctrl.store.getState())).toHaveLength(0);
		});
	});

	describe("public actions", () => {
		it("onValueChange updates runtime state for a field", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.onValueChange(Q1_UUID, "Alice");
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("Alice");
		});

		it("getPath returns the XForm path for a UUID", () => {
			const store = createLoadedStore();
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			expect(ctrl.getPath(Q1_UUID)).toBe("/data/name");
			expect(ctrl.getPath(Q2_UUID)).toBe("/data/age");
		});
	});

	describe("repeat-instance runtime state", () => {
		const repeatUuid = testUuid("eeeeeeee-0001-0001-0001-000000000001");
		const nameUuid = testUuid("eeeeeeee-0001-0001-0001-000000000002");

		function repeatDoc(): PersistableDoc {
			return makeDoc(
				{
					[repeatUuid]: {
						uuid: repeatUuid,
						id: "orders",
						kind: "repeat",
						label: proseText("Orders"),
						repeat_mode: "user_controlled",
					},
					[nameUuid]: {
						uuid: nameUuid,
						id: "name",
						kind: "text",
						label: proseText("Name"),
					},
				},
				{
					[FORM_UUID]: [repeatUuid],
					[repeatUuid]: [nameUuid],
				},
			);
		}

		function captureContainerDoc(
			containerKind: "group" | "repeat" = "repeat",
		): PersistableDoc {
			const doc = repeatDoc();
			doc.fields[repeatUuid] =
				containerKind === "repeat"
					? doc.fields[repeatUuid]
					: {
							uuid: repeatUuid,
							id: "orders",
							kind: "group",
							label: proseText("Orders"),
						};
			doc.fields[nameUuid] = {
				uuid: nameUuid,
				id: "photo",
				kind: "image",
				label: proseText("Photo"),
			};
			return doc;
		}

		it("activation writes path-keyed entries for repeat children", () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			const runtime = ctrl.store.getState();
			// Template `[0]` children carry BOTH keys: the uuid (edit-mode
			// rows) and the concrete path (interactive instance rows).
			expect(runtime[nameUuid]).toBeDefined();
			expect(runtime["/data/orders[0]/name"]).toBeDefined();
		});

		it("setValueAt keeps instances independent in the runtime store", () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[0]/name", "Hydrangea");
			ctrl.setValueAt("/data/orders[1]/name", "Aspirin");

			const runtime = ctrl.store.getState();
			expect(runtime["/data/orders[0]/name"].value).toBe("Hydrangea");
			expect(runtime["/data/orders[1]/name"].value).toBe("Aspirin");
			// The uuid key tracks the `[0]` template slot.
			expect(runtime[nameUuid].value).toBe("Hydrangea");
		});

		it("addRepeat syncs the new instance's states; removeRepeat unplugs them", () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.addRepeat(repeatUuid);
			const afterAdd = ctrl.store.getState();
			expect(afterAdd[repeatUuid].repeatCount).toBe(2);
			expect(afterAdd["/data/orders[1]/name"]).toBeDefined();
			expect(afterAdd["/data/orders[1]/name"].value).toBe("");

			ctrl.removeRepeat(repeatUuid, 1);
			const afterRemove = ctrl.store.getState();
			expect(afterRemove[repeatUuid].repeatCount).toBe(1);
			// The removed instance's entry is unplugged to the engine's frozen
			// empty default (`path: ""`), so stale subscribers render nothing.
			expect(afterRemove["/data/orders[1]/name"].path).toBe("");
			expect(afterRemove["/data/orders[1]/name"].value).toBe("");
		});

		it("publishes positional repeat compaction from the controller owner", () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			ctrl.addRepeat(repeatUuid);
			const events: Parameters<
				Parameters<typeof ctrl.subscribeRepeatCompaction>[0]
			>[0][] = [];
			const unsubscribe = ctrl.subscribeRepeatCompaction((event) => {
				events.push(event);
			});

			ctrl.removeRepeat(repeatUuid, 0);
			unsubscribe();

			expect(events).toEqual([
				{
					entryKey: ctrl.entryKey,
					removedPrefix: "/data/orders[0]",
					moves: [
						{
							fromPrefix: "/data/orders[1]",
							toPrefix: "/data/orders[0]",
						},
						{
							fromPrefix: "/data/orders[2]",
							toPrefix: "/data/orders[1]",
						},
					],
				},
			]);
		});

		it("publishes capture field and ancestor renames by stable field UUID", async () => {
			const store = createLoadedStore(captureContainerDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			const events: Parameters<
				Parameters<typeof ctrl.subscribeAuthoredCapturePathMigration>[0]
			>[0][] = [];
			ctrl.subscribeAuthoredCapturePathMigration((event) => events.push(event));

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: nameUuid,
					targetKind: "image",
					patch: { id: "evidence" },
				},
			]);
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: repeatUuid,
					targetKind: "repeat",
					patch: { id: "encounters" },
				},
			]);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(events.map((event) => event.moves)).toEqual([
				[
					{
						kind: "retained",
						fieldUuid: nameUuid,
						previous: {
							pathTemplate: "/data/orders[0]/photo",
							segmentKeys: ["$data", repeatUuid, nameUuid],
							captureKind: "image",
						},
						current: {
							pathTemplate: "/data/orders[0]/evidence",
							segmentKeys: ["$data", repeatUuid, nameUuid],
							captureKind: "image",
						},
					},
				],
				[
					{
						kind: "retained",
						fieldUuid: nameUuid,
						previous: {
							pathTemplate: "/data/orders[0]/evidence",
							segmentKeys: ["$data", repeatUuid, nameUuid],
							captureKind: "image",
						},
						current: {
							pathTemplate: "/data/encounters[0]/evidence",
							segmentKeys: ["$data", repeatUuid, nameUuid],
							captureKind: "image",
						},
					},
				],
			]);
		});

		it("publishes field deletion only through the explicit deleted variant", () => {
			const store = createLoadedStore(captureContainerDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			const events: Parameters<
				Parameters<typeof ctrl.subscribeAuthoredCapturePathMigration>[0]
			>[0][] = [];
			ctrl.subscribeAuthoredCapturePathMigration((event) => events.push(event));

			store.getState().applyMany([{ kind: "removeField", uuid: nameUuid }]);

			expect(events).toEqual([
				{
					entryKey: ctrl.entryKey,
					moves: [
						{
							kind: "deleted",
							fieldUuid: nameUuid,
							previous: {
								pathTemplate: "/data/orders[0]/photo",
								segmentKeys: ["$data", repeatUuid, nameUuid],
								captureKind: "image",
							},
						},
					],
				},
			]);
		});

		it("atomically swaps two capture paths once from the complete pre/post maps", () => {
			const firstUuid = testUuid("eeeeeeee-0010-0010-0010-000000000001");
			const secondUuid = testUuid("eeeeeeee-0010-0010-0010-000000000002");
			const store = createLoadedStore(
				makeDoc(
					{
						[firstUuid]: {
							uuid: firstUuid,
							id: "photo",
							kind: "image",
							label: proseText("Photo"),
						},
						[secondUuid]: {
							uuid: secondUuid,
							id: "document",
							kind: "file",
							label: proseText("Document"),
						},
					},
					{ [FORM_UUID]: [firstUuid, secondUuid] },
				),
			);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.setValueAt("/data/photo", "photo.png");
			ctrl.setValueAt("/data/document", "document.pdf");
			const events: Parameters<
				Parameters<typeof ctrl.subscribeAuthoredCapturePathMigration>[0]
			>[0][] = [];
			ctrl.subscribeAuthoredCapturePathMigration((event) => events.push(event));

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: firstUuid,
					targetKind: "image",
					patch: { id: "document" },
				},
				{
					kind: "updateField",
					uuid: secondUuid,
					targetKind: "file",
					patch: { id: "photo" },
				},
			]);

			expect(ctrl.getPath(firstUuid)).toBe("/data/document");
			expect(ctrl.getPath(secondUuid)).toBe("/data/photo");
			expect(ctrl.store.getState()[firstUuid].value).toBe("photo.png");
			expect(ctrl.store.getState()[secondUuid].value).toBe("document.pdf");
			expect(events).toEqual([
				{
					entryKey: ctrl.entryKey,
					moves: [
						{
							kind: "retained",
							fieldUuid: firstUuid,
							previous: {
								pathTemplate: "/data/photo",
								segmentKeys: ["$data", firstUuid],
								captureKind: "image",
							},
							current: {
								pathTemplate: "/data/document",
								segmentKeys: ["$data", firstUuid],
								captureKind: "image",
							},
						},
						{
							kind: "retained",
							fieldUuid: secondUuid,
							previous: {
								pathTemplate: "/data/document",
								segmentKeys: ["$data", secondUuid],
								captureKind: "file",
							},
							current: {
								pathTemplate: "/data/photo",
								segmentKeys: ["$data", secondUuid],
								captureKind: "file",
							},
						},
					],
				},
			]);
		});

		it("preserves a capture moved directly between group and repeat parents", () => {
			const groupUuid = testUuid("eeeeeeee-0011-0011-0011-000000000001");
			const repeatParentUuid = testUuid("eeeeeeee-0011-0011-0011-000000000002");
			const captureUuid = testUuid("eeeeeeee-0011-0011-0011-000000000003");
			const store = createLoadedStore(
				makeDoc(
					{
						[groupUuid]: {
							uuid: groupUuid,
							id: "visit",
							kind: "group",
							label: proseText("Visit"),
						},
						[repeatParentUuid]: {
							uuid: repeatParentUuid,
							id: "rounds",
							kind: "repeat",
							label: proseText("Rounds"),
							repeat_mode: "user_controlled",
						},
						[captureUuid]: {
							uuid: captureUuid,
							id: "photo",
							kind: "image",
							label: proseText("Photo"),
						},
					},
					{
						[FORM_UUID]: [groupUuid, repeatParentUuid],
						[groupUuid]: [captureUuid],
						[repeatParentUuid]: [],
					},
				),
			);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatParentUuid);
			ctrl.setValueAt("/data/visit/photo", "photo.png");
			const moves: Parameters<
				Parameters<typeof ctrl.subscribeAuthoredCapturePathMigration>[0]
			>[0]["moves"][number][] = [];
			ctrl.subscribeAuthoredCapturePathMigration((event) => {
				moves.push(...event.moves);
			});

			store.getState().applyMany([
				{
					kind: "moveField",
					uuid: captureUuid,
					toParentUuid: repeatParentUuid,
					after: null,
				},
			]);
			expect(ctrl.getPath(captureUuid)).toBe("/data/rounds[0]/photo");
			expect(ctrl.store.getState()[captureUuid].value).toBe("photo.png");

			store.getState().applyMany([
				{
					kind: "moveField",
					uuid: captureUuid,
					toParentUuid: groupUuid,
					after: null,
				},
			]);
			expect(ctrl.getPath(captureUuid)).toBe("/data/visit/photo");
			expect(ctrl.store.getState()[captureUuid].value).toBe("photo.png");
			expect(moves).toEqual([
				expect.objectContaining({
					kind: "retained",
					fieldUuid: captureUuid,
					previous: {
						pathTemplate: "/data/visit/photo",
						segmentKeys: ["$data", groupUuid, captureUuid],
						captureKind: "image",
					},
					current: {
						pathTemplate: "/data/rounds[0]/photo",
						segmentKeys: ["$data", repeatParentUuid, captureUuid],
						captureKind: "image",
					},
				}),
				expect.objectContaining({
					kind: "retained",
					fieldUuid: captureUuid,
					previous: {
						pathTemplate: "/data/rounds[0]/photo",
						segmentKeys: ["$data", repeatParentUuid, captureUuid],
						captureKind: "image",
					},
					current: {
						pathTemplate: "/data/visit/photo",
						segmentKeys: ["$data", groupUuid, captureUuid],
						captureKind: "image",
					},
				}),
			]);
		});

		it("preserves capture descendants when their ancestor moves into and out of a repeat", () => {
			const repeatParentUuid = testUuid("eeeeeeee-0012-0012-0012-000000000001");
			const ancestorUuid = testUuid("eeeeeeee-0012-0012-0012-000000000002");
			const captureUuid = testUuid("eeeeeeee-0012-0012-0012-000000000003");
			const store = createLoadedStore(
				makeDoc(
					{
						[repeatParentUuid]: {
							uuid: repeatParentUuid,
							id: "rounds",
							kind: "repeat",
							label: proseText("Rounds"),
							repeat_mode: "user_controlled",
						},
						[ancestorUuid]: {
							uuid: ancestorUuid,
							id: "visit",
							kind: "group",
							label: proseText("Visit"),
						},
						[captureUuid]: {
							uuid: captureUuid,
							id: "photo",
							kind: "image",
							label: proseText("Photo"),
						},
					},
					{
						[FORM_UUID]: [repeatParentUuid, ancestorUuid],
						[repeatParentUuid]: [],
						[ancestorUuid]: [captureUuid],
					},
				),
			);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatParentUuid);
			ctrl.setValueAt("/data/visit/photo", "photo.png");
			const moves: Parameters<
				Parameters<typeof ctrl.subscribeAuthoredCapturePathMigration>[0]
			>[0]["moves"][number][] = [];
			ctrl.subscribeAuthoredCapturePathMigration((event) => {
				moves.push(...event.moves);
			});

			store.getState().applyMany([
				{
					kind: "moveField",
					uuid: ancestorUuid,
					toParentUuid: repeatParentUuid,
					after: null,
				},
			]);
			expect(ctrl.getPath(captureUuid)).toBe("/data/rounds[0]/visit/photo");
			expect(ctrl.store.getState()[captureUuid].value).toBe("photo.png");

			store.getState().applyMany([
				{
					kind: "moveField",
					uuid: ancestorUuid,
					toParentUuid: FORM_UUID,
					after: null,
				},
			]);
			expect(ctrl.getPath(captureUuid)).toBe("/data/visit/photo");
			expect(ctrl.store.getState()[captureUuid].value).toBe("photo.png");
			expect(moves).toEqual([
				expect.objectContaining({
					kind: "retained",
					fieldUuid: captureUuid,
					previous: {
						pathTemplate: "/data/visit/photo",
						segmentKeys: ["$data", ancestorUuid, captureUuid],
						captureKind: "image",
					},
					current: {
						pathTemplate: "/data/rounds[0]/visit/photo",
						segmentKeys: ["$data", repeatParentUuid, ancestorUuid, captureUuid],
						captureKind: "image",
					},
				}),
				expect.objectContaining({
					kind: "retained",
					fieldUuid: captureUuid,
					previous: {
						pathTemplate: "/data/rounds[0]/visit/photo",
						segmentKeys: ["$data", repeatParentUuid, ancestorUuid, captureUuid],
						captureKind: "image",
					},
					current: {
						pathTemplate: "/data/visit/photo",
						segmentKeys: ["$data", ancestorUuid, captureUuid],
						captureKind: "image",
					},
				}),
			]);
		});

		it("publishes capture descendant moves for group↔repeat conversion", async () => {
			const store = createLoadedStore(captureContainerDoc("group"));
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			const moves: Parameters<
				Parameters<typeof ctrl.subscribeAuthoredCapturePathMigration>[0]
			>[0]["moves"][number][] = [];
			ctrl.subscribeAuthoredCapturePathMigration((event) => {
				moves.push(...event.moves);
			});

			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: repeatUuid, toKind: "repeat" },
				]);
			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: repeatUuid, toKind: "group" },
				]);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(moves).toEqual([
				expect.objectContaining({
					kind: "retained",
					previous: expect.objectContaining({
						pathTemplate: "/data/orders/photo",
						segmentKeys: ["$data", repeatUuid, nameUuid],
					}),
					current: expect.objectContaining({
						pathTemplate: "/data/orders[0]/photo",
						segmentKeys: ["$data", repeatUuid, nameUuid],
					}),
				}),
				expect.objectContaining({
					kind: "retained",
					previous: expect.objectContaining({
						pathTemplate: "/data/orders[0]/photo",
						segmentKeys: ["$data", repeatUuid, nameUuid],
					}),
					current: expect.objectContaining({
						pathTemplate: "/data/orders/photo",
						segmentKeys: ["$data", repeatUuid, nameUuid],
					}),
				}),
			]);
		});

		it("publishes incompatible capture-kind conversions at the stable path", async () => {
			const store = createLoadedStore(captureContainerDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			const moves: Parameters<
				Parameters<typeof ctrl.subscribeAuthoredCapturePathMigration>[0]
			>[0]["moves"][number][] = [];
			ctrl.subscribeAuthoredCapturePathMigration((event) => {
				moves.push(...event.moves);
			});

			store
				.getState()
				.applyMany([{ kind: "convertField", uuid: nameUuid, toKind: "audio" }]);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(moves).toEqual([
				{
					kind: "retained",
					fieldUuid: nameUuid,
					previous: {
						pathTemplate: "/data/orders[0]/photo",
						segmentKeys: ["$data", repeatUuid, nameUuid],
						captureKind: "image",
					},
					current: {
						pathTemplate: "/data/orders[0]/photo",
						segmentKeys: ["$data", repeatUuid, nameUuid],
						captureKind: "audio",
					},
				},
			]);
		});

		it("a field added inside a repeat reaches every live instance", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);

			const doseUuid = testUuid("eeeeeeee-0002-0002-0002-000000000001");
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: repeatUuid,
					field: {
						uuid: doseUuid,
						id: "dose",
						kind: "text",
						label: proseText("Dose"),
					},
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.store.getState()["/data/orders[1]/dose"]).toBeDefined();
			ctrl.setValueAt("/data/orders[1]/dose", "5mg");
			expect(ctrl.store.getState()["/data/orders[1]/dose"].value).toBe("5mg");
		});

		it("renaming a repeat-child field carries every instance's value", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[0]/name", "Hydrangea");
			ctrl.setValueAt("/data/orders[1]/name", "Aspirin");

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: nameUuid,
					targetKind: "text",
					patch: { id: "medication" },
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			const runtime = ctrl.store.getState();
			expect(runtime["/data/orders[0]/medication"].value).toBe("Hydrangea");
			expect(runtime["/data/orders[1]/medication"].value).toBe("Aspirin");
			expect(runtime["/data/orders[1]/name"].path).toBe("");
		});

		it("renaming the repeat container keeps its instances and values", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[1]/name", "Aspirin");

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: repeatUuid,
					targetKind: "repeat",
					patch: { id: "meds" },
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.getRepeatCount(repeatUuid)).toBe(2);
			expect(ctrl.store.getState()["/data/meds[1]/name"].value).toBe("Aspirin");
		});

		it("a retype clears every instance's stale value", async () => {
			const store = createLoadedStore(repeatDoc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[1]/name", "abc");

			store
				.getState()
				.applyMany([
					{ kind: "convertField", uuid: nameUuid, toKind: "secret" },
				]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.store.getState()["/data/orders[1]/name"].value).toBe("");
		});

		it("removing a repeat-child field leaves no phantom state blocking submit", async () => {
			const doc = repeatDoc();
			doc.fields[nameUuid] = {
				...doc.fields[nameUuid],
				required: xp("true()"),
			} as Field;
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);

			// Both instances empty + required — submit blocked.
			expect(ctrl.validateAll()).toBe(false);

			store.getState().applyMany([{ kind: "removeField", uuid: nameUuid }]);
			await new Promise((r) => setTimeout(r, 10));

			// The field is gone from every instance — nothing left to fail.
			expect(ctrl.validateAll()).toBe(true);
		});

		it("an expression edit recomputes every live instance", async () => {
			const tagUuid = testUuid("eeeeeeee-0003-0003-0003-000000000001");
			const doc = repeatDoc();
			doc.fields[tagUuid] = {
				uuid: tagUuid,
				id: "tag",
				kind: "hidden",
				calculate: xp("'A'"),
			} as Field;
			doc.fieldOrder[repeatUuid] = [nameUuid, tagUuid];
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);
			ctrl.addRepeat(repeatUuid);
			expect(ctrl.store.getState()["/data/orders[1]/tag"].value).toBe("A");

			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: tagUuid,
					targetKind: "hidden",
					patch: { calculate: xp("'B'") },
				},
			]);
			await new Promise((r) => setTimeout(r, 10));

			expect(ctrl.store.getState()["/data/orders[0]/tag"].value).toBe("B");
			expect(ctrl.store.getState()["/data/orders[1]/tag"].value).toBe("B");
		});

		it("per-instance values reach the submission walk", () => {
			const patientNameUuid = testUuid("eeeeeeee-0001-0001-0001-000000000003");
			const patientCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
				],
			};
			const doc = repeatDoc();
			doc.fields[patientNameUuid] = {
				uuid: patientNameUuid,
				id: "patient_name",
				kind: "hidden",
				calculate: xp("'Patient'"),
				caseWrite: { caseType: "patient", property: "case_name" },
			};
			const nameField = doc.fields[nameUuid];
			doc.fields[nameUuid] = {
				...nameField,
				id: "case_name",
				caseWrite: { caseType: "medication_order", property: "case_name" },
			} as Field;
			doc.fieldOrder[FORM_UUID] = [patientNameUuid, repeatUuid];
			doc.fieldOrder[repeatUuid] = [nameUuid];
			doc.forms[FORM_UUID] = {
				...doc.forms[FORM_UUID],
				type: "registration",
			};
			doc.modules[MODULE_UUID] = {
				...doc.modules[MODULE_UUID],
				caseType: "patient",
			};
			doc.caseTypes = [
				patientCaseType,
				{
					name: "medication_order",
					parent_type: "patient",
					properties: [
						{
							name: "case_name",
							label: proseText("Medication order name"),
							data_type: "text",
						},
					],
				},
			];
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(FORM_UUID);

			ctrl.addRepeat(repeatUuid);
			ctrl.setValueAt("/data/orders[0]/case_name", "Hydrangea");
			ctrl.setValueAt("/data/orders[1]/case_name", "Aspirin");

			const mutation = ctrl.computeSubmissionMutation({});
			expect(mutation).toMatchObject({
				kind: "registration",
				children: [
					{ caseType: "medication_order", caseName: "Hydrangea" },
					{ caseType: "medication_order", caseName: "Aspirin" },
				],
			});
		});
	});

	describe("computeSubmissionMutation", () => {
		const patientCaseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
			],
		};

		it("throws when no engine is active", () => {
			const ctrl = new EngineController();
			expect(() => ctrl.computeSubmissionMutation({})).toThrow(
				/controller has no active engine/,
			);
		});

		it("delegates to the engine and returns the typed mutation", () => {
			// Build a registration-form fixture against a `patient` module.
			const moduleUuid = testUuid("module-2-uuid");
			const formUuid = testUuid("form-2-uuid");
			const nameUuid = testUuid("cccccccc-0001-0001-0001-000000000001");
			const ageUuid = testUuid("cccccccc-0002-0002-0002-000000000002");
			const doc: PersistableDoc = {
				appId: "test-app",
				appName: "Test App",
				connectType: null,
				caseTypes: [patientCaseType],
				modules: {
					[moduleUuid]: {
						uuid: moduleUuid,
						id: "patients",
						name: "Patients",
						caseType: "patient",
					},
				},
				forms: {
					[formUuid]: {
						uuid: formUuid,
						id: "register",
						name: "Register",
						type: "registration",
					},
				},
				fields: {
					[nameUuid]: {
						uuid: nameUuid,
						id: "case_name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					[ageUuid]: {
						uuid: ageUuid,
						id: "age",
						kind: "int",
						label: proseText("Age"),
						caseWrite: { caseType: "patient", property: "age" },
					},
				},
				moduleOrder: [moduleUuid],
				formOrder: { [moduleUuid]: [formUuid] },
				fieldOrder: { [formUuid]: [nameUuid, ageUuid] },
			};
			const store = createBlueprintDocStore();
			store.getState().load(doc);
			store.getState().startTracking();

			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.activateForm(formUuid);

			ctrl.onValueChange(nameUuid, "Alice");
			ctrl.onValueChange(ageUuid, "30");

			const mutation = ctrl.computeSubmissionMutation({});
			// The controller injects THIS entry's attachment scope, which is why
			// the assertion is on the case-bearing slots plus explicit checks
			// on the required submission protocol rather than whole-object equality.
			expect(mutation).toMatchObject({
				kind: "registration",
				formUuid,
				primary: {
					caseType: "patient",
					caseName: "Alice",
					properties: { age: 30 },
				},
				children: [],
			});
			// Present because a form is active; empty because nothing was
			// attached, which is the instruction to discard any staged
			// attachment for this entry.
			expect(mutation.entryKey).toEqual(expect.any(String));
			expect(mutation.attachmentRefs).toEqual([]);

			// One activation is one entry: a key that survived reactivation
			// would let a new entry reconcile the previous one's attachments.
			const firstEntry = ctrl.entryKey;
			ctrl.activateForm(formUuid);
			expect(ctrl.entryKey).toEqual(expect.any(String));
			expect(ctrl.entryKey).not.toBe(firstEntry);

			// And no active form means no scope to reconcile at all.
			ctrl.deactivate();
			expect(ctrl.entryKey).toBeUndefined();
		});
	});

	describe("setPreviewIdentity", () => {
		const WHO_UUID = testUuid("aaaaaaaa-0009-0009-0009-000000000009");
		const REGION_UUID = testUuid("aaaaaaaa-0010-0010-0010-000000000010");
		const ME = { id: "worker-1", email: "amina@example.org" };

		/** Standard two-field doc plus a hidden `#user/username` calculate. */
		function docWithUserCalc(): PersistableDoc {
			return makeDoc(
				{
					[Q1_UUID]: {
						uuid: Q1_UUID,
						id: "name",
						kind: "text",
						label: proseText("Name"),
					},
					[WHO_UUID]: {
						uuid: WHO_UUID,
						id: "who",
						kind: "hidden",
						calculate: xp("#user/username"),
					} as Field,
				},
				{ [FORM_UUID]: [Q1_UUID, WHO_UUID] },
			);
		}

		it("an identity installed before activation resolves #user reads", () => {
			const store = createLoadedStore(docWithUserCalc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.setPreviewIdentity(previewAsMe(ME));

			ctrl.activateForm(FORM_UUID);

			expect(ctrl.store.getState()[WHO_UUID].value).toBe("amina@example.org");
		});

		it("an identity arriving after activation rebuilds the active engine", () => {
			const store = createLoadedStore(docWithUserCalc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(FORM_UUID);
			expect(ctrl.store.getState()[WHO_UUID].value).toBe("");

			ctrl.setPreviewIdentity(previewAsMe(ME));
			expect(ctrl.store.getState()[WHO_UUID].value).toBe("amina@example.org");
		});

		it("a re-derived identical identity is a no-op preserving entered values", () => {
			const store = createLoadedStore(docWithUserCalc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.setPreviewIdentity(previewAsMe(ME));
			ctrl.activateForm(FORM_UUID);

			ctrl.onValueChange(Q1_UUID, "typed answer");
			ctrl.setPreviewIdentity(previewAsMe({ ...ME }));

			expect(ctrl.store.getState()[Q1_UUID].value).toBe("typed answer");
		});

		it("an identity change rebuilds the evaluation world, discarding entered values", () => {
			const store = createLoadedStore(docWithUserCalc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.setPreviewIdentity(previewAsMe(ME));
			ctrl.activateForm(FORM_UUID);
			ctrl.onValueChange(Q1_UUID, "typed answer");

			ctrl.setPreviewIdentity(
				previewAsMe({ id: "worker-2", email: "other@example.org" }),
			);

			expect(ctrl.store.getState()[WHO_UUID].value).toBe("other@example.org");
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("");
		});

		it("a session resolving mid-entry preserves answers typed under the anonymous world", () => {
			const store = createLoadedStore(docWithUserCalc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);

			ctrl.activateForm(FORM_UUID);
			ctrl.onValueChange(Q1_UUID, "typed before session resolved");
			ctrl.onTouch(Q1_UUID);

			ctrl.setPreviewIdentity(previewAsMe(ME));

			expect(ctrl.store.getState()[Q1_UUID].value).toBe(
				"typed before session resolved",
			);
			expect(ctrl.store.getState()[WHO_UUID].value).toBe("amina@example.org");
		});

		it("a sign-out (identity to null) discards entered values with the world", () => {
			const store = createLoadedStore(docWithUserCalc());
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.setPreviewIdentity(previewAsMe(ME));
			ctrl.activateForm(FORM_UUID);
			ctrl.onValueChange(Q1_UUID, "typed answer");

			ctrl.setPreviewIdentity(null);

			expect(ctrl.store.getState()[WHO_UUID].value).toBe("");
			expect(ctrl.store.getState()[Q1_UUID].value).toBe("");
		});

		it("a custom worker-property rename reprints the same AST identity in an open form", () => {
			const doc = makeDoc(
				{
					[Q1_UUID]: {
						uuid: Q1_UUID,
						id: "name",
						kind: "text",
						label: proseText("Name"),
					},
					[WHO_UUID]: {
						uuid: WHO_UUID,
						id: "region",
						kind: "hidden",
						calculate: {
							parts: [
								{
									kind: "user-property-ref",
									userPropertyUuid: REGION_UUID,
								},
							],
						},
					} as Field,
				},
				{ [FORM_UUID]: [Q1_UUID, WHO_UUID] },
			);
			doc.userProperties = {
				[REGION_UUID]: {
					uuid: REGION_UUID,
					slug: "assigned_region",
					label: "Assigned region",
				},
			};
			doc.userPropertyOrder = [REGION_UUID];
			const identity: ResolvedPreviewIdentity = {
				actorUserId: ME.id,
				ownerId: ME.id,
				session: {
					context: { userid: ME.id },
					user: {
						assigned_region: "north",
						supervision_area: "south",
					},
					userPropertySlugs: {
						[REGION_UUID]: "assigned_region",
					},
				},
				usercase: {
					assigned_region: "north",
					supervision_area: "south",
				},
			};
			const store = createLoadedStore(doc);
			const ctrl = new EngineController();
			ctrl.setDocStore(store);
			ctrl.setPreviewIdentity(identity);
			ctrl.activateForm(FORM_UUID);
			const storedField = store.getState().fields[WHO_UUID];
			if (storedField.kind !== "hidden") {
				throw new Error("test fixture must remain a hidden field");
			}
			const storedAst = storedField.calculate;
			expect(ctrl.store.getState()[WHO_UUID].value).toBe("north");

			store.getState().applyMany([
				{
					kind: "updateUserProperty",
					uuid: REGION_UUID,
					patch: { slug: "supervision_area", label: "Supervision area" },
				},
			]);

			const renamedField = store.getState().fields[WHO_UUID];
			if (renamedField.kind !== "hidden") {
				throw new Error("worker-property rename must not retype the field");
			}
			expect(renamedField.calculate).toBe(storedAst);
			expect(ctrl.store.getState()[WHO_UUID].value).toBe("south");
		});
	});
});
