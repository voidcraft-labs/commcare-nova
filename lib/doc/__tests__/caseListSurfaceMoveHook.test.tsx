// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useContext } from "react";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { backfillOrderKeys } from "@/lib/doc/order/backfill";
import {
	byDetailColumnOrder,
	byListColumnOrder,
	bySortKey,
} from "@/lib/doc/order/compare";
import { BlueprintDocContext, BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid, simpleSearchInputDef } from "@/lib/domain";

describe("useBlueprintMutations.moveColumnOnSurface", () => {
	it("one gesture commits exactly one moved column key", () => {
		const initial = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "age", label: "Age", data_type: "int" },
						{ name: "status", label: "Status" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "age", header: "Age" },
						{ field: "status", header: "Status" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(initial);
		const moduleUuid = initial.moduleOrder[0];
		const initialColumns =
			initial.modules[moduleUuid].caseListConfig?.columns ?? [];
		const movedUuid = initialColumns[2]?.uuid;
		if (movedUuid === undefined) throw new Error("fixture column missing");

		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId={initial.appId} initialDoc={initial}>
				{children}
			</BlueprintDocProvider>
		);
		const { result } = renderHook(
			() => ({
				mutations: useBlueprintMutations(),
				store: useContext(BlueprintDocContext),
			}),
			{ wrapper },
		);
		const before = result.current.store?.getState();
		if (before === undefined) throw new Error("store missing");

		act(() => {
			result.current.mutations.moveColumnOnSurface(
				moduleUuid,
				movedUuid,
				"list",
				0,
			);
		});

		const after = result.current.store?.getState();
		if (after === undefined) throw new Error("store missing after move");
		const diff = diffDocsToMutations(before, after);
		expect(diff).toHaveLength(1);
		expect(diff[0]).toMatchObject({
			kind: "moveColumn",
			moduleUuid,
			uuid: movedUuid,
			surfaceOrderPatch: { surface: "list" },
		});

		const afterColumns =
			after.modules[moduleUuid].caseListConfig?.columns ?? [];
		expect([...afterColumns].sort(byListColumnOrder)[0]?.uuid).toBe(movedUuid);
		// Details did not move with Results.
		expect(
			[...afterColumns].sort(byDetailColumnOrder).map((c) => c.uuid),
		).toEqual([...initialColumns].sort(byDetailColumnOrder).map((c) => c.uuid));
	});
});

describe("useBlueprintMutations.moveSearchInputToIndex", () => {
	it("one gesture commits exactly one moved search-field key", () => {
		const first = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000331"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const second = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000332"),
			"external_id",
			"External ID",
			"text",
			"external_id",
		);
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [first, second];
		const initial = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "external_id", label: "External ID" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
				},
			],
		});
		backfillOrderKeys(initial);
		const moduleUuid = initial.moduleOrder[0];
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId={initial.appId} initialDoc={initial}>
				{children}
			</BlueprintDocProvider>
		);
		const { result } = renderHook(
			() => ({
				mutations: useBlueprintMutations(),
				store: useContext(BlueprintDocContext),
			}),
			{ wrapper },
		);
		const before = result.current.store?.getState();
		if (before === undefined) throw new Error("store missing");

		act(() => {
			result.current.mutations.moveSearchInputToIndex(
				moduleUuid,
				first.uuid,
				1,
			);
		});

		const after = result.current.store?.getState();
		if (after === undefined) throw new Error("store missing after move");
		const diff = diffDocsToMutations(before, after);
		expect(diff).toHaveLength(1);
		expect(diff[0]).toMatchObject({
			kind: "moveSearchInput",
			moduleUuid,
			uuid: first.uuid,
		});
		const inputs = after.modules[moduleUuid].caseListConfig?.searchInputs ?? [];
		expect([...inputs].sort(bySortKey).map((input) => input.uuid)).toEqual([
			second.uuid,
			first.uuid,
		]);
	});
});
