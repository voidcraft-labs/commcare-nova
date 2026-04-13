// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useForm, useModule, useQuestion } from "@/lib/doc/hooks/useEntity";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

function setup() {
	const store = createBlueprintDocStore();
	const bp: AppBlueprint = {
		app_name: "Hooks Test",
		connect_type: undefined,
		modules: [
			{
				name: "Registration",
				forms: [
					{
						name: "Reg Form",
						type: "registration",
						questions: [
							{
								uuid: "q-111-0000-0000-0000-000000000000",
								id: "name",
								type: "text",
								label: "Name",
							},
						],
					},
				],
			},
		],
		case_types: null,
	};
	store.getState().load(bp, "app-1");
	const moduleUuid = store.getState().moduleOrder[0];
	const formUuid = store.getState().formOrder[moduleUuid][0];
	const questionUuid = store.getState().questionOrder[formUuid][0];
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper, moduleUuid, formUuid, questionUuid };
}

describe("useModule / useForm / useQuestion", () => {
	it("returns the entity when the uuid exists", () => {
		const { wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useModule(moduleUuid), { wrapper });
		expect(result.current?.name).toBe("Registration");
	});

	it("returns undefined for unknown uuids", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useQuestion("missing-uuid" as never), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});

	it("does not re-render when an unrelated entity changes", () => {
		const { store, wrapper, questionUuid } = setup();
		let renderCount = 0;
		renderHook(
			() => {
				renderCount++;
				return useQuestion(questionUuid);
			},
			{ wrapper },
		);
		const initialRenders = renderCount;
		store.temporal.getState().resume();
		act(() => {
			store.getState().apply({ kind: "setAppName", name: "Changed" });
		});
		// setAppName doesn't touch any question entity, so Immer preserves
		// the reference — useQuestion must NOT re-render.
		expect(renderCount).toBe(initialRenders);
	});
});
