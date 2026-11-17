/**
 * The structural lookups a whole-document pass makes once per form, field or
 * carrier answer from one derivation per settled document part. Each fast
 * path must give exactly the answer of the scan it replaced, on every shape a
 * reducer can leave behind (a form under two menus, a menu `moduleOrder` does
 * not name, a key `Object.prototype` holds), and must never answer for an
 * Immer draft or an object still open to a write: a stale answer there would
 * be a wrong commit verdict. The scans are written out here as the code they
 * replaced, so the oracle is independent of the paths under test.
 */
import * as fc from "fast-check";
import { freeze, produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { caseSlotFacts } from "@/lib/domain/basicCaseSlots";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	firstModuleListingForm,
	firstOrderedModuleListingForm,
	firstSortedModuleListingForm,
	modulesListingForm,
} from "@/lib/domain/formMembership";
import { isDeeplySettled, isSettled } from "@/lib/domain/settled";
import { expectScreensAgree, scan } from "./structuralScans";

// ── Membership ──────────────────────────────────────────────────────

/** Module keys, among them names an ordinary record reads through its
 *  prototype and an integer-like key, which `Object.entries` lists first. */
const MODULE_KEYS = [
	testUuid("lookup-m0"),
	testUuid("lookup-m1"),
	testUuid("lookup-m2"),
	testUuid("lookup-m3"),
	"10",
	"__proto__",
	"constructor",
] as const;
const FORM_KEYS = [
	testUuid("lookup-f0"),
	testUuid("lookup-f1"),
	testUuid("lookup-f2"),
	testUuid("lookup-f3"),
	"10",
] as const;

type Shape = {
	readonly entries: readonly (readonly [string, readonly string[]])[];
	readonly moduleOrder: readonly string[];
	readonly nullPrototype: boolean;
};

const shapeArb: fc.Arbitrary<Shape> = fc.record({
	entries: fc.array(
		fc.tuple(
			fc.constantFrom(...MODULE_KEYS),
			fc.array(fc.constantFrom(...FORM_KEYS), { maxLength: 5 }),
		),
		{ maxLength: 6 },
	),
	moduleOrder: fc.array(fc.constantFrom(...MODULE_KEYS), { maxLength: 7 }),
	nullPrototype: fc.boolean(),
});

/** A `formOrder` record as `shape` spells it, built by definition so that
 *  `__proto__` is an own key wherever the shape names it. */
function formOrderOf(shape: Shape): Record<string, string[]> {
	const record: Record<string, string[]> = shape.nullPrototype
		? Object.create(null)
		: {};
	for (const [key, forms] of shape.entries)
		Object.defineProperty(record, key, {
			value: [...forms],
			enumerable: true,
			writable: true,
			configurable: true,
		});
	return record;
}

/** The answer, or that the lookup threw: an ordinary record read by an
 *  inherited name makes the scans call a method that is not there. */
function outcome<T>(run: () => T): { value: T } | { threw: true } {
	try {
		return { value: run() };
	} catch {
		return { threw: true };
	}
}

function expectMembershipAgrees(
	formOrder: Record<string, readonly string[]>,
	moduleOrder: readonly string[],
	expected: Record<string, readonly string[]>,
	expectedOrder: readonly string[],
): void {
	for (const form of [...FORM_KEYS, testUuid("lookup-absent")]) {
		expect(outcome(() => firstModuleListingForm(formOrder, form))).toEqual(
			outcome(() => scan.first(expected, form)),
		);
		expect(outcome(() => [...modulesListingForm(formOrder, form)])).toEqual(
			outcome(() => scan.all(expected, form)),
		);
		expect(
			outcome(() => firstSortedModuleListingForm(formOrder, form)),
		).toEqual(outcome(() => scan.sorted(expected, form)));
		expect(
			outcome(() =>
				firstOrderedModuleListingForm({ formOrder, moduleOrder }, form),
			),
		).toEqual(
			outcome(() =>
				scan.ordered({ formOrder: expected, moduleOrder: expectedOrder }, form),
			),
		);
	}
}

describe("which menus list a form", () => {
	it("answers as the scan does, whether the record is open, settled or a draft", async () => {
		await fc.assert(
			fc.property(shapeArb, (shape) => {
				const open = formOrderOf(shape);
				const order = [...shape.moduleOrder];
				expectMembershipAgrees(open, order, formOrderOf(shape), order);

				const settled = freeze(formOrderOf(shape), true);
				const settledOrder = Object.freeze([...shape.moduleOrder]);
				expect(isSettled(settled)).toBe(true);
				// Asked twice: the second answer is the remembered one.
				expectMembershipAgrees(settled, settledOrder, settled, settledOrder);
				expectMembershipAgrees(settled, settledOrder, settled, settledOrder);

				// A draft of the settled record, written before it is asked.
				const base = { formOrder: settled, moduleOrder: settledOrder };
				produce(base, (draft) => {
					const [first] = shape.entries;
					if (first !== undefined)
						draft.formOrder[first[0]]?.push(FORM_KEYS[0]);
					draft.moduleOrder.reverse();
					const snapshot = {
						formOrder: JSON.parse(
							JSON.stringify(Object.entries(draft.formOrder)),
						) as [string, string[]][],
						moduleOrder: [...draft.moduleOrder],
					};
					const expected: Record<string, string[]> = shape.nullPrototype
						? Object.create(null)
						: {};
					for (const [key, forms] of snapshot.formOrder)
						Object.defineProperty(expected, key, {
							value: forms,
							enumerable: true,
							writable: true,
							configurable: true,
						});
					expectMembershipAgrees(
						draft.formOrder as Record<string, readonly string[]>,
						draft.moduleOrder,
						expected,
						snapshot.moduleOrder,
					);
				});
			}),
			{ numRuns: 300, seed: 20261115 },
		);
	});

	it("answers an open record's change after a question was asked of it", () => {
		const form = testUuid("lookup-f0");
		const a = testUuid("lookup-m0");
		const b = testUuid("lookup-m1");
		const formOrder: Record<string, string[]> = Object.create(null);
		formOrder[a] = [form];
		formOrder[b] = [];
		expect(firstModuleListingForm(formOrder, form)).toBe(a);
		formOrder[a] = [];
		formOrder[b]?.push(form);
		expect(firstModuleListingForm(formOrder, form)).toBe(b);
		expect(
			firstOrderedModuleListingForm({ formOrder, moduleOrder: [a, b] }, form),
		).toBe(b);
	});
});

describe("whether a part can still change", () => {
	it("is settled only where every object it holds is frozen and no draft", () => {
		const inner = { forms: [testUuid("lookup-f0")] };
		const outer = Object.freeze({ inner });
		expect(isDeeplySettled(outer)).toBe(false);
		Object.freeze(inner);
		expect(isDeeplySettled(outer)).toBe(false);
		Object.freeze(inner.forms);
		expect(isDeeplySettled(outer)).toBe(true);
		expect(
			isDeeplySettled(Object.freeze({ map: Object.freeze(new Map()) })),
		).toBe(false);
		produce({ part: freeze({ a: [1] }, true) }, (draft) => {
			expect(isSettled(draft.part)).toBe(false);
			expect(isDeeplySettled(draft.part)).toBe(false);
		});
	});
});

// ── Menu screens ────────────────────────────────────────────────────

type MenuSpec = {
	readonly forms: number;
	readonly parent: number | null;
	readonly above: boolean;
	readonly caseListItem: boolean;
	readonly registration: boolean;
};

const menusArb = fc.record({
	menus: fc.array(
		fc.record({
			forms: fc.integer({ min: 0, max: 3 }),
			parent: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
			above: fc.boolean(),
			caseListItem: fc.boolean(),
			registration: fc.boolean(),
		}),
		{ minLength: 1, maxLength: 6 },
	),
	reorder: fc.boolean(),
});

/** A document of `menus`, its parents and flags as given whether or not the
 *  validator would admit them: the screens are a total projection. */
function menusDoc(spec: {
	menus: readonly MenuSpec[];
	reorder: boolean;
}): BlueprintDoc {
	const uuidOf = (index: number) => testUuid(`screens-m${index}`);
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: spec.menus.map((menu, index) => ({
			uuid: `screens-m${index}`,
			name: `Menu ${index}`,
			caseType: "patient",
			...(menu.caseListItem && { caseListMenuItem: {} }),
			...(menu.registration &&
				menu.forms > 0 && {
					caseListRegistrationForm: { formUuid: `screens-m${index}-f0` },
				}),
			forms: Array.from({ length: menu.forms }, (_, form) => ({
				uuid: `screens-m${index}-f${form}`,
				name: `Form ${index} ${form}`,
				type: form === 0 ? ("registration" as const) : ("followup" as const),
			})),
		})),
	});
	/* Written after the build, which holds the document to the topology
	 * the validator admits: a parent may be missing, or a child itself. */
	spec.menus.forEach((menu, index) => {
		const mod = doc.modules[uuidOf(index)];
		if (mod === undefined) return;
		if (menu.parent !== null && menu.parent !== index)
			mod.parentModuleUuid = uuidOf(menu.parent);
		if (menu.above) mod.formsInMenuAbove = true;
	});
	if (spec.reorder) doc.moduleOrder.reverse();
	return doc;
}

describe("what each menu screen lists", () => {
	it("lists what one walk per question lists, whether the document is open, settled or a draft", async () => {
		await fc.assert(
			fc.property(menusArb, (spec) => {
				const open = menusDoc(spec);
				expectScreensAgree(open, open);

				const settled = produce(menusDoc(spec), () => {});
				expect(Object.isFrozen(settled.modules)).toBe(true);
				expectScreensAgree(settled, settled);
				expectScreensAgree(settled, settled);

				// A draft written between two questions: the second answer is
				// the draft's, never the settled document's.
				produce(settled, (draft) => {
					const doc = draft as unknown as BlueprintDoc;
					expectScreensAgree(doc, doc);
					const [first] = Object.values(draft.modules);
					if (first?.formsInMenuAbove === true) delete first.formsInMenuAbove;
					else if (first !== undefined) first.formsInMenuAbove = true;
					draft.moduleOrder.reverse();
					expectScreensAgree(doc, doc);
				});
			}),
			{ numRuns: 200, seed: 20261116 },
		);
	});
});

// ── The case types the modules name ─────────────────────────────────

describe("the case types a form's case slots read", () => {
	function twoMenus(): BlueprintDoc {
		return buildDoc({
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "household", properties: [] },
			],
			modules: [
				{
					uuid: "slots-m0",
					name: "Patients",
					caseType: "patient",
					forms: [{ uuid: "slots-f0", name: "Visit", type: "followup" }],
				},
				{
					uuid: "slots-m1",
					name: "Households",
					caseType: "household",
					forms: [{ uuid: "slots-f1", name: "Check", type: "followup" }],
				},
			],
		});
	}
	const f0 = testUuid("slots-f0");
	const f1 = testUuid("slots-f1");
	const m1 = testUuid("slots-m1");

	it("follows an open document's module changed in place after another form was asked", () => {
		const doc = twoMenus();
		expect([...caseSlotFacts(doc, f0).moduleCaseTypes].sort()).toEqual([
			"household",
			"patient",
		]);
		const changed = doc.modules[m1];
		if (changed === undefined) throw new Error("fixture lost its menu");
		changed.caseType = "visit";
		expect([...caseSlotFacts(doc, f1).moduleCaseTypes].sort()).toEqual([
			"patient",
			"visit",
		]);
	});

	it("is one answer for every form of a settled document, and a draft's own", () => {
		const settled = produce(twoMenus(), () => {});
		const first = caseSlotFacts(settled, f0).moduleCaseTypes;
		expect(caseSlotFacts(settled, f1).moduleCaseTypes).toBe(first);
		expect([...first].sort()).toEqual(["household", "patient"]);
		produce(settled, (draft) => {
			const doc = draft as unknown as BlueprintDoc;
			expect([...caseSlotFacts(doc, f0).moduleCaseTypes].sort()).toEqual([
				"household",
				"patient",
			]);
			const changed = draft.modules[m1];
			if (changed !== undefined) changed.caseType = "visit";
			expect([...caseSlotFacts(doc, f1).moduleCaseTypes].sort()).toEqual([
				"patient",
				"visit",
			]);
		});
	});
});
