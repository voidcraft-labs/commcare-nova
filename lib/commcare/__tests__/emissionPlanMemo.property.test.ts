/**
 * `emissionPlan` remembers the plan of a settled document, which every
 * per-form projection over the plan's document then shares. The remembered
 * plan must be the plan a fresh derivation gives, and a document that can
 * still change (an open object, an Immer draft) must get a fresh plan each
 * time, or a later write would be emitted under an earlier plan.
 */
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import type { BlueprintDoc } from "@/lib/domain";

const hostsArb = fc.array(
	fc.record({
		forms: fc.integer({ min: 0, max: 3 }),
		readsSearch: fc.boolean(),
		registration: fc.boolean(),
		caseType: fc.boolean(),
	}),
	{ minLength: 1, maxLength: 5 },
);

function hostsDoc(hosts: readonly HostSpec[]): BlueprintDoc {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: hosts.map((host, index) => ({
			uuid: `plan-m${index}`,
			name: `Menu ${index}`,
			...(host.caseType && { caseType: "patient" }),
			...(host.readsSearch && {
				caseSearchConfig: { formsReadSearch: true as const },
			}),
			...(host.registration &&
				host.forms > 0 && {
					caseListRegistrationForm: { formUuid: `plan-m${index}-f0` },
				}),
			forms: Array.from({ length: host.forms }, (_, form) => ({
				uuid: `plan-m${index}-f${form}`,
				name: `Form ${index} ${form}`,
				type: form === 0 ? ("registration" as const) : ("followup" as const),
			})),
		})),
	});
}

type HostSpec = {
	forms: number;
	readsSearch: boolean;
	registration: boolean;
	caseType: boolean;
};

/** The plan with its maps as plain entries, for comparison. */
function planOf(doc: BlueprintDoc) {
	const plan = emissionPlan(doc);
	return {
		doc: {
			modules: plan.doc.modules,
			moduleOrder: plan.doc.moduleOrder,
			formOrder: plan.doc.formOrder,
		},
		synthetic: [...plan.synthetic],
		caseListRegistrationOf: [...plan.caseListRegistrationOf],
	};
}

describe("the emission plan of a document", () => {
	it("is the fresh plan, remembered only for a settled document", async () => {
		await fc.assert(
			fc.property(hostsArb, (hosts) => {
				const open = hostsDoc(hosts);
				const fresh = planOf(open);
				// An open document gets a new plan each time it is asked.
				expect(emissionPlan(open)).not.toBe(emissionPlan(open));

				const settled = produce(hostsDoc(hosts), () => {});
				expect(planOf(settled)).toEqual(fresh);
				const remembered = emissionPlan(settled);
				expect(emissionPlan(settled)).toBe(remembered);
				expect(Object.isFrozen(remembered.doc.formOrder)).toBe(true);

				// A draft written after a question was asked of it.
				produce(settled, (draft) => {
					const doc = draft as unknown as BlueprintDoc;
					expect(planOf(doc)).toEqual(fresh);
					const [moduleUuid] = draft.moduleOrder;
					if (moduleUuid === undefined) return;
					const mod = draft.modules[moduleUuid];
					if (mod === undefined) return;
					mod.caseSearchConfig = { formsReadSearch: true };
					mod.caseType = "patient";
					expect(planOf(doc)).toEqual(
						planOf(JSON.parse(JSON.stringify(doc)) as BlueprintDoc),
					);
				});
			}),
			{ numRuns: 150, seed: 20261117 },
		);
	});

	it("lowers a case list registration form into the module it plans", () => {
		const doc = produce(
			hostsDoc([
				{ forms: 2, readsSearch: true, registration: true, caseType: true },
			]),
			() => {},
		);
		const plan = emissionPlan(doc);
		expect(plan.synthetic.size).toBe(1);
		expect(plan.doc.moduleOrder).toHaveLength(2);
		expect(plan.doc.formOrder[testUuid("plan-m0")]).toEqual([
			testUuid("plan-m0-f1"),
		]);
	});
});
