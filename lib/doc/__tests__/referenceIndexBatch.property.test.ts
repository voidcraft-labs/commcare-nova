/**
 * A batch of mutations keeps each form's module while it maintains the
 * reference index (`ReferenceIndexBatch.moduleOf`), and drops or extends that
 * answer as the batch's reducers write `formOrder`. The answer must be the one
 * a scan of the current `formOrder` gives after every mutation of a batch that
 * mixes every reducer writing it: a module added again over one that lists
 * forms, a form added again under another menu, moved, removed, and a module
 * removed. A `formOrder` key no module holds is no shape a reducer reaches
 * (`rebuildFieldParent` refuses it at the batch's end), so none is seeded. The scan is the code the batch replaced (`resolveFormModule`),
 * written out here so the oracle is independent of the path under test. The
 * same batches, applied as one, leave an index equal to a fresh build.
 */
import * as fc from "fast-check";
import { type Draft, produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import {
	buildReferenceIndex,
	ReferenceIndexBatch,
} from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, type Uuid, uuidSchema } from "@/lib/domain";

const M0 = testUuid("batch-m0");
const M1 = testUuid("batch-m1");
const M2 = testUuid("batch-m2");
const M3 = testUuid("batch-m3");
const F0 = testUuid("batch-f0");
const F1 = testUuid("batch-f1");
const F2 = testUuid("batch-f2");
const F3 = testUuid("batch-f3");
const F4 = testUuid("batch-f4");
const F5 = testUuid("batch-f5");
const MODULES = [M0, M1, M2, M3] as const;
const FORMS = [F0, F1, F2, F3, F4, F5] as const;

/** The module a form resolved to before the batch kept it: the first key in
 *  `formOrder`'s entry order that lists the form and is a UUID. */
function resolveFormModule(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Uuid | undefined {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) {
			const parsed = uuidSchema.safeParse(moduleUuid);
			if (parsed.success) return parsed.data;
		}
	}
	return undefined;
}

function seedDoc(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{ name: "patient", properties: [] },
			{ name: "household", properties: [] },
		],
		modules: [
			{
				uuid: "batch-m0",
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: "batch-f0",
						name: "Visit",
						type: "followup",
						formLinks: [
							{
								target: {
									type: "form",
									moduleUuid: testUuid("batch-m1"),
									formUuid: testUuid("batch-f2"),
								},
							},
						],
					},
					{ uuid: "batch-f1", name: "Review", type: "followup" },
				],
			},
			{
				uuid: "batch-m1",
				name: "Households",
				caseType: "household",
				forms: [{ uuid: "batch-f2", name: "Check", type: "followup" }],
			},
			{
				uuid: "batch-m2",
				name: "More patients",
				caseType: "patient",
				forms: [{ uuid: "batch-f3", name: "Survey", type: "survey" }],
			},
		],
	});
	doc.refIndex = buildReferenceIndex(doc);
	return doc;
}

const kinds = [
	"addModule",
	"addForm",
	"moveForm",
	"removeForm",
	"removeModule",
	"renameMenu",
] as const;
type Kind = (typeof kinds)[number];
type Op = {
	readonly kind: Kind;
	readonly module: number;
	readonly form: number;
	readonly ask: boolean;
};
const opArb: fc.Arbitrary<Op> = fc.record({
	kind: fc.constantFrom(...kinds),
	module: fc.integer({ min: 0, max: MODULES.length - 1 }),
	form: fc.integer({ min: 0, max: FORMS.length - 1 }),
	ask: fc.boolean(),
});

function lower(seed: BlueprintDoc, op: Op): Mutation {
	const moduleUuid = MODULES[op.module] as Uuid;
	const formUuid = FORMS[op.form] as Uuid;
	switch (op.kind) {
		case "addModule": {
			const template = seed.modules[M2];
			if (template === undefined) throw new Error("fixture lost a menu");
			return {
				kind: "addModule",
				module: {
					...structuredClone(template),
					uuid: moduleUuid,
					id: `menu_${op.module}`,
				},
			};
		}
		case "addForm": {
			const template = seed.forms[F3];
			if (template === undefined) throw new Error("fixture lost a form");
			return {
				kind: "addForm",
				moduleUuid,
				form: {
					...structuredClone(template),
					uuid: formUuid,
					id: `form_${op.form}`,
				},
			};
		}
		case "moveForm":
			return {
				kind: "moveForm",
				uuid: formUuid,
				toModuleUuid: moduleUuid,
				after: null,
			};
		case "removeForm":
			return { kind: "removeForm", uuid: formUuid };
		case "removeModule":
			return { kind: "removeModule", uuid: moduleUuid };
		case "renameMenu":
			return {
				kind: "renameModule",
				uuid: moduleUuid,
				newId: `menu_renamed_${op.form}`,
			};
	}
}

/** Whether `error` is the batch's end refusing a topology its reducers left. */
function topologyRefusal(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith("[rebuildFieldParent] invalid blueprint topology")
	);
}

/** Whether a mutation of `mutations` adds a module or a form whose identity
 *  stands when it runs, which identity admission refuses. */
function bornOverStanding(
	seed: BlueprintDoc,
	mutations: readonly Mutation[],
): boolean {
	const standing = new Set<string>([
		...Object.keys(seed.modules),
		...Object.keys(seed.forms),
	]);
	for (const mutation of mutations) {
		const born =
			mutation.kind === "addModule"
				? mutation.module.uuid
				: mutation.kind === "addForm"
					? mutation.form.uuid
					: undefined;
		if (born !== undefined) {
			if (standing.has(born)) return true;
			standing.add(born);
		}
	}
	return false;
}

/**
 * One mutation through `applyMutations`, its reducers' result kept where the
 * batch's end refuses the topology they left: inside a longer batch that end
 * comes later, and the batch's own keeper answers through the state between.
 * A module added again over one that lists forms leaves those forms unlisted.
 */
function applyStep(draft: Draft<BlueprintDoc>, mutation: Mutation): void {
	try {
		applyMutations(draft, [mutation]);
	} catch (error) {
		if (!topologyRefusal(error)) throw error;
	}
}

function expectModulesAgree(batch: ReferenceIndexBatch, doc: BlueprintDoc) {
	for (const formUuid of FORMS)
		expect(batch.moduleOf(doc, formUuid)).toBe(
			resolveFormModule(doc, formUuid),
		);
}

describe("the module a batch keeps for each form", () => {
	it("is the scan's answer after every mutation of a mixed batch, in a draft and over settled documents", async () => {
		const seed = seedDoc();
		const ran = new Map<Kind, number>(kinds.map((kind) => [kind, 0]));
		let addedOverForms = 0;
		let wholeBatches = 0;
		await fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 14 }), (ops) => {
				const mutations = ops.map((op) => lower(seed, op));

				// One draft for the whole batch, as `applyMutations` holds it.
				produce(seed, (draft) => {
					const doc = draft as unknown as BlueprintDoc;
					const batch = new ReferenceIndexBatch();
					mutations.forEach((mutation, at) => {
						batch.before(doc, mutation);
						applyStep(draft, mutation);
						batch.after(doc, mutation);
						if (ops[at]?.ask === true) expectModulesAgree(batch, doc);
					});
					expectModulesAgree(batch, doc);
				});

				// A settled document after each mutation, one batch keeper over all.
				let doc = seed;
				const batch = new ReferenceIndexBatch();
				mutations.forEach((mutation, at) => {
					if (
						mutation.kind === "addModule" &&
						(doc.formOrder[mutation.module.uuid]?.length ?? 0) > 0
					)
						addedOverForms++;
					batch.before(doc, mutation);
					const next = produce(doc, (draft) => {
						applyStep(draft, mutation);
					});
					batch.after(next, mutation);
					if (next !== doc) {
						const kind = ops[at]?.kind;
						if (kind !== undefined) ran.set(kind, (ran.get(kind) ?? 0) + 1);
					}
					doc = next;
					if (ops[at]?.ask === true) expectModulesAgree(batch, doc);
				});
				expectModulesAgree(batch, doc);

				// The whole batch as one, through the batch `applyMutations` keeps,
				// where identity admission would admit it (no module or form born
				// over one that stands) and its end admits the topology it leaves.
				let whole: BlueprintDoc | undefined;
				if (bornOverStanding(seed, mutations)) return;
				try {
					whole = produce(seed, (draft) => {
						applyMutations(draft, mutations);
					});
				} catch (error) {
					if (!topologyRefusal(error)) throw error;
				}
				if (whole !== undefined) {
					wholeBatches++;
					expect(whole.refIndex).toEqual(buildReferenceIndex(whole));
				}
			}),
			{ numRuns: 150, seed: 20261118 },
		);
		for (const kind of kinds)
			expect(ran.get(kind), `no ${kind} changed a document`).toBeGreaterThan(0);
		expect(addedOverForms).toBeGreaterThan(0);
		expect(wholeBatches).toBeGreaterThan(30);
	}, 30_000);
});
