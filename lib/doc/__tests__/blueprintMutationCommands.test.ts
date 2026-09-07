import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	resolveCaseListConfig,
	xp,
} from "@/lib/__tests__/docHelpers";
import {
	type AddCommitOutcome,
	createBlueprintMutations,
} from "@/lib/doc/hooks/useBlueprintMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { type Automation, uuidSchema } from "@/lib/domain";
import { printProseTemplate, proseText } from "@/lib/domain/prose";
import { toastStore } from "@/lib/ui/toastStore";
import { assertAdmittedDoc } from "./admittedDoc";

// Exercise the production Builder command owner directly. React supplies its
// context and memo lifetime separately; no render is needed to run commands.
const MOD1 = testUuid("module-1-uuid");
const FORM1 = testUuid("form-1-uuid");
const FORM2 = testUuid("form-2-uuid");
const Q_A = testUuid("q-a-0000-0000-0000-000000000000");
const Q_B = testUuid("q-b-0000-0000-0000-000000000000");
const Q_G = testUuid("q-g-0000-0000-0000-000000000000");
const Q_C = testUuid("q-c-0000-0000-0000-000000000000");
const Q_X = testUuid("q-x-0000-0000-0000-000000000000");
const bp = buildDoc({
	appId: "t",
	appName: "Test",
	modules: [
		{
			uuid: MOD1,
			name: "M0",
			forms: [
				{
					uuid: FORM1,
					name: "F0",
					type: "survey",
					fields: [
						{
							uuid: Q_A,
							kind: "text",
							id: "a",
							label: "A",
						},
						{
							uuid: Q_B,
							kind: "text",
							id: "b",
							label: "B",
						},
						{
							uuid: Q_G,
							kind: "group",
							id: "grp",
							label: "Group",
							children: [
								{
									uuid: Q_C,
									kind: "text",
									id: "c",
									label: "C",
								},
							],
						},
					],
				},
				{
					uuid: FORM2,
					name: "F1",
					type: "survey",
					fields: [
						{
							uuid: Q_X,
							kind: "text",
							id: "x",
							label: "X",
						},
					],
				},
			],
		},
	],
});
const connectBp: BlueprintDoc = {
	...bp,
	connectType: "learn",
	forms: {
		...bp.forms,
		[FORM1]: {
			...bp.forms[FORM1],
			connect: {
				learn_module: {
					id: "intro",
					name: "Introduction",
					description: "Initial content",
					time_estimate: 5,
				},
			},
		},
	},
};
function setup(doc: BlueprintDoc = bp) {
	assertAdmittedDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.getState().startTracking();
	const mutations = createBlueprintMutations(store, {
		canEdit: true,
		authoringLanguage: null,
		lookupCommitState: {
			kind: "unmanaged",
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		},
	});
	return {
		store,
		mutations,
	};
}
function children(store: BlueprintDocStoreApi, parentUuid: Uuid) {
	const doc = store.getState();
	return (doc.fieldOrder[parentUuid] ?? []).map((uuid) => doc.fields[uuid]);
}
function getFormUuid(store: BlueprintDocStoreApi) {
	const doc = store.getState();
	return doc.formOrder[doc.moduleOrder[0]][0];
}
afterEach(() => {
	toastStore.clear();
	vi.restoreAllMocks();
});
describe("Builder mutation commands", () => {
	// ── Pre-existing coverage ──────────────────────────────────────────────

	it("updateQuestion edits fields via uuid", () => {
		const { mutations, store } = setup(bp);
		mutations.updateField(Q_A, "text", {
			label: proseText("Renamed"),
		});

		// Cast to a loose variant-agnostic shape to read `label` — the domain
		// `Field` union includes variants (hidden) that omit label at the
		// type level, even though the reducer merges it unconditionally.
		const renamed = children(store, FORM1).find((q) => q.id === "a") as
			| {
					label?: ReturnType<typeof proseText>;
			  }
			| undefined;
		if (!renamed?.label || !store) {
			throw new Error("expected renamed field label and initialized store");
		}
		expect(printProseTemplate(renamed.label, store.getState())).toBe("Renamed");
	});
	it("normalizes an explicit undefined field clear to JSON-stable null", () => {
		const { mutations, store } = setup(bp);
		assert(store);
		mutations.updateField(Q_A, "text", {
			hint: proseText("Temporary hint"),
		});
		store.getState().takeCommandBatches();
		mutations.updateField(Q_A, "text", {
			hint: undefined,
		});
		expect(
			(
				store.getState().fields[Q_A] as {
					hint?: unknown;
				}
			).hint,
		).toBeUndefined();
		const commands = store.getState().peekCommandBatches();
		expect(commands).toEqual([
			[
				{
					kind: "updateField",
					uuid: Q_A,
					targetKind: "text",
					patch: {
						hint: null,
					},
				},
			],
		]);
		expect(JSON.parse(JSON.stringify(commands))).toEqual(commands);
	});
	it("renameQuestion rewrites the id in order", () => {
		const { mutations, store } = setup(bp);
		assert(store);
		mutations.renameField(Q_A, "alpha");
		const ids = children(store, FORM1).map((q) => q.id);
		expect(ids).toContain("alpha");
		expect(ids).not.toContain("a");
		expect(store.getState().peekCommandBatches()).toEqual([
			[
				{
					kind: "updateField",
					uuid: Q_A,
					targetKind: "text",
					patch: {
						id: "alpha",
					},
				},
			],
		]);
	});
	it("removeField drops the field from order", () => {
		const { mutations, store } = setup(bp);
		mutations.removeField(Q_B);
		expect(children(store, FORM1).map((q) => q.id)).toEqual(["a", "grp"]);
	});
	it("updateApp changes app-level fields", () => {
		const { mutations, store } = setup(bp);
		mutations.updateApp({
			app_name: "New",
		});
		expect(store.getState().appName).toBe("New");
	});

	// ── addField ────────────────────────────────────────────────────────

	it("addField returns the new field's uuid", () => {
		const { mutations, store } = setup(bp);
		let returned = {
			ok: false,
			messages: [],
		} as AddCommitOutcome;
		{
			const formUuid = getFormUuid(store);
			returned = mutations.addField(formUuid, {
				id: "d",
				kind: "text",
				label: proseText("D"),
			});
		}

		// The outcome carries the minted uuid, matching the newly inserted
		// field in the form's children.
		assert(returned.ok);
		uuidSchema.parse(returned.uuid);
		const inserted = children(store, FORM1).find((q) => q.id === "d");
		expect(inserted?.uuid).toBe(returned.uuid);
	});
	it("addField with parentUuid inserts into a group", () => {
		const { mutations, store } = setup(bp);
		mutations.addField(Q_G, {
			id: "c2",
			kind: "text",
			label: proseText("C2"),
		});
		expect(children(store, Q_G).map((q) => q.id)).toEqual(["c", "c2"]);
	});
	it("addField with afterUuid/beforeUuid positions correctly", () => {
		const { mutations, store } = setup(bp);

		// Insert between `a` and `b` via `afterUuid`.
		{
			const formUuid = getFormUuid(store);
			mutations.addField(
				formUuid,
				{
					id: "a2",
					kind: "text",
					label: proseText("A2"),
				},
				{
					afterUuid: Q_A,
				},
			);
		}
		expect(children(store, FORM1).map((q) => q.id)).toEqual([
			"a",
			"a2",
			"b",
			"grp",
		]);

		// Insert before `b` — should land between `a2` and `b`.
		{
			const formUuid = getFormUuid(store);
			mutations.addField(
				formUuid,
				{
					id: "a3",
					kind: "text",
					label: proseText("A3"),
				},
				{
					beforeUuid: Q_B,
				},
			);
		}
		expect(children(store, FORM1).map((q) => q.id)).toEqual([
			"a",
			"a2",
			"a3",
			"b",
			"grp",
		]);
	});

	// ── moveField ─────────────────────────────────────────────────────────

	it("moveField with afterUuid reorders within the same parent", () => {
		const { mutations, store } = setup(bp);
		mutations.moveField(Q_A, {
			afterUuid: Q_B,
		});
		expect(children(store, FORM1).map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});
	it("moveField with toParentUuid crosses parents", () => {
		const { mutations, store } = setup(bp);
		mutations.moveField(Q_A, {
			toParentUuid: Q_G,
		});

		// Top level should no longer contain `a`; group now has both `c` and `a`.
		expect(children(store, FORM1).map((q) => q.id)).toEqual(["b", "grp"]);
		expect(children(store, Q_G).map((q) => q.id)).toContain("a");
	});

	// ── duplicateQuestion ─────────────────────────────────────────────────

	it("duplicateQuestion returns { newPath, newUuid }", () => {
		const { mutations, store } = setup(bp);
		const dup = mutations.duplicateField(Q_A);
		expect(dup).toBeDefined();
		uuidSchema.parse(dup?.newUuid);
		// The duplicated field's path is top-level (no slashes) and its id
		// should be either `a` + dedup suffix.
		expect(dup?.newPath.startsWith("a")).toBe(true);
		// The new uuid should actually exist in the current form's children.
		const newUuid = dup?.newUuid;
		expect(children(store, FORM1).some((q) => q.uuid === newUuid)).toBe(true);
	});

	// ── renameQuestion conflict detection ─────────────────────────────────

	it("renameQuestion returns conflict: true when sibling id clashes", () => {
		const { mutations, store } = setup(bp);

		// Attempt to rename `a` → `b`, which already exists.
		const captured: {
			value?: ReturnType<typeof mutations.renameField>;
		} = {};
		captured.value = mutations.renameField(Q_A, "b");
		expect(captured.value?.conflict).toBe(true);
		// And the store should be unchanged — `a` is still present.
		expect(children(store, FORM1).map((q) => q.id)).toEqual(["a", "b", "grp"]);
	});
	it("renameQuestion is local even when another writer saves to the same property", () => {
		// Two fields in separate forms may save to the same case property.
		// Renaming one field id changes only its friendly form path; it must not
		// rename the peer or inspect the peer's sibling scope.
		const CP_M = testUuid("cp-mod-uuid");
		const CP_F1 = testUuid("cp-form-1-uuid");
		const CP_F2 = testUuid("cp-form-2-uuid");
		const CP_PRIMARY = testUuid("cp-primary-uuid");
		const CP_PEER = testUuid("cp-peer-uuid");
		const CP_BLOCKER = testUuid("cp-blocker-uuid");
		const CP_COLUMN = testUuid("cp-column-uuid");
		const peerDoc: BlueprintDoc = {
			appId: "t",
			appName: "Test",
			connectType: null,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "age",
							label: proseText("Age"),
						},
						{
							name: "age_new",
							label: proseText("Age new"),
						},
					],
				},
			],
			modules: {
				[CP_M]: {
					uuid: CP_M,
					id: "cp_m",
					name: "CPM",
					caseType: "patient",
					caseListConfig: resolveCaseListConfig({
						columns: [
							{
								uuid: CP_COLUMN,
								kind: "plain",
								field: "age",
								header: "Age",
							},
						],
						searchInputs: [],
					}),
				},
			},
			forms: {
				[CP_F1]: {
					uuid: CP_F1,
					id: "cp_f1",
					name: "F1",
					type: "followup",
				},
				[CP_F2]: {
					uuid: CP_F2,
					id: "cp_f2",
					name: "F2",
					type: "followup",
				},
			},
			fields: {
				// Primary and peer share the same independent caseWrite pair.
				[CP_PRIMARY]: {
					uuid: CP_PRIMARY,
					id: "age",
					kind: "text",
					label: proseText("Age"),
					caseWrite: {
						caseType: "patient",
						property: "age",
					},
				} as BlueprintDoc["fields"][typeof CP_PRIMARY],
				[CP_PEER]: {
					uuid: CP_PEER,
					id: "age",
					kind: "text",
					label: proseText("Age"),
					caseWrite: {
						caseType: "patient",
						property: "age",
					},
				} as BlueprintDoc["fields"][typeof CP_PEER],
				// This sibling blocks only a local rename of CP_PEER, not the
				// unrelated primary field in F1.
				[CP_BLOCKER]: {
					uuid: CP_BLOCKER,
					id: "age_new",
					kind: "text",
					label: proseText("Existing"),
				} as BlueprintDoc["fields"][typeof CP_BLOCKER],
			},
			moduleOrder: [CP_M],
			formOrder: {
				[CP_M]: [CP_F1, CP_F2],
			},
			fieldOrder: {
				[CP_F1]: [CP_PRIMARY],
				[CP_F2]: [CP_PEER, CP_BLOCKER],
			},
			fieldParent: {},
		};
		const { mutations, store } = setup(peerDoc);
		const captured: {
			value?: ReturnType<typeof mutations.renameField>;
		} = {};
		captured.value = mutations.renameField(CP_PRIMARY, "age_new");
		expect(captured.value).toEqual({});

		// Only the selected field's local id changes.
		const state = store.getState();
		assert(state);
		expect(state.fields[CP_PRIMARY]?.id).toBe("age_new");
		expect(state.fields[CP_PEER]?.id).toBe("age");
		expect(state.fields[CP_BLOCKER]?.id).toBe("age_new");
	});

	// ── updateApp undo ────────────────────────────────────────────────────

	it("updateApp renames the app in a single undo entry", () => {
		const { mutations, store } = setup(bp);
		store.getState().startTracking();
		mutations.updateApp({
			app_name: "Combo",
		});

		// ONE step: a single undo takes back the rename.
		expect(store.getState().canUndo).toBe(true);
		store.getState().undo();
		expect(store.getState().appName).not.toBe("Combo");
		expect(store.getState().canUndo).toBe(false);
	});

	// ── addForm returns uuid ──────────────────────────────────────────────

	it("addForm of a bare (fieldless) form is rejected — a form lands with its content", () => {
		const { mutations, store } = setup(bp);
		let returned = {
			ok: true,
			uuid: "",
		} as unknown as AddCommitOutcome;
		{
			const s = store.getState();
			assert(s);
			const moduleUuid = s.moduleOrder[0];
			returned = mutations.addForm(moduleUuid, {
				uuid: testUuid("form-3-uuid"),
				id: "f2",
				name: "F2",
				type: "survey",
			});
		}
		assert(!returned.ok);
		expect(returned.messages.length).toBeGreaterThan(0);
		const s = store.getState();
		assert(s);
		expect(s.forms[testUuid("form-3-uuid")]).toBeUndefined();
	});
	it("applyMany lands a new form together with its first field in one gated batch", () => {
		const { mutations, store } = setup(bp);
		{
			const s = store.getState();
			assert(s);
			const moduleUuid = s.moduleOrder[0];
			mutations.applyMany([
				{
					kind: "addForm",
					moduleUuid,
					form: {
						uuid: testUuid("form-3-uuid"),
						id: "f2",
						name: "F2",
						type: "survey",
					},
				},
				{
					kind: "addField",
					parentUuid: testUuid("form-3-uuid"),
					field: {
						uuid: testUuid("q-n-0000-0000-0000-000000000000"),
						id: "note",
						kind: "text",
						label: proseText("Note"),
					} as never,
				},
			]);
		}
		const s = store.getState();
		assert(s);
		expect(s.forms[testUuid("form-3-uuid")]).toBeDefined();
		expect(s.forms[testUuid("form-3-uuid")].name).toBe("F2");
	});

	// ── addModule returns uuid ────────────────────────────────────────────

	it("createSurveyModule returns the new module's uuid, born with a form", () => {
		const { mutations, store } = setup(bp);
		let returned = {
			ok: false,
			messages: [],
		} as AddCommitOutcome;
		returned = mutations.createSurveyModule({
			name: "M1",
		});

		// A bare module would be rejected (NO_FORMS_OR_CASE_LIST); createSurveyModule
		// lands a survey form with it, so the commit is valid by construction.
		assert(returned.ok);
		uuidSchema.parse(returned.uuid);
		const s = store.getState();
		assert(s);
		expect(s.modules[returned.uuid]).toBeDefined();
		expect(s.modules[returned.uuid].name).toBe("M1");
		expect(s.formOrder[returned.uuid]).toHaveLength(1);
	});

	// ── updateForm ────────────────────────────────────────────────────────

	it("updateForm patches camelCase fields on an existing form", () => {
		const { mutations, store } = setup(bp);
		{
			const formUuid = getFormUuid(store);
			mutations.updateForm(formUuid, {
				name: "Renamed Form",
			});
		}
		const s = store.getState();
		const formUuid = getFormUuid(store);
		expect(s?.forms[formUuid].name).toBe("Renamed Form");
		expect(s?.peekCommandBatches()).toEqual([
			[
				{
					kind: "renameForm",
					uuid: formUuid,
					newId: "Renamed Form",
				},
			],
		]);
	});
	it("normalizes an explicit undefined form clear to JSON-stable null", () => {
		const { mutations, store } = setup(bp);
		assert(store);
		const formUuid = getFormUuid(store);
		mutations.updateForm(formUuid, {
			purpose: "Temporary purpose",
		});
		store.getState().takeCommandBatches();
		mutations.updateForm(formUuid, {
			purpose: undefined,
		});
		expect(store.getState().forms[formUuid].purpose).toBeUndefined();
		const commands = store.getState().peekCommandBatches();
		expect(commands).toEqual([
			[
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: {
						purpose: null,
					},
				},
			],
		]);
		expect(JSON.parse(JSON.stringify(commands))).toEqual(commands);
	});
	it("confines Connect membership outside generic form add/update and permits only explicit existing-participant refinement", () => {
		const { mutations, store } = setup(connectBp);
		assert(store);
		const initialParticipant = store.getState().forms[FORM1].connect;
		/* Casts model a stale bundle or untyped JavaScript caller. The public
		 * TypeScript signatures omit these slots; the runtime boundary must
		 * still refuse them before the absolute gate can accept a valid
		 * participant-bearing candidate. */
		const addOutcome = mutations.inline.addForm(MOD1, {
			id: "alternate",
			name: "Alternate",
			type: "survey",
			connect: initialParticipant,
		} as never);
		const addParticipantOutcome = mutations.inline.updateForm(FORM2, {
			connect: initialParticipant,
		} as never);
		const removeParticipantOutcome = mutations.inline.updateForm(FORM1, {
			connect: null,
		} as never);
		for (const outcome of [
			addOutcome,
			addParticipantOutcome,
			removeParticipantOutcome,
		]) {
			expect(outcome?.ok).toBe(false);
			if (outcome?.ok === false) {
				expect(outcome.messages[0]).toContain("app-wide Connect");
			}
		}
		expect(store.getState().forms[FORM1].connect).toEqual(initialParticipant);
		expect(store.getState().forms[FORM2].connect).toBeUndefined();
		expect(store.getState().formOrder[MOD1]).toEqual([FORM1, FORM2]);
		const refineOutcome = mutations.inline.refineFormConnect(FORM1, {
			learn_module: {
				id: "intro",
				name: "Introduction",
				description: "Refined content",
				time_estimate: 9,
			},
		});
		expect(refineOutcome).toEqual({
			ok: true,
		});
		expect(
			(
				store.getState().forms[FORM1].connect as {
					learn_module?: {
						description: string;
						time_estimate: number;
					};
				}
			).learn_module,
		).toMatchObject({
			description: "Refined content",
			time_estimate: 9,
		});
		const nonparticipantRefine = mutations.inline.refineFormConnect(FORM2, {
			learn_module: {
				id: "other",
				name: "Other",
				description: "Should not land",
				time_estimate: 5,
			},
		});
		expect(nonparticipantRefine?.ok).toBe(false);
		expect(store.getState().forms[FORM2].connect).toBeUndefined();
	});
	it("setFormMedia sets and clears form media through explicit nulls", () => {
		const { mutations, store } = setup(bp);
		const formUuid = getFormUuid(store);
		mutations.setFormMedia(formUuid, {
			icon: testMediaAssetId("image-asset"),
			audioLabel: testMediaAssetId("audio-asset"),
		});
		expect(store.getState().forms[formUuid]).toMatchObject({
			icon: testMediaAssetId("image-asset"),
			audioLabel: testMediaAssetId("audio-asset"),
		});
		mutations.setFormMedia(formUuid, {
			icon: null,
			audioLabel: testMediaAssetId("audio-asset"),
		});
		const form = store.getState().forms[formUuid];
		expect(form?.icon).toBeUndefined();
		expect(form?.audioLabel).toBe(testMediaAssetId("audio-asset"));
	});
	it("setModuleMedia sets and clears module media through explicit nulls", () => {
		// Mirrors `setFormMedia`: the dedicated `setModuleMedia` kind carries
		// an explicit `MediaAssetId | null` per slot so a clear survives JSON over
		// the SSE wire (a generic `updateModule` patch would encode the clear
		// as `{ key: undefined }`, which `JSON.stringify` drops). The reducer
		// maps `null → undefined`, so a cleared slot drops off the module.
		const { mutations, store } = setup(bp);
		mutations.setModuleMedia(MOD1, {
			icon: testMediaAssetId("image-asset"),
			audioLabel: testMediaAssetId("audio-asset"),
		});
		expect(store.getState().modules[MOD1]).toMatchObject({
			icon: testMediaAssetId("image-asset"),
			audioLabel: testMediaAssetId("audio-asset"),
		});
		mutations.setModuleMedia(MOD1, {
			icon: null,
			audioLabel: testMediaAssetId("audio-asset"),
		});
		const mod = store.getState().modules[MOD1];
		expect(mod?.icon).toBeUndefined();
		expect(mod?.audioLabel).toBe(testMediaAssetId("audio-asset"));
	});
	it("setAppLogo sets and clears the app logo through an explicit null", () => {
		// The doc's `logo` slot is `.optional()` (no stored `null`), so a
		// clear must DROP the key — the `setAppLogo` payload carries an
		// explicit `MediaAssetId | null` and the reducer maps `null → undefined`.
		// Unlike the entity-scoped media mutations, `setAppLogo` takes no
		// uuid (the logo is a single app-level slot), so there is no
		// unresolved-uuid guard to exercise.
		const { mutations, store } = setup(bp);
		mutations.setAppLogo(testMediaAssetId("logo-asset"));
		expect(store.getState().logo).toBe(testMediaAssetId("logo-asset"));
		mutations.setAppLogo(null);
		expect(store.getState().logo).toBeUndefined();
	});

	// ── removeForm ────────────────────────────────────────────────────────

	it("removeForm drops the form entity and its formOrder entry", () => {
		const { mutations, store } = setup(bp);
		let formUuid: Uuid = "" as Uuid;
		formUuid = getFormUuid(store);
		mutations.removeForm(formUuid);
		const s = store.getState();
		expect(s?.forms[formUuid]).toBeUndefined();
		// The module's formOrder should no longer reference the removed form.
		const moduleUuid = s?.moduleOrder[0] ?? ("" as Uuid);
		expect(s?.formOrder[moduleUuid]).not.toContain(formUuid);
	});

	// ── updateModule ──────────────────────────────────────────────────────

	it("updateModule patches fields on an existing module", () => {
		const { mutations, store } = setup(bp);
		{
			const s = store.getState();
			const moduleUuid = s?.moduleOrder[0];
			if (!moduleUuid) return;
			mutations.updateModule(moduleUuid, {
				name: "Renamed Module",
			});
		}
		const s = store.getState();
		const moduleUuid = s?.moduleOrder[0] ?? ("" as Uuid);
		expect(s?.modules[moduleUuid].name).toBe("Renamed Module");
	});
	it("creates and reorders submenus with stable sibling anchors", () => {
		const { mutations, store } = setup(bp);
		let firstChild = "" as Uuid;
		let secondChild = "" as Uuid;
		{
			const first = mutations.createSurveyModule({
				name: "First child",
				parentModuleUuid: MOD1,
				after: null,
			});
			assert(first.ok);
			firstChild = first.uuid;
			const second = mutations.createSurveyModule({
				name: "Second child",
				parentModuleUuid: MOD1,
				after: firstChild,
			});
			assert(second.ok);
			secondChild = second.uuid;
		}
		mutations.moveModule(secondChild, {
			after: null,
		});
		const state = store.getState();
		expect(state?.moduleOrder.slice(0, 3)).toEqual([
			MOD1,
			secondChild,
			firstChild,
		]);
		expect(state?.modules[secondChild].parentModuleUuid).toBe(MOD1);
	});
	it("names child menus before refusing parent removal", () => {
		const { mutations, store } = setup(bp);
		let childUuid = "" as Uuid;
		{
			const child = mutations.createSurveyModule({
				name: "Follow-up menu",
				parentModuleUuid: MOD1,
				after: null,
			});
			assert(child.ok);
			childUuid = child.uuid;
		}
		const outcome = mutations.removeModule(MOD1);
		expect(outcome?.ok).toBe(false);
		if (outcome === undefined || outcome.ok) {
			throw new Error("parent removal unexpectedly committed");
		}
		expect(outcome.messages.join(" ")).toContain('"Follow-up menu"');
		expect(outcome.messages.join(" ")).toContain("Move or remove");
		expect(store.getState().modules[childUuid]).toBeDefined();
		expect(store.getState().modules[MOD1]).toBeDefined();
	});

	// ── removeModule ──────────────────────────────────────────────────────

	it("removeModule drops the module entity and its moduleOrder entry", () => {
		const { mutations, store } = setup(bp);

		/* Add a second module first — removing the app's ONLY module would
		 * re-introduce NO_MODULES and the gate rightly rejects it (pinned
		 * below). createSurveyModule lands it valid (a form comes with it). */
		let secondUuid: Uuid = "" as Uuid;
		{
			const added = mutations.createSurveyModule({
				name: "M1",
			});
			assert(added.ok);
			secondUuid = added.uuid;
		}
		mutations.removeModule(secondUuid);
		const s = store.getState();
		expect(s?.modules[secondUuid]).toBeUndefined();
		expect(s?.moduleOrder).not.toContain(secondUuid);
	});
	it("removeModule of the app's ONLY module is rejected — it would re-introduce NO_MODULES", () => {
		const { mutations, store } = setup(bp);
		let moduleUuid: Uuid = "" as Uuid;
		let outcome: {
			ok: boolean;
		} = {
			ok: true,
		};
		{
			const firstUuid = store.getState().moduleOrder[0];
			if (!firstUuid) return;
			moduleUuid = firstUuid;
			outcome = mutations.removeModule(moduleUuid);
		}
		expect(outcome.ok).toBe(false);
		const s = store.getState();
		expect(s?.modules[moduleUuid]).toBeDefined();
	});

	// ── Granular case-type catalog ────────────────────────────────────────

	it("commitMany creates and retires catalog records without a whole-catalog setter", () => {
		const { mutations, store } = setup(bp);
		mutations.commitMany([
			{
				kind: "declareCaseType",
				caseType: "patient",
			},
			{
				kind: "declareCaseType",
				caseType: "visit",
			},
		]);
		const s = store.getState();
		expect(s?.caseTypes).toEqual([
			{
				name: "patient",
				properties: [],
			},
			{
				name: "visit",
				properties: [],
			},
		]);
		mutations.commitMany([
			{
				kind: "retireCaseType",
				caseType: "patient",
			},
			{
				kind: "retireCaseType",
				caseType: "visit",
			},
		]);
		expect(store.getState().caseTypes).toBeNull();
	});

	// ── updateCaseProperty ───────────────────────────────────────────────

	it("updateCaseProperty updates a property on a case type", () => {
		const { mutations, store } = setup(bp);
		mutations.commitMany([
			{
				kind: "declareCaseType",
				caseType: "person",
			},
			{
				kind: "addCaseProperty",
				caseType: "person",
				property: {
					name: "dob",
					label: proseText("Date of Birth"),
					data_type: "text",
				},
			},
			{
				kind: "addCaseProperty",
				caseType: "person",
				property: {
					name: "age",
					label: proseText("Age"),
					data_type: "int",
				},
			},
		]);
		mutations.updateCaseProperty("person", "dob", {
			data_type: "date",
		});
		const s = store.getState();
		const personType = s?.caseTypes?.find((ct) => ct.name === "person");
		const dob = personType?.properties.find((p) => p.name === "dob");
		expect(dob?.data_type).toBe("date");
		// Ensure the other property is untouched.
		const age = personType?.properties.find((p) => p.name === "age");
		expect(age?.data_type).toBe("int");
	});
	it("updateCaseProperty on a non-existent case type is a silent no-op", () => {
		const { mutations, store } = setup(bp);
		mutations.commitMany([
			{
				kind: "declareCaseType",
				caseType: "person",
			},
			{
				kind: "addCaseProperty",
				caseType: "person",
				property: {
					name: "dob",
					label: proseText("DOB"),
					data_type: "text",
				},
			},
		]);

		// Should not throw even though "animal" doesn't exist.
		expect(() => {
			mutations.updateCaseProperty("animal", "dob", {
				data_type: "date",
			});
		}).not.toThrow();

		// Case types should be unchanged.
		const s = store.getState();
		expect(s?.caseTypes).toEqual([
			{
				name: "person",
				properties: [
					{
						name: "dob",
						label: proseText("DOB"),
						data_type: "text",
					},
				],
			},
		]);
	});
	it("updateCaseProperty on a non-existent property is a silent no-op", () => {
		const { mutations, store } = setup(bp);
		mutations.commitMany([
			{
				kind: "declareCaseType",
				caseType: "person",
			},
			{
				kind: "addCaseProperty",
				caseType: "person",
				property: {
					name: "dob",
					label: proseText("DOB"),
					data_type: "text",
				},
			},
		]);

		// Should not throw even though "nonexistent" doesn't exist.
		expect(() => {
			mutations.updateCaseProperty("person", "nonexistent", {
				label: proseText("Nope"),
			});
		}).not.toThrow();

		// Case types should be unchanged.
		const s = store.getState();
		expect(s?.caseTypes).toEqual([
			{
				name: "person",
				properties: [
					{
						name: "dob",
						label: proseText("DOB"),
						data_type: "text",
					},
				],
			},
		]);
	});

	// ── applyMany ─────────────────────────────────────────────────────────

	it("applyMany collapses two mutations into a single undo entry", () => {
		const { mutations, store } = setup(bp);
		store.getState().startTracking();
		// Both independent edits must belong to the same undo step.
		mutations.applyMany([
			{
				kind: "setAppName",
				name: "Batched",
			},
			{
				kind: "updateField",
				uuid: Q_A,
				targetKind: "text",
				patch: {
					label: proseText("Batched field"),
				},
			},
		]);
		const s = store.getState();
		expect(s?.appName).toBe("Batched");
		expect(s?.fields[Q_A]).toMatchObject({
			label: proseText("Batched field"),
		});
		store.getState().undo();
		expect(store.getState().appName).toBe("Test");
		expect(store.getState().fields[Q_A]).toMatchObject({
			label: proseText("A"),
		});
		expect(store.getState().canUndo).toBe(false);
	});

	// ── moveField collision admission ───────────────────────────────────

	it("moveField rejects a destination sibling-id collision without renaming", () => {
		// Use the fixture that has form F0 with [a, b, grp > [c]].
		// Add a field with id "a" inside the group, then move Q_A into the
		// group. The move preserves local field id, so admission rejects the
		// collision instead of inventing a new id.
		const { mutations, store } = setup(bp);
		mutations.addField(Q_G, {
			id: "a",
			kind: "text",
			label: proseText("duplicate-a"),
		});
		const captured: {
			value?: ReturnType<typeof mutations.moveField>;
		} = {};
		captured.value = mutations.moveField(Q_A, {
			toParentUuid: Q_G,
		});
		expect(captured.value).toBeDefined();
		expect(captured.value?.ok).toBe(false);
		expect(store.getState().fields[Q_A].id).toBe("a");
		expect(store.getState().fieldParent[Q_A]).toBe(FORM1);
	});

	// ── moveField — extra options ─────────────────────────────────────────

	it("moveField with beforeUuid reorders within the same parent", () => {
		const { mutations, store } = setup(bp);
		mutations.moveField(Q_B, {
			beforeUuid: Q_A,
		});
		expect(children(store, FORM1).map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});
	it("moveField with toIndex reorders to the specified slot", () => {
		const { mutations, store } = setup(bp);
		mutations.moveField(Q_A, {
			toIndex: 1,
		});
		expect(children(store, FORM1).map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	// ── convertField ─────────────────────────────────────────────────────

	describe("convertField", () => {
		it("swaps the kind and reflects the new kind in doc state", () => {
			// Q_A starts as `text`; `text` can convert to `secret` per the registry.
			// Snapshot the pre-dispatch kind and pin the fixture invariant so
			// a future fixture drift (e.g. Q_A seeded as `"secret"`) can't mask
			// a no-op short-circuit inside the reducer — `convertField` returns
			// early when source kind already equals target kind.
			const { mutations, store } = setup(bp);
			const before = store.getState().fields[Q_A]?.kind;
			// Pin the fixture invariant — if this fails the test below doesn't
			// prove anything meaningful about the dispatch.
			expect(before).toBe("text");
			mutations.convertField(Q_A, "secret");
			const after = store.getState().fields[Q_A]?.kind;
			expect(after).toBe("secret");
			// Guard against the reducer no-op path masking a successful dispatch —
			// the kind MUST have changed, not merely equal the target by accident.
			expect(after).not.toBe(before);

			// The field's semantic id should be preserved across the kind swap.
			const converted = store.getState().fields[Q_A];
			expect(converted?.id).toBe("a");
		});
		it("seeds the starter option pair on text → single_select", () => {
			// The select schemas require `.min(2)` options the text source
			// can't carry, and the convert menu has no option-authoring step —
			// the hook attaches the same starter pair a picker-inserted select
			// gets, fully minted (uuid + order) at dispatch so the reducer
			// never invents identity.
			const { mutations, store } = setup(bp);
			expect(store.getState().fields[Q_A]?.kind).toBe("text");
			mutations.convertField(Q_A, "single_select");
			const converted = store.getState().fields[Q_A];
			expect(converted?.kind).toBe("single_select");
			const options =
				converted?.kind === "single_select" &&
				converted.optionsSource.kind === "inline"
					? converted.optionsSource.options
					: [];
			expect(options.map((o) => o.value)).toEqual(["option_1", "option_2"]);
			for (const opt of options) {
				expect(opt.uuid).toBeTruthy();
			}
		});
		it("births text → hidden set once with the inert default, never an inert calculation", () => {
			// HIDDEN_NO_VALUE would reject a bare convert; the gesture seeds
			// the same `''` default a picker-inserted hidden is born with (in
			// the SAME gated batch, after the kind swap), so every offered
			// target lands and the user replaces the expression in the
			// inspector. The seed must be a default and not a calculation: a
			// converted field keeps its case writer, and an inert calculation
			// on a writer to the loaded case would write nothing over the
			// case's value on every submission. It must NOT carry both: a
			// hidden field holds exactly one value source.
			const { mutations, store } = setup(bp);
			mutations.convertField(Q_A, "hidden");
			const converted = store.getState().fields[Q_A];
			expect(converted?.kind).toBe("hidden");
			expect(
				converted && "default_value" in converted
					? converted.default_value
					: undefined,
			).toEqual({
				parts: [
					{
						kind: "text",
						text: "''",
					},
				],
			});
			expect(
				converted && "calculate" in converted ? converted.calculate : undefined,
			).toBeUndefined();
			expect(
				converted && "label" in converted ? converted.label : undefined,
			).toBeUndefined();
		});
		it("keeps a carried starting value as the converted hidden field's only source", () => {
			// A text field with a default converts into a set-once hidden
			// value: the default carries across and no calculation is seeded
			// beside it, so the converted field never holds both slots.
			const withDefault = buildDoc({
				appId: "t",
				appName: "Test",
				modules: [
					{
						uuid: MOD1,
						name: "M0",
						forms: [
							{
								uuid: FORM1,
								name: "F0",
								type: "survey",
								fields: [
									{
										uuid: Q_A,
										kind: "text",
										id: "a",
										label: "A",
										default_value: xp("'seed'"),
									},
								],
							},
						],
					},
				],
			});
			const { mutations, store } = setup(withDefault);
			mutations.convertField(Q_A, "hidden");
			const converted = store.getState().fields[Q_A];
			expect(converted?.kind).toBe("hidden");
			expect(
				converted && "default_value" in converted
					? converted.default_value
					: undefined,
			).toEqual(xp("'seed'"));
			expect(
				converted && "calculate" in converted ? converted.calculate : undefined,
			).toBeUndefined();
		});
		it("no-ops silently when uuid is unknown", () => {
			// An unrecognized uuid must not throw and must leave the store
			// unchanged — matches the fail-open contract the other mutation
			// methods follow. The hook also promises a `console.warn` on
			// every unresolved uuid (`console`, NOT the structured logger:
			// this hook is client-only and the logger's production path
			// throws in the browser). That warning is the ONLY observability
			// the fail-open contract offers, so we spy on it here to lock
			// the contract against a future refactor dropping the
			// `warnUnresolved` call.
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { mutations, store } = setup(bp);
			const before = store.getState().fields[Q_A]?.kind;
			expect(() => {
				mutations.convertField(testUuid("bogus-uuid-convert"), "secret");
			}).not.toThrow();

			// Existing field is untouched.
			const after = store.getState().fields[Q_A]?.kind;
			expect(after).toBe(before);
			// Order is also unchanged.
			expect(children(store, FORM1).map((q) => q.id)).toEqual([
				"a",
				"b",
				"grp",
			]);

			// Lock the fail-open contract: the warn must fire and include both
			// `uuid` and `toKind` so a dev debugging a silent no-op can tell
			// which call site produced it.
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(
					"[useBlueprintMutations.convertField] unresolved uuid",
				),
				expect.objectContaining({
					uuid: testUuid("bogus-uuid-convert"),
					toKind: "secret",
				}),
			);
			warn.mockRestore();
		});
	});

	// ── Unresolved uuid no-op ─────────────────────────────────────────────

	it("unresolved uuid silently no-ops (no throw)", () => {
		// Every unresolved dispatch console.warns; silence the expected
		// noise while keeping the no-throw + unchanged-store assertions.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { mutations, store } = setup(bp);
		expect(() => {
			// Bogus uuids should all silently no-op.
			mutations.updateField(testUuid("bogus-uuid"), "text", {
				label: proseText("x"),
			});
			mutations.removeField(testUuid("bogus-uuid"));
			mutations.renameField(testUuid("bogus-uuid"), "also_nope");
			mutations.moveField(testUuid("bogus-uuid"), {});
			mutations.duplicateField(testUuid("bogus-uuid"));
			mutations.addField(testUuid("bogus-parent"), {
				id: "should_not_exist",
				kind: "text",
				label: proseText("Nope"),
			});
			mutations.updateForm(testUuid("bogus-uuid"), {
				name: "nope",
			});
			mutations.removeForm(testUuid("bogus-uuid"));
			mutations.updateModule(testUuid("bogus-uuid"), {
				name: "nope",
			});
			mutations.removeModule(testUuid("bogus-uuid"));
			mutations.addForm(testUuid("bogus-module"), {
				uuid: "form-6-uuid",
				id: "nope",
				name: "nope",
				type: "survey",
			});
		}).not.toThrow();
		warn.mockRestore();

		// Store should be unchanged.
		expect(children(store, FORM1).map((q) => q.id)).toEqual(["a", "b", "grp"]);
	});
});

// ── Commit gate (complete phase) ──────────────────────────────────────────
//
// The dedicated gating coverage. The
// verdict semantics themselves are pinned in
// `lib/doc/__tests__/commitVerdicts.test.ts`; what must hold HERE is the
// command admission: a rejected dispatch never reaches the store, the method
// returns its no-op shape, and the rejection surfaces as an error toast.

describe("Builder command admission", () => {
	it("rejects an edit whose complete candidate has a finding: store untouched, no-op return, error toast", () => {
		toastStore.clear();
		const { mutations, store } = setup(bp);
		let returned = {
			ok: true,
			uuid: "unset" as Uuid,
		} as AddCommitOutcome;
		{
			const s = store.getState();
			assert(s);
			// The resulting candidate has an empty survey form, so the absolute
			// gate rejects its EMPTY_FORM finding.
			returned = mutations.addForm(s.moduleOrder[0], {
				uuid: testUuid("form-gated-uuid"),
				id: "gated",
				name: "Gated",
				type: "survey",
			});
		}

		// The rejection is honest — no fabricated uuid, the findings ride
		// along for inline display.
		assert(!returned.ok);
		expect(returned.messages[0]).toContain("doesn't have any fields");
		const s = store.getState();
		expect(s?.forms[testUuid("form-gated-uuid")]).toBeUndefined();
		// The rejection surfaced person-to-person, not silently — each
		// finding rides the toast's structured lines.
		const toast = toastStore.toasts.at(-1);
		expect(toast?.severity).toBe("error");
		expect(toast?.title).toBe("Change not applied");
		expect(toast?.lines?.[0]).toContain("doesn't have any fields");
		toastStore.clear();
	});
	it("inline flavor: same rejection, same no-op return, NO toast (the caller presents it)", () => {
		toastStore.clear();
		const { mutations, store } = setup(bp);
		let returned = {
			ok: true,
			uuid: "unset" as Uuid,
		} as AddCommitOutcome;
		{
			const s = store.getState();
			assert(s);
			returned = mutations.inline.addForm(s.moduleOrder[0], {
				uuid: testUuid("form-gated-inline-uuid"),
				id: "gated_inline",
				name: "Gated Inline",
				type: "survey",
			});
		}

		// Identical gate semantics — findings returned for the caller's
		// contextual surface…
		assert(!returned.ok);
		expect(returned.messages[0]).toContain("doesn't have any fields");
		const s = store.getState();
		expect(s?.forms[testUuid("form-gated-inline-uuid")]).toBeUndefined();
		// …and the toast stays quiet: one rejection, one presentation.
		expect(toastStore.toasts).toHaveLength(0);
	});
	it("reviews the exact candidate without committing it", () => {
		toastStore.clear();
		const { mutations, store } = setup(bp);
		const formUuid = testUuid("form-reviewed-without-commit");
		const state = store.getState();
		assert(state);
		const outcome = mutations.inline.reviewMany([
			{
				kind: "addForm",
				moduleUuid: state.moduleOrder[0],
				form: {
					uuid: formUuid,
					id: "reviewed",
					name: "Reviewed",
					type: "survey",
				},
				after: null,
			},
		]);
		assert(!outcome.ok);
		expect(outcome.messages[0]).toContain("doesn't have any fields");
		expect(outcome.findings?.[0]).toMatchObject({
			code: "EMPTY_FORM",
			scope: "form",
			location: {
				formUuid,
			},
		});
		expect(store.getState().forms[formUuid]).toBeUndefined();
		expect(toastStore.toasts).toHaveLength(0);
	});
	it("returns a passing review without changing the live document", () => {
		const { mutations, store } = setup(bp);
		const outcome = mutations.inline.reviewMany([
			{
				kind: "setAppName",
				name: "Reviewed name",
			},
		]);
		expect(outcome).toEqual({
			ok: true,
		});
		expect(store.getState().appName).toBe("Test");
	});
	it("dispatches a clean edit unchanged (the gate is transparent on pass)", () => {
		toastStore.clear();
		const { mutations, store } = setup(bp);
		{
			const s = store.getState();
			assert(s);
			mutations.updateModule(s.moduleOrder[0], {
				name: "Renamed Module",
			});
		}
		const s = store.getState();
		assert(s);
		expect(s.modules[s.moduleOrder[0]]?.name).toBe("Renamed Module");
		expect(toastStore.toasts).toHaveLength(0);
	});
	it("retains structured automation findings for an inline gate refusal", () => {
		const automationUuid = testUuid("hook-gate-automation");
		const updateUuid = testUuid("hook-gate-update");
		const automation: Automation = {
			uuid: automationUuid,
			kind: "case-update",
			name: "Existing rule",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: updateUuid,
					target: {
						scope: "case",
						property: "state",
					},
					value: {
						kind: "literal",
						value: "resolved",
					},
				},
			],
			closeCase: false,
		};
		const automationDoc: BlueprintDoc = {
			...bp,
			caseTypes: [
				{
					name: "visit",
					properties: [
						{
							name: "state",
							label: proseText("State"),
							data_type: "text",
						},
					],
				},
			],
			automations: {
				[automationUuid]: automation,
			},
			automationOrder: [automationUuid],
		};
		const { mutations, store } = setup(automationDoc);
		const duplicateUuid = testUuid("hook-gate-automation-duplicate");
		const outcome = mutations.inline.addAutomation({
			...automation,
			uuid: duplicateUuid,
			updates: [
				{
					...automation.updates[0],
					uuid: testUuid("hook-gate-update-duplicate"),
				},
			],
		});
		assert(!outcome.ok);
		expect(outcome.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "AUTOMATION_INVALID",
					details: {
						automationUuid: duplicateUuid,
						path: "name",
					},
				}),
			]),
		);
		expect(store.getState().automations?.[duplicateUuid]).toBeUndefined();
	});
	it("atomically refuses stale full automation replacement and removal", () => {
		const automationUuid = testUuid("hook-automation");
		const updateUuid = testUuid("hook-automation-update");
		const automation: Automation = {
			uuid: automationUuid,
			kind: "case-update",
			name: "Original rule",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: updateUuid,
					target: {
						scope: "case",
						property: "state",
					},
					value: {
						kind: "literal",
						value: "resolved",
					},
				},
			],
			closeCase: false,
		};
		const automationDoc: BlueprintDoc = {
			...bp,
			caseTypes: [
				{
					name: "visit",
					properties: [
						{
							name: "state",
							label: proseText("State"),
							data_type: "text",
						},
					],
				},
			],
			automations: {
				[automationUuid]: automation,
			},
			automationOrder: [automationUuid],
		};
		const { mutations, store } = setup(automationDoc);
		const openedFingerprint = JSON.stringify(automation);
		mutations.updateAutomation({
			uuid: automationUuid,
			targetKind: "case-update",
			patch: {
				name: "Peer rename",
			},
		});
		const replaceOutcome = mutations.replaceAutomation(
			{
				...automation,
				name: "My rename",
			},
			openedFingerprint,
		);
		const removeOutcome = mutations.removeAutomation(
			automationUuid,
			openedFingerprint,
		);
		expect(replaceOutcome).toMatchObject({
			ok: false,
			messages: [expect.stringContaining("changed while you were editing")],
		});
		expect(removeOutcome).toMatchObject({
			ok: false,
			messages: [expect.stringContaining("changed while you were editing")],
		});
		expect(store.getState().automations?.[automationUuid]?.name).toBe(
			"Peer rename",
		);
	});
	it("captures the current automation kind in a successful Builder removal", () => {
		const automationUuid = testUuid("hook-remove-automation");
		const automation: Automation = {
			uuid: automationUuid,
			kind: "case-update",
			name: "Remove this rule",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: testUuid("hook-remove-automation-update"),
					target: {
						scope: "case",
						property: "state",
					},
					value: {
						kind: "literal",
						value: "resolved",
					},
				},
			],
			closeCase: false,
		};
		const automationDoc: BlueprintDoc = {
			...bp,
			caseTypes: [
				{
					name: "visit",
					properties: [
						{
							name: "state",
							label: proseText("State"),
							data_type: "text",
						},
					],
				},
			],
			automations: {
				[automationUuid]: automation,
			},
			automationOrder: [automationUuid],
		};
		const { mutations, store } = setup(automationDoc);
		mutations.removeAutomation(automationUuid, JSON.stringify(automation));
		expect(store.getState().automations).toBeUndefined();
		expect(store.getState().takeCommandBatches()).toEqual([
			[
				{
					kind: "removeAutomation",
					uuid: automationUuid,
					targetKind: "case-update",
				},
			],
		]);
	});
});
