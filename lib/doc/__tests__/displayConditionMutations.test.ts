import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	setFormDisplayConditionMutation,
	setModuleDisplayConditionMutation,
} from "@/lib/doc/displayConditionMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, literal, sessionContext, term } from "@/lib/domain/predicate";
import { assertAdmittedDoc } from "./admittedDoc";

const CONDITION = eq(term(sessionContext("username")), term(literal("nurse")));

function docWithModuleAndForm(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Mothers",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: "Notes" }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

/**
 * The hop a mutation takes wherever the mutation OBJECT is the durable
 * event — the SSE `data-mutations` frame and the persisted jsonb, both
 * `JSON.stringify`. It drops an `undefined`-valued key, so a clear
 * spelled that way silently becomes "no change" for every receiver.
 * Asserting only in memory would pass either way, which is what makes
 * this round trip the load-bearing assertion.
 */
function throughTheWire(mutation: Mutation): Mutation {
	return mutationSchema.parse(JSON.parse(JSON.stringify(mutation)));
}

describe("display-condition mutations", () => {
	it("sets a module condition", () => {
		const doc = docWithModuleAndForm();
		const moduleUuid = doc.moduleOrder[0];
		const next = apply(doc, [
			setModuleDisplayConditionMutation(moduleUuid, CONDITION),
		]);
		expect(next.modules[moduleUuid].displayCondition).toEqual(CONDITION);
	});

	it("sets a form condition", () => {
		const doc = docWithModuleAndForm();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const next = apply(doc, [
			setFormDisplayConditionMutation(formUuid, CONDITION),
		]);
		expect(next.forms[formUuid].displayCondition).toEqual(CONDITION);
	});

	it("spells a removal as an explicit null, not an absent key", () => {
		const moduleClear = setModuleDisplayConditionMutation(
			testUuid("display-module"),
			undefined,
		);
		const formClear = setFormDisplayConditionMutation(
			testUuid("display-form"),
			undefined,
		);
		expect(moduleClear).toMatchObject({ patch: { displayCondition: null } });
		expect(formClear).toMatchObject({ patch: { displayCondition: null } });
		// The distinction that matters: the key survives serialization.
		expect(
			Object.hasOwn(
				JSON.parse(JSON.stringify(moduleClear)).patch,
				"displayCondition",
			),
		).toBe(true);
		expect(
			Object.hasOwn(
				JSON.parse(JSON.stringify(formClear)).patch,
				"displayCondition",
			),
		).toBe(true);
	});

	it("removes a module condition after a serialization round trip", () => {
		const doc = docWithModuleAndForm();
		const moduleUuid = doc.moduleOrder[0];
		const withCondition = apply(doc, [
			setModuleDisplayConditionMutation(moduleUuid, CONDITION),
		]);
		const cleared = apply(withCondition, [
			throughTheWire(setModuleDisplayConditionMutation(moduleUuid, undefined)),
		]);
		expect(cleared.modules[moduleUuid].displayCondition).toBeUndefined();
		expect(Object.hasOwn(cleared.modules[moduleUuid], "displayCondition")).toBe(
			false,
		);
	});

	it("removes a form condition after a serialization round trip", () => {
		const doc = docWithModuleAndForm();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const withCondition = apply(doc, [
			setFormDisplayConditionMutation(formUuid, CONDITION),
		]);
		const cleared = apply(withCondition, [
			throughTheWire(setFormDisplayConditionMutation(formUuid, undefined)),
		]);
		expect(cleared.forms[formUuid].displayCondition).toBeUndefined();
		expect(Object.hasOwn(cleared.forms[formUuid], "displayCondition")).toBe(
			false,
		);
	});

	it("carries a set condition through the wire unchanged", () => {
		const doc = docWithModuleAndForm();
		const moduleUuid = doc.moduleOrder[0];
		const next = apply(doc, [
			throughTheWire(setModuleDisplayConditionMutation(moduleUuid, CONDITION)),
		]);
		expect(next.modules[moduleUuid].displayCondition).toEqual(CONDITION);
	});
});
