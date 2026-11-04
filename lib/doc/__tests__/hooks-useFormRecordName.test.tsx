// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { parseFormExpressionForSlot } from "@/lib/doc/expressionText";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { formRecordNameMutations } from "@/lib/doc/formRecordName";
import { useFormRecordName } from "@/lib/doc/hooks/useFormRecordName";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { fieldCaseWriteViews } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import { assertAdmittedDoc } from "./admittedDoc";

const FORM = testUuid("record-name-form");
const NAME = testUuid("record-name-answer");

// The record name is the own case's name slot: the hook projects it there,
// the parse and the commit share that slot, and no question stands in for it.
it("edits the own case's name in its own slot, through a committed snapshot change", () => {
	const doc = buildDoc({
		caseTypes: [{ name: "person", properties: [] }],
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Register person",
						type: "registration",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "person", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StrictMode>
			<BlueprintDocContext value={store}>{children}</BlueprintDocContext>
		</StrictMode>
	);
	const { result, unmount } = renderHook(() => useFormRecordName(FORM), {
		wrapper,
	});
	const current = () => {
		const name = result.current;
		if (name === undefined)
			throw new Error("The registration's record-name editor disappeared.");
		expect(name.ok).toBe(true);
		return name;
	};
	const commit = (mutations: Mutation[]) => {
		const verdict = mutationCommitVerdict(
			store.getState(),
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
		act(() => store.getState().commitDoc(verdict.nextDoc, verdict.mutations));
	};
	const ownName = () =>
		store
			.getState()
			.forms[FORM]?.caseOperations?.find(
				(operation) => operation.action === "own",
			)?.name;
	try {
		const prepared = current().prepared;
		expect(prepared.slot).toMatchObject({
			entity: "form",
			uuid: FORM,
			slot: "case_operation_name",
		});
		expect(current().text).toBe("#form/name");
		expect(fieldCaseWriteViews(store.getState(), NAME)).toMatchObject([
			{ slot: "name", property: "case_name" },
		]);
		const fieldCount = Object.keys(store.getState().fields).length;

		const value = term(literal("Calculated name"));
		commit(formRecordNameMutations(store.getState(), FORM, value, prepared));
		expect(ownName()).toEqual(value);
		expect(current().text).toBe("'Calculated name'");
		expect(Object.keys(store.getState().fields)).toHaveLength(fieldCount);
		expect(fieldCaseWriteViews(store.getState(), NAME)).toEqual([]);
		// Setting the name it already has is no change.
		expect(
			formRecordNameMutations(store.getState(), FORM, value, prepared),
		).toEqual([]);

		const parsed = parseFormExpressionForSlot(
			store.getState(),
			current().prepared.slot,
			"concat(#form/name, ' next')",
			"unavailable",
			{ form: current().prepared.form },
		);
		if (!parsed.ok || parsed.expression === undefined)
			throw new Error("The replacement record name did not parse.");
		const replacement = parsed.expression;
		commit(
			formRecordNameMutations(store.getState(), FORM, replacement, prepared),
		);
		expect(current().text).toBe("concat(#form/name, ' next')");
		expect(ownName()).toEqual(replacement);

		// An edit parsed for an own case the form no longer holds is refused.
		const stale = {
			slot: {
				...prepared.slot,
				member: { operationUuid: testUuid("another-own-case") },
			},
		};
		expect(() =>
			formRecordNameMutations(store.getState(), FORM, value, stale),
		).toThrow("The record this form names changed while you were editing.");
	} finally {
		unmount();
	}
});
