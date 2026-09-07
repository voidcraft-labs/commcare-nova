// @vitest-environment happy-dom
//
// Tests for `useConnectType` and `useConnectTypeOrUndefined` — the two
// named hooks that replace inline `useBlueprintDoc((s) => s.connectType)`
// / `useBlueprintDoc((s) => s.connectType ?? undefined)` call sites.
// Two shapes exist because some consumers want `null` (signals "no connect
// type chosen"), others want `undefined` (plays nicer with optional form
// state wrappers and TypeScript `?:` fallthroughs).

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planConnectTargetState } from "@/lib/doc/connectTargetState";
import {
	useConnectType,
	useConnectTypeOrUndefined,
} from "@/lib/doc/hooks/useConnectType";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { ConnectType } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

function setup(connectType: ConnectType | null) {
	const store = createBlueprintDocStore();
	const doc = buildDoc({
		appName: "Connect test",
		connectType,
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						...(connectType === null
							? {}
							: {
									connect:
										connectType === "learn"
											? {
													learn_module: {
														id: "intro",
														name: "Intro",
														description: "First lesson",
														time_estimate: 5,
													},
												}
											: { deliver_unit: { id: "visit", name: "Visit" } },
								}),
						fields: [{ kind: "text", id: "answer" }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	store.getState().load(doc);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper };
}

describe("useConnectType", () => {
	it("returns the current connect type when set", () => {
		const { wrapper } = setup("learn");
		const { result } = renderHook(() => useConnectType(), { wrapper });
		expect(result.current).toBe("learn");
	});

	it("returns null when connect type is not set", () => {
		const { wrapper } = setup(null);
		const { result } = renderHook(() => useConnectType(), { wrapper });
		expect(result.current).toBeNull();
	});

	it("re-renders when the connect type changes", () => {
		const { store, wrapper } = setup(null);
		const { result } = renderHook(() => useConnectType(), { wrapper });
		expect(result.current).toBeNull();
		store.getState().startTracking();
		act(() => {
			const formUuid =
				store.getState().formOrder[store.getState().moduleOrder[0]][0];
			const plan = planConnectTargetState(store.getState(), {
				mode: "deliver",
				participants: [
					{
						formUuid,
						connect: { deliver_unit: { id: "visit", name: "Visit" } },
					},
				],
			});
			if (!plan.ok) throw new Error(plan.messages.join("\n"));
			const verdict = mutationCommitVerdict(
				store.getState(),
				plan.mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
			store.getState().commitDoc(verdict.nextDoc, verdict.mutations);
		});
		expect(result.current).toBe("deliver");
	});
});

describe("useConnectTypeOrUndefined", () => {
	it("returns the current connect type when set", () => {
		const { wrapper } = setup("learn");
		const { result } = renderHook(() => useConnectTypeOrUndefined(), {
			wrapper,
		});
		expect(result.current).toBe("learn");
	});

	it("returns undefined (not null) when connect type is not set", () => {
		const { wrapper } = setup(null);
		const { result } = renderHook(() => useConnectTypeOrUndefined(), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});
});
