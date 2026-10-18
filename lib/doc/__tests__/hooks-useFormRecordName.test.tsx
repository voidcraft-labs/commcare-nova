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
import { literal, term } from "@/lib/domain/expression";
import { assertAdmittedDoc } from "./admittedDoc";

const FORM = testUuid("record-name-form");
const NAME = testUuid("record-name-answer");

// React owns the reservation lifetime: one mounted editor must survive a
// committed calculated carrier becoming an ordinary field after a peer edit.
it("renews a consumed reservation before another accepted writer takes over", () => {
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
	try {
		const first = current().prepared;
		expect(current().text).toBe("#form/name");
		commit([{ kind: "setAppName", name: "People register" }]);
		expect(current().prepared.fieldUuid).toBe(first.fieldUuid);
		const value = term(literal("Calculated name"));
		commit(formRecordNameMutations(store.getState(), FORM, value, first));
		expect(current().prepared.fieldUuid).toBe(first.fieldUuid);
		expect(current().text).toBe("'Calculated name'");

		commit([
			{
				kind: "updateField",
				uuid: first.fieldUuid,
				targetKind: "hidden",
				patch: { caseWrite: null },
			},
			{
				kind: "updateField",
				uuid: NAME,
				targetKind: "text",
				patch: { caseWrite: { caseType: "person", property: "case_name" } },
			},
		]);
		const second = current().prepared;
		expect(current().text).toBe("#form/name");
		expect(second.fieldUuid).not.toBe(first.fieldUuid);
		expect(store.getState().fields[second.fieldUuid]).toBeUndefined();
		expect(store.getState().fields[first.fieldUuid]).toMatchObject({
			kind: "hidden",
			calculate: value,
		});
		expect(store.getState().fields[first.fieldUuid]).not.toHaveProperty(
			"caseWrite",
		);
		commit([{ kind: "setAppName", name: "Updated register" }]);
		expect(current().prepared.fieldUuid).toBe(second.fieldUuid);

		// The reservation is still the real carrier the parser and commit share.
		const parsed = parseFormExpressionForSlot(
			store.getState(),
			second.slot,
			"concat(#form/name, ' next')",
			"unavailable",
			{ form: current().prepared.form },
		);
		if (!parsed.ok || parsed.expression === undefined)
			throw new Error("The replacement record name did not parse.");
		const replacement = parsed.expression;
		expect(() =>
			formRecordNameMutations(store.getState(), FORM, replacement, first),
		).toThrow("The new record-name field's identity is already in use.");
		commit(
			formRecordNameMutations(store.getState(), FORM, replacement, second),
		);
		expect(current().prepared.fieldUuid).toBe(second.fieldUuid);
		expect(current().text).toBe("concat(#form/name, ' next')");
		expect(store.getState().fields[second.fieldUuid]).toMatchObject({
			kind: "hidden",
			calculate: replacement,
			caseWrite: { caseType: "person", property: "case_name" },
		});
		expect(store.getState().fields[first.fieldUuid]).not.toHaveProperty(
			"caseWrite",
		);
	} finally {
		unmount();
	}
});
