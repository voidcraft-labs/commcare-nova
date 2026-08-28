// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain/prose";
import {
	useHasSelectedField,
	useIsFormSelected,
	useIsModuleSelected,
	useLocation,
	useLocationKind,
	useNavigate,
	useSelectedModuleUuid,
	useSelectedProjectDataTableId,
} from "@/lib/routing/hooks";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
	}),
}));

function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			appId: "app-1",
			appName: "T",
			modules: [
				{
					uuid: "module-1",
					name: "Module",
					forms: [
						{
							uuid: "form-1",
							name: "Form",
							type: "survey",
							fields: [
								f({
									uuid: "field-1",
									kind: "text",
									id: "one",
									label: proseText("One"),
								}),
								f({
									uuid: "field-2",
									kind: "text",
									id: "two",
									label: proseText("Two"),
								}),
							],
						},
					],
				},
			],
		}),
	);
	return store;
}

function wrapper(store: ReturnType<typeof makeStore>) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext.Provider value={store}>
				{children}
			</BlueprintDocContext.Provider>
		);
	};
}

describe("primitive Builder route projections", () => {
	it("keeps the resolved location stable across scalar document edits", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		const fieldUuid = state.fieldOrder[formUuid][0];
		window.history.replaceState(null, "", `/build/app-1/${fieldUuid}`);

		let renders = 0;
		const view = renderHook(
			() => {
				renders += 1;
				return useLocation();
			},
			{ wrapper: wrapper(store) },
		);
		const initialLocation = view.result.current;
		const initialRenders = renders;

		act(() => {
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: { label: proseText("Renamed") },
				},
			]);
		});

		expect(renders).toBe(initialRenders);
		expect(view.result.current).toBe(initialLocation);
	});

	it("does not render module, form, or navigation consumers for a field-only path change", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		const [firstFieldUuid, secondFieldUuid] = state.fieldOrder[formUuid];
		window.history.replaceState(null, "", `/build/app-1/${firstFieldUuid}`);

		let renders = 0;
		const view = renderHook(
			() => {
				renders += 1;
				return {
					moduleSelected: useIsModuleSelected(moduleUuid),
					formSelected: useIsFormSelected(formUuid),
					fieldDocked: useHasSelectedField(),
					locationKind: useLocationKind(),
					selectedModuleUuid: useSelectedModuleUuid(),
					projectDataTableId: useSelectedProjectDataTableId(),
					navigate: useNavigate(),
				};
			},
			{ wrapper: wrapper(store) },
		);
		expect(view.result.current.moduleSelected).toBe(true);
		expect(view.result.current.formSelected).toBe(true);
		expect(view.result.current.fieldDocked).toBe(true);
		expect(view.result.current.locationKind).toBe("form");
		expect(view.result.current.selectedModuleUuid).toBe(moduleUuid);
		expect(view.result.current.projectDataTableId).toBeUndefined();
		const initialNavigate = view.result.current.navigate;
		const initialRenders = renders;

		act(() => pushBuilderHistory(`/build/app-1/${secondFieldUuid}`, true));

		expect(renders).toBe(initialRenders);
		expect(view.result.current.navigate).toBe(initialNavigate);
	});
});
