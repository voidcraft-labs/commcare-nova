// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { tileCell } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { assertAdmittedPreviewDoc } from "@/lib/preview/__tests__/fixtures/admittedDoc";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
}));

import {
	loadCaseDataAction,
	loadCasesAction,
} from "@/lib/preview/engine/caseDataBinding";
import { useCaseData, useCases } from "../useCaseDataBinding";
import { usePreviewMenuSource } from "../usePreviewMenuSource";

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

function expectPlainRecords(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	if (Array.isArray(value)) {
		for (const child of value) expectPlainRecords(child);
		return;
	}
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	for (const child of Object.values(value)) expectPlainRecords(child);
}

it("sends plain live records to Results and Details after tile edits without reloading for store state", async () => {
	const appId = "menu-source";
	const moduleUuid = testUuid("patients");
	const docStore = createBlueprintDocStore();
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	docStore.getState().load(
		buildDoc({
			appId,
			appName: "Patients",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: moduleUuid,
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						...config,
						columns: config.columns.map((column) => ({
							...column,
							tile: tileCell(0, 0, 6, 1),
						})),
					},
					forms: [],
				},
			],
		}),
	);
	const session = createBuilderSessionStore({ appId });
	vi.mocked(loadCasesAction).mockResolvedValue({
		kind: "rows",
		rows: [],
		constraintSource: "unconstrained",
	});
	vi.mocked(loadCaseDataAction).mockResolvedValue({ kind: "missing" });
	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext value={docStore}>
				<BuilderSessionContext value={session}>
					{children}
				</BuilderSessionContext>
			</BlueprintDocContext>
		);
	}
	const hook = renderHook(
		() => {
			const source = usePreviewMenuSource();
			const cases = useCases({
				appId,
				caseType: "patient",
				moduleUuid,
				blueprint: source.doc,
				caseListConfig: source.modules[moduleUuid].caseListConfig,
			});
			const detail = useCaseData({
				appId,
				caseType: "patient",
				caseId: "selected-patient",
				ancestorDepth: 0,
				moduleUuid,
				blueprint: source.doc,
				caseListConfig: source.modules[moduleUuid].caseListConfig,
			});
			return { source, cases, detail };
		},
		{ wrapper: Wrapper },
	);
	await waitFor(() =>
		expect(hook.result.current.cases.state.kind).toBe("rows"),
	);
	await waitFor(() =>
		expect(hook.result.current.detail.state.kind).toBe("missing"),
	);
	const sent = vi.mocked(loadCasesAction).mock.calls[0]?.[0].blueprint;
	expect(sent).toBeDefined();
	if (sent === undefined) throw new Error("Results did not send its document.");
	const { fieldParent, ...persistable } = sent;
	expect(blueprintDocSchema.safeParse(persistable).success).toBe(true);
	expect(Object.values(sent).some((value) => typeof value === "function")).toBe(
		false,
	);
	expect(fieldParent).toEqual(docStore.getState().fieldParent);
	assertAdmittedPreviewDoc(sent);
	expectPlainRecords(sent);
	expectPlainRecords(vi.mocked(loadCaseDataAction).mock.calls[0]?.[11]);
	expect(Object.getPrototypeOf(docStore.getState().modules)).toBeNull();

	const firstSource = hook.result.current.source;
	hook.rerender();
	act(() => {
		docStore.getState().beginRemoteApply();
	});
	expect(hook.result.current.source).toBe(firstSource);
	expect(loadCasesAction).toHaveBeenCalledTimes(1);
	expect(loadCaseDataAction).toHaveBeenCalledTimes(1);
	act(() => {
		docStore.getState().applyMany([
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { tile: { persistOnForms: true } },
			},
		]);
		docStore.getState().endRemoteApply();
	});
	await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(2));
	await waitFor(() => expect(loadCaseDataAction).toHaveBeenCalledTimes(2));
	await waitFor(() => expect(hook.result.current.cases.fetching).toBe(false));
	await waitFor(() =>
		expect(hook.result.current.detail.state.kind).toBe("missing"),
	);
	const resultsDoc = vi.mocked(loadCasesAction).mock.calls[1]?.[0].blueprint;
	const detailDoc = vi.mocked(loadCaseDataAction).mock.calls[1]?.[11];
	for (const transported of [resultsDoc, detailDoc]) {
		expect(transported).toBeDefined();
		if (transported === undefined)
			throw new Error("The changed tile's document was not sent.");
		assertAdmittedPreviewDoc(transported);
		expectPlainRecords(transported);
		expect(transported?.modules[moduleUuid].caseListConfig?.tile).toEqual({
			persistOnForms: true,
		});
		expect(transported?.modules).toEqual(docStore.getState().modules);
		expect(transported?.modules).not.toBe(docStore.getState().modules);
	}
	expect(sent.modules[moduleUuid].caseListConfig?.tile).toBeUndefined();
	expect(Object.getPrototypeOf(docStore.getState().modules)).toBeNull();
});
