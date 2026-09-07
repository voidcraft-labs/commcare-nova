import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { removeCaseOperationMutation } from "@/lib/doc/caseOperationMutations";
import {
	caseOperationDependencyOccurrences,
	caseOperationMoveVerdicts,
	caseOperationRemovalBlockers,
} from "@/lib/doc/caseOperationReview";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Form, Uuid } from "@/lib/domain";
import { orderedCaseOperations } from "@/lib/domain";
import { eq, idOf, literal, term } from "@/lib/domain/predicate";
import { assertAdmittedDoc } from "./admittedDoc";

const CREATE = testUuid("11111111-1111-4111-8111-111111111111");
const SECOND = testUuid("22222222-2222-4222-8222-222222222222");
const CONSUMER = testUuid("33333333-3333-4333-8333-333333333333");
const RETYPE = testUuid("55555555-5555-4555-8555-555555555555");
const LATER = testUuid("66666666-6666-4666-8666-666666666666");

function form(operations: readonly CaseOperation[]): Form {
	const { doc, formUuid } = docWithOperations(operations);
	return doc.forms[formUuid];
}

function create(uuid: Uuid, id: string): CaseOperation {
	return {
		uuid,
		id,
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(literal("Visit")),
	};
}

/** A valid consumer using several independent scalar reference slots. */
function everySlotConsumer(): CaseOperation {
	return {
		uuid: CONSUMER,
		id: "tag_visit",
		action: "update",
		caseType: "visit",
		target: { kind: "op", opUuid: CREATE },
		condition: eq(idOf(CREATE), term(literal("x"))),
		owner: idOf(CREATE),
		rename: idOf(CREATE),
		retype: undefined,
		writes: [
			{ property: "source_id", value: idOf(CREATE) },
			{
				property: "flag",
				value: term(literal("y")),
				condition: eq(idOf(CREATE), term(literal("z"))),
			},
		],
	};
}

describe("caseOperationDependencyOccurrences", () => {
	it("names every slot that holds the reference", () => {
		const f = form([create(CREATE, "create_visit"), everySlotConsumer()]);
		const [dependency] = caseOperationDependencyOccurrences(f, CREATE);
		expect(dependency.operationUuid).toBe(CONSUMER);
		expect(dependency.slots).toEqual([
			{ kind: "target" },
			{ kind: "owner" },
			{ kind: "rename" },
			{ kind: "write", property: "source_id" },
			{ kind: "write-condition", property: "flag" },
			{ kind: "condition" },
		]);
	});

	it("reports nothing for an operation nobody consumes", () => {
		const f = form([
			create(CREATE, "create_visit"),
			create(SECOND, "create_other"),
		]);
		expect(caseOperationDependencyOccurrences(f, SECOND)).toEqual([]);
	});

	it("never reports an operation against itself", () => {
		// A self-referencing shape is invalid, but the walk must not claim a
		// dependency that would make its own row un-removable.
		const selfish: CaseOperation = {
			...create(CREATE, "create_visit"),
			writes: [{ property: "own", value: idOf(CREATE) }],
		};
		expect(
			caseOperationDependencyOccurrences(
				{
					...form([create(CREATE, "create_visit")]),
					caseOperations: [selfish],
				},
				CREATE,
			),
		).toEqual([]);
	});

	it("lists consumers in execution order", () => {
		const late: CaseOperation = {
			...everySlotConsumer(),
			uuid: SECOND,
			id: "late",
		};
		const early: CaseOperation = {
			...everySlotConsumer(),
			uuid: CONSUMER,
			id: "early",
		};
		// Execution order is the order the form holds them.
		const f = form([create(CREATE, "c"), early, late]);
		expect(
			caseOperationDependencyOccurrences(f, CREATE).map(
				(dependency) => dependency.operationUuid,
			),
		).toEqual([CONSUMER, SECOND]);
	});

	it("names a create name reference and a distinct case's parent link", () => {
		const named: CaseOperation = {
			...create(SECOND, "named_visit"),
			name: idOf(CREATE),
		};
		expect(
			caseOperationDependencyOccurrences(
				form([create(CREATE, "create_visit"), named]),
				CREATE,
			),
		).toEqual([{ operationUuid: SECOND, slots: [{ kind: "name" }] }]);
		const linked: CaseOperation = {
			uuid: CONSUMER,
			id: "link_referral",
			action: "update",
			caseType: "referral",
			target: { kind: "expression", expr: term(literal("existing-referral")) },
			links: [
				{
					identifier: "parent",
					targetType: "visit",
					target: { kind: "op", opUuid: CREATE },
					relationship: "child",
				},
			],
		};
		expect(
			caseOperationDependencyOccurrences(
				form([create(CREATE, "create_visit"), linked]),
				CREATE,
			),
		).toEqual([
			{
				operationUuid: CONSUMER,
				slots: [{ kind: "link", identifier: "parent" }],
			},
		]);
	});
});

function docWithOperations(operations: readonly CaseOperation[]): {
	doc: BlueprintDoc;
	formUuid: Uuid;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "source_id", label: "Source" },
					{ name: "flag", label: "Flag" },
				],
			},
			{
				name: "referral",
				properties: [
					{ name: "source_id", label: "Source" },
					{ name: "flag", label: "Flag" },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [{ kind: "text", id: "notes", label: "Notes" }],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	doc.forms[formUuid].caseOperations = [...operations];
	assertAdmittedDoc(doc);
	return { doc, formUuid };
}

/**
 * Two changes joined by a case TYPE and nothing else: the first retypes
 * the case the form opened, the second acts on it as the new type. There
 * is no `id-of` edge anywhere in this shape, which is exactly what makes
 * it the fixture for a refusal a reference walk cannot explain.
 */
function retypeChain(): { doc: BlueprintDoc; formUuid: Uuid } {
	const operations: CaseOperation[] = [
		{
			uuid: RETYPE,
			id: "make_referral",
			action: "update",
			caseType: "visit",
			target: { kind: "session" },
			retype: "referral",
		},
		{
			uuid: LATER,
			id: "update_referral",
			action: "update",
			caseType: "referral",
			target: { kind: "session" },
		},
	];
	return docWithOperations(operations);
}

describe("caseOperationMoveVerdicts", () => {
	it("reports independently expected legal placements and gate outcomes", () => {
		const { doc, formUuid } = docWithOperations([
			create(CREATE, "create_visit"),
			create(SECOND, "create_other"),
			everySlotConsumer(),
		]);
		const expected = [
			[true, true, false],
			[true, true, true],
			[false, true, true],
		];
		const ordered = orderedCaseOperations(doc.forms[formUuid]);
		for (const [from, operation] of ordered.entries()) {
			const verdicts = caseOperationMoveVerdicts(doc, formUuid, operation.uuid);
			expect([...verdicts.values()].map((verdict) => verdict.ok)).toEqual(
				expected[from],
			);
			for (let to = 0; to < 3; to++) {
				const without = ordered.filter((item) => item.uuid !== operation.uuid);
				const after = to === 0 ? null : without[to - 1].uuid;
				const gate = mutationCommitVerdict(
					doc,
					[
						{
							kind: "updateForm",
							uuid: formUuid,
							patch: {},
							caseOperationPatch: {
								operation: "move",
								uuid: operation.uuid,
								after,
							},
						},
					],
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(gate.ok).toBe(expected[from][to]);
				if (gate.ok) {
					const expectedOrder = without.map((item) => item.uuid);
					expectedOrder.splice(to, 0, operation.uuid);
					expect(
						gate.nextDoc.forms[formUuid].caseOperations?.map(
							(item) => item.uuid,
						),
					).toEqual(expectedOrder);
				}
			}
		}
	});

	it("refuses moving a consumed create past its consumer, and names it", () => {
		const { doc, formUuid } = docWithOperations([
			create(CREATE, "create_visit"),
			everySlotConsumer(),
		]);
		const verdicts = caseOperationMoveVerdicts(doc, formUuid, CREATE);
		const afterConsumer = verdicts.get(1);
		expect(afterConsumer?.ok).toBe(false);
		if (afterConsumer?.ok === false) {
			expect(afterConsumer.blockingUuids).toEqual([CONSUMER]);
		}
		// Staying put remains fine.
		expect(verdicts.get(0)?.ok).toBe(true);
	});

	it("returns an empty map for an unknown form or operation", () => {
		const { doc, formUuid } = docWithOperations([
			create(CREATE, "create_visit"),
		]);
		expect(caseOperationMoveVerdicts(doc, formUuid, SECOND).size).toBe(0);
		expect(
			caseOperationMoveVerdicts(doc, testUuid("no-such-form"), CREATE).size,
		).toBe(0);
	});

	it("carries which kind of dependency refused, so the copy need not guess", () => {
		const { doc, formUuid } = docWithOperations([
			create(CREATE, "create_visit"),
			everySlotConsumer(),
		]);
		const verdict = caseOperationMoveVerdicts(doc, formUuid, CREATE).get(1);
		expect(verdict).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "reference",
			blockingUuids: [CONSUMER],
		});
	});

	// The bug: a type refusal carried no cause, so the copy layer re-derived
	// one by walking `id-of` edges — which this shape has none of — and named
	// whatever it found instead of the change that actually blocks.
	it("names the operation whose case type would change, as a target-type refusal", () => {
		const { doc, formUuid } = retypeChain();
		const verdict = caseOperationMoveVerdicts(doc, formUuid, RETYPE).get(1);
		expect(verdict).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "target-type",
			blockingUuids: [LATER],
		});
	});

	it("reports the same target-type cause when the moved change is the one left mistyped", () => {
		const { doc, formUuid } = retypeChain();
		const verdict = caseOperationMoveVerdicts(doc, formUuid, LATER).get(0);
		expect(verdict).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "target-type",
			blockingUuids: [LATER],
		});
	});
});

describe("caseOperationRemovalBlockers", () => {
	it("names each consumer with the slots holding its reference", () => {
		const { doc, formUuid } = docWithOperations([
			create(CREATE, "create_visit"),
			everySlotConsumer(),
		]);
		const blockers = caseOperationRemovalBlockers(doc, formUuid, CREATE);
		expect(blockers).toHaveLength(1);
		expect(blockers[0].operationUuid).toBe(CONSUMER);
		expect(blockers[0].slots.length).toBeGreaterThan(0);
	});

	// The `id-of` walk this used to be built from sees nothing here, so the
	// rail rendered its "cannot be removed" heading over an empty list, with
	// no Remove button and no operation named.
	it("lists a blocker that depends on the case type rather than a reference", () => {
		const { doc, formUuid } = retypeChain();
		expect(removeCaseOperationMutation(doc, formUuid, RETYPE).ok).toBe(false);
		expect(caseOperationRemovalBlockers(doc, formUuid, RETYPE)).toEqual([
			{ operationUuid: LATER, slots: [] },
		]);
	});

	it("reports nothing when removal is allowed, and for an unknown form", () => {
		const { doc, formUuid } = docWithOperations([
			create(CREATE, "create_visit"),
		]);
		expect(caseOperationRemovalBlockers(doc, formUuid, CREATE)).toEqual([]);
		expect(
			caseOperationRemovalBlockers(doc, testUuid("no-such-form"), CREATE),
		).toEqual([]);
	});
});
