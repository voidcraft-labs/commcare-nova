// @vitest-environment happy-dom
//
// Tests for `useFieldKind` and `useChildFieldCount` — the two narrow
// selectors used by AppTree row rendering. These exist because row
// components were subscribing to entire `fields[uuid]` entities just to
// display the kind or child count, causing unnecessary re-renders on any
// field mutation.

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useChildFieldCount, useFieldKind } from "@/lib/doc/hooks/useFieldKind";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const MOD_UUID = asUuid("module-1-uuid");
const FORM_UUID = asUuid("form-1-uuid");
const Q_NAME = asUuid("q-name-0000-0000-0000-000000000000");
const Q_AGE = asUuid("q-age-0000-0000-0000-000000000000");
const Q_GROUP = asUuid("q-group-0000-0000-0000-00000000000");

function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Field Kind Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD_UUID]: { uuid: MOD_UUID, id: "registration", name: "Registration" },
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "reg_form",
				name: "Reg Form",
				type: "registration",
			},
		},
		fields: {
			[Q_NAME]: {
				uuid: Q_NAME,
				id: "name",
				kind: "text",
				label: "Name",
			} as BlueprintDoc["fields"][string],
			[Q_AGE]: {
				uuid: Q_AGE,
				id: "age",
				kind: "int",
				label: "Age",
			} as BlueprintDoc["fields"][string],
			[Q_GROUP]: {
				uuid: Q_GROUP,
				id: "basics",
				kind: "group",
				label: "Basics",
			} as BlueprintDoc["fields"][string],
		},
		moduleOrder: [MOD_UUID],
		formOrder: { [MOD_UUID]: [FORM_UUID] },
		// Form has two direct children (name, group); group has one child (age).
		fieldOrder: {
			[FORM_UUID]: [Q_NAME, Q_GROUP],
			[Q_GROUP]: [Q_AGE],
		},
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

describe("useFieldKind", () => {
	it("returns the kind of the referenced field", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useFieldKind(Q_NAME), { wrapper });
		expect(result.current).toBe("text");
	});

	it("returns undefined for an unknown uuid", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useFieldKind(asUuid("does-not-exist")),
			{ wrapper },
		);
		expect(result.current).toBeUndefined();
	});

	it("returns undefined when called with undefined (no uuid to look up)", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useFieldKind(undefined), { wrapper });
		expect(result.current).toBeUndefined();
	});
});

describe("useChildFieldCount", () => {
	it("returns the number of direct children under the form", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useChildFieldCount(FORM_UUID), {
			wrapper,
		});
		expect(result.current).toBe(2);
	});

	it("returns the number of direct children under a group", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useChildFieldCount(Q_GROUP), {
			wrapper,
		});
		expect(result.current).toBe(1);
	});

	it("returns 0 when the parent uuid has no children in fieldOrder", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useChildFieldCount(asUuid("no-children-uuid")),
			{ wrapper },
		);
		expect(result.current).toBe(0);
	});

	it("returns 0 when called with undefined", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useChildFieldCount(undefined), {
			wrapper,
		});
		expect(result.current).toBe(0);
	});
});
