// lib/doc/__tests__/caseOperationReview.test.ts
//
// The review projections' two obligations:
//
//   1. The per-slot walk agrees with `caseOperationDependencyUuids` on
//      every operation shape. That function is what the REMOVE planner
//      refuses on, so a slot the review layer cannot name is a refusal
//      the author cannot act on — and a slot the review layer invents is
//      a dependency that does not exist. The parity assertion is what
//      keeps the two traversals from drifting as the schema grows.
//
//   2. The move-verdict map says exactly what the move planner says, for
//      every candidate position. Both gestures read this one map, so a
//      keyboard reorder and a drag can never disagree about legality.

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { moveCaseOperationMutation } from "@/lib/doc/caseOperationMutations";
import { caseOperationDependencyUuids } from "@/lib/doc/caseOperationOrder";
import {
	caseOperationDependencyOccurrences,
	caseOperationMoveVerdicts,
} from "@/lib/doc/caseOperationReview";
import { asUuid } from "@/lib/doc/types";
import type { BlueprintDoc, CaseOperation, Form, Uuid } from "@/lib/domain";
import { orderedCaseOperations } from "@/lib/domain";
import { eq, idOf, literal, term } from "@/lib/domain/predicate";

const CREATE = asUuid("11111111-1111-4111-8111-111111111111");
const SECOND = asUuid("22222222-2222-4222-8222-222222222222");
const CONSUMER = asUuid("33333333-3333-4333-8333-333333333333");

function form(operations: readonly CaseOperation[]): Form {
	return {
		uuid: asUuid("44444444-4444-4444-8444-444444444444"),
		id: "visit",
		name: "Visit",
		type: "followup",
		caseOperations: [...operations],
	} as Form;
}

function create(uuid: Uuid, order: string, id: string): CaseOperation {
	return {
		uuid,
		id,
		order,
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(literal("Visit")),
	};
}

/** Every slot that can hold a reference, all pointing at one create. */
function everySlotConsumer(): CaseOperation {
	return {
		uuid: CONSUMER,
		id: "tag_visit",
		order: "z",
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
		links: [
			{
				identifier: "parent",
				targetType: "visit",
				target: { kind: "op", opUuid: CREATE },
				relationship: "child",
			},
		],
	};
}

describe("caseOperationDependencyOccurrences", () => {
	it("names every slot that holds the reference", () => {
		const f = form([create(CREATE, "a", "create_visit"), everySlotConsumer()]);
		const [dependency] = caseOperationDependencyOccurrences(f, CREATE);
		expect(dependency.operationUuid).toBe(CONSUMER);
		expect(dependency.slots).toEqual([
			{ kind: "target" },
			{ kind: "link", identifier: "parent" },
			{ kind: "owner" },
			{ kind: "rename" },
			{ kind: "write", property: "source_id" },
			{ kind: "write-condition", property: "flag" },
			{ kind: "condition" },
		]);
	});

	it("reports nothing for an operation nobody consumes", () => {
		const f = form([
			create(CREATE, "a", "create_visit"),
			create(SECOND, "b", "create_other"),
		]);
		expect(caseOperationDependencyOccurrences(f, SECOND)).toEqual([]);
	});

	it("never reports an operation against itself", () => {
		// A self-referencing shape is invalid, but the walk must not claim a
		// dependency that would make its own row un-removable.
		const selfish: CaseOperation = {
			...create(CREATE, "a", "create_visit"),
			writes: [{ property: "own", value: idOf(CREATE) }],
		};
		expect(caseOperationDependencyOccurrences(form([selfish]), CREATE)).toEqual(
			[],
		);
	});

	it("lists consumers in execution order", () => {
		const late: CaseOperation = {
			...everySlotConsumer(),
			uuid: SECOND,
			id: "late",
			order: "z",
		};
		const early: CaseOperation = {
			...everySlotConsumer(),
			uuid: CONSUMER,
			id: "early",
			order: "b",
		};
		const f = form([create(CREATE, "a", "c"), late, early]);
		expect(
			caseOperationDependencyOccurrences(f, CREATE).map(
				(dependency) => dependency.operationUuid,
			),
		).toEqual([CONSUMER, SECOND]);
	});

	// The drift-proof. `caseOperationDependencyUuids` is what the remove
	// planner refuses on; this projection is how the refusal is explained.
	// A slot in one and not the other is a bug in whichever is newer.
	it("agrees with the canonical dependency walk on every shape", () => {
		const shapes: readonly CaseOperation[] = [
			everySlotConsumer(),
			{ ...everySlotConsumer(), target: { kind: "session" }, links: [] },
			{
				...everySlotConsumer(),
				target: { kind: "expression", expr: idOf(CREATE) },
				owner: undefined,
				rename: undefined,
				writes: [],
				links: [],
				condition: undefined,
			},
			{
				...everySlotConsumer(),
				target: { kind: "session" },
				owner: undefined,
				rename: undefined,
				condition: undefined,
				writes: [{ property: "only", value: idOf(CREATE) }],
				links: [],
			},
			{
				...everySlotConsumer(),
				target: { kind: "session" },
				owner: undefined,
				rename: undefined,
				condition: undefined,
				writes: [],
				links: [
					{
						identifier: "host",
						targetType: "visit",
						target: { kind: "expression", expr: idOf(CREATE) },
						relationship: "extension",
					},
				],
			},
			// Nothing references the create at all.
			{
				...everySlotConsumer(),
				target: { kind: "session" },
				owner: undefined,
				rename: undefined,
				condition: undefined,
				writes: [{ property: "plain", value: term(literal("v")) }],
				links: [],
			},
		];
		for (const shape of shapes) {
			const f = form([create(CREATE, "a", "create_visit"), shape]);
			const canonical = caseOperationDependencyUuids(shape).has(CREATE);
			const named = caseOperationDependencyOccurrences(f, CREATE).length > 0;
			expect(named).toBe(canonical);
		}
	});
});

function docWithOperations(operations: readonly CaseOperation[]): {
	doc: BlueprintDoc;
	formUuid: Uuid;
} {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Visit", type: "followup" }],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	return {
		doc: {
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: { ...doc.forms[formUuid], caseOperations: [...operations] },
			},
		},
		formUuid,
	};
}

describe("caseOperationMoveVerdicts", () => {
	it("answers for every candidate position, and never disagrees with the planner", () => {
		const operations = [
			create(CREATE, "a", "create_visit"),
			create(SECOND, "b", "create_other"),
			{ ...everySlotConsumer(), order: "c" },
		];
		const { doc, formUuid } = docWithOperations(operations);
		const ordered = orderedCaseOperations(doc.forms[formUuid]);

		for (const operation of ordered) {
			const verdicts = caseOperationMoveVerdicts(doc, formUuid, operation.uuid);
			expect(verdicts.size).toBe(ordered.length);
			for (let index = 0; index < ordered.length; index++) {
				const verdict = verdicts.get(index);
				expect(verdict).toBeDefined();
				const currentIndex = ordered.findIndex(
					(candidate) => candidate.uuid === operation.uuid,
				);
				if (index === currentIndex) {
					// Moving to where it already is is not a change.
					expect(verdict?.ok).toBe(true);
					continue;
				}
				const plan = moveCaseOperationMutation(
					doc,
					formUuid,
					operation.uuid,
					index,
				);
				expect(verdict?.ok).toBe(plan.ok);
			}
		}
	});

	it("refuses moving a consumed create past its consumer, and names it", () => {
		const { doc, formUuid } = docWithOperations([
			create(CREATE, "a", "create_visit"),
			{ ...everySlotConsumer(), order: "b" },
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
			create(CREATE, "a", "create_visit"),
		]);
		expect(caseOperationMoveVerdicts(doc, formUuid, SECOND).size).toBe(0);
		expect(
			caseOperationMoveVerdicts(doc, asUuid("no-such-form" as string), CREATE)
				.size,
		).toBe(0);
	});
});
