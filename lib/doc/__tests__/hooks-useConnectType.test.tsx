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
import {
	useConnectType,
	useConnectTypeOrUndefined,
} from "@/lib/doc/hooks/useConnectType";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { ConnectType } from "@/lib/domain";

function setup(connectType: ConnectType | null) {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Connect Test",
		connectType,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
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
		store.temporal.getState().resume();
		act(() => {
			store
				.getState()
				.applyMany([{ kind: "setConnectType", connectType: "deliver" }]);
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
