/**
 * The live engine and a form that becomes sectioned under it.
 *
 * Splitting a form into pages is one batch (a section added, the questions
 * moved under it) applied to a form whose engine is already running. The
 * controller reconciles the moved paths without rebuilding, so the page
 * model the pager reads and the validation it runs have to be right against
 * that reconciled state: the moved question keeps its required flag at its
 * new path, the page list follows the new root, and Next refuses exactly
 * as it would on a fresh load.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { splitIntoSections } from "@/lib/doc/formSectionMutations";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";
import { EngineController } from "../engineController";

const MODULE_UUID = testUuid("module-1-uuid");
const FORM_UUID = testUuid("form-1-uuid");
const Q1_UUID = testUuid("q1");
const Q2_UUID = testUuid("q2");
const SECTION_A = testUuid("section-a");
const SECTION_B = testUuid("section-b");

function makeDoc(): PersistableDoc {
	const fields: Record<string, Field> = {
		[Q1_UUID]: {
			uuid: Q1_UUID,
			id: "name",
			kind: "text",
			label: proseText("Name"),
			required: xp("true()"),
		},
		[Q2_UUID]: {
			uuid: Q2_UUID,
			id: "age",
			kind: "int",
			label: proseText("Age"),
		},
	};
	return {
		appId: "test-app",
		appName: "Test App",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: { uuid: MODULE_UUID, id: "module-1", name: "Module 1" },
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
		fieldOrder: { [FORM_UUID]: [Q1_UUID, Q2_UUID] } as Record<string, Uuid[]>,
	};
}

function liveController() {
	const store = createBlueprintDocStore();
	store.getState().load(makeDoc());
	store.getState().startTracking();
	const ctrl = new EngineController();
	ctrl.setDocStore(store);
	ctrl.activateForm(FORM_UUID);
	return { store, ctrl };
}

function splitLive(store: ReturnType<typeof createBlueprintDocStore>) {
	const plan = splitIntoSections(
		store.getState() as unknown as BlueprintDoc,
		FORM_UUID,
		{
			atFieldUuid: Q2_UUID,
			sectionUuids: [SECTION_A, SECTION_B],
		},
	);
	if (!plan.ok) throw new Error(plan.reason);
	store.getState().applyMany([...plan.mutations]);
}

describe("EngineController with a form split into pages while it runs", () => {
	it("lists the new pages and keeps the moved question's required flag", () => {
		const { store, ctrl } = liveController();
		expect(ctrl.sectionPages()).toEqual([]);

		splitLive(store);

		expect(ctrl.sectionPages().map((page) => page.uuid)).toEqual([
			SECTION_A,
			SECTION_B,
		]);
		expect(ctrl.sectionPages().map((page) => page.hasVisibleQuestions)).toEqual(
			[true, true],
		);
		const runtime = ctrl.store.getState();
		expect(runtime[Q1_UUID].required).toBe(true);
	});

	it("refuses Next on the page whose required question is blank, exactly as on a fresh load", () => {
		const { store, ctrl } = liveController();
		splitLive(store);

		expect(ctrl.validateSection(SECTION_A)).toBe(false);
		expect(ctrl.firstInvalidFieldTarget({ withinSection: SECTION_A })).toEqual({
			fieldUuid: Q1_UUID,
			instancePath: "/data/section_1/name",
			ancestorUuids: [SECTION_A],
		});
		expect(ctrl.validateSection(SECTION_B)).toBe(true);

		const fresh = new EngineController();
		fresh.setDocStore(store);
		fresh.activateForm(FORM_UUID);
		expect(fresh.validateSection(SECTION_A)).toBe(false);
	});

	it("follows a required flag switched on while the engine runs, on one page or many", () => {
		/* A constant `required` never enters the trigger DAG, so before the
		 * controller re-seeded it an author's toggle reached the live form
		 * only on the next rebuild: Submit and Next both let the blank
		 * through. The single-page form pins the original symptom. */
		const flat = liveController();
		flat.store.getState().applyMany([
			{
				kind: "updateField",
				uuid: Q2_UUID,
				targetKind: "int",
				patch: { required: xp("true()") },
			},
		]);
		expect(flat.ctrl.store.getState()[Q2_UUID].required).toBe(true);
		expect(flat.ctrl.validateAll()).toBe(false);

		const { store, ctrl } = liveController();
		splitLive(store);
		store.getState().applyMany([
			{
				kind: "updateField",
				uuid: Q2_UUID,
				targetKind: "int",
				patch: { required: xp("true()") },
			},
		]);
		expect(store.getState().fields[Q2_UUID]).toMatchObject({
			required: xp("true()"),
		});
		expect(ctrl.store.getState()[Q2_UUID].required).toBe(true);
		expect(ctrl.validateSection(SECTION_B)).toBe(false);
		store.getState().applyMany([
			{
				kind: "updateField",
				uuid: Q2_UUID,
				targetKind: "int",
				patch: { required: null },
			},
		]);
		expect(ctrl.validateSection(SECTION_B)).toBe(true);
	});
});
