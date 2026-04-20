// @vitest-environment happy-dom
//
// Tests for `useFormDescendantCount` — the recursive descendant-count
// hook used by AppTree FormCard's "N q" badge. Distinct from
// `useChildFieldCount`, which counts direct children only.

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useFormDescendantCount } from "@/lib/doc/hooks/useFieldIconMap";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

// Tree shape for these tests:
//   FORM_UUID
//     ├── Q_NAME        (leaf)
//     └── Q_GROUP       (group with nested children)
//           ├── Q_AGE   (leaf)
//           └── Q_SUB   (nested group with a leaf)
//                 └── Q_NOTE
// Total descendants under FORM_UUID = 5.
// Total descendants under Q_GROUP  = 3.
// Total descendants under Q_SUB    = 1.
const MOD_UUID = asUuid("module-1-uuid");
const FORM_UUID = asUuid("form-1-uuid");
const Q_NAME = asUuid("q-name-0000-0000-0000-000000000000");
const Q_GROUP = asUuid("q-grp--0000-0000-0000-000000000000");
const Q_AGE = asUuid("q-age--0000-0000-0000-000000000000");
const Q_SUB = asUuid("q-sub--0000-0000-0000-000000000000");
const Q_NOTE = asUuid("q-note-0000-0000-0000-000000000000");

function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Descendant Count Test",
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
			[Q_GROUP]: {
				uuid: Q_GROUP,
				id: "basics",
				kind: "group",
				label: "Basics",
			} as BlueprintDoc["fields"][string],
			[Q_AGE]: {
				uuid: Q_AGE,
				id: "age",
				kind: "int",
				label: "Age",
			} as BlueprintDoc["fields"][string],
			[Q_SUB]: {
				uuid: Q_SUB,
				id: "followup",
				kind: "group",
				label: "Followup",
			} as BlueprintDoc["fields"][string],
			[Q_NOTE]: {
				uuid: Q_NOTE,
				id: "note",
				kind: "text",
				label: "Note",
			} as BlueprintDoc["fields"][string],
		},
		moduleOrder: [MOD_UUID],
		formOrder: { [MOD_UUID]: [FORM_UUID] },
		fieldOrder: {
			[FORM_UUID]: [Q_NAME, Q_GROUP],
			[Q_GROUP]: [Q_AGE, Q_SUB],
			[Q_SUB]: [Q_NOTE],
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

describe("useFormDescendantCount", () => {
	it("counts every descendant under a form (including nested groups)", () => {
		// FormCard's "N q" badge should show 5 for this fixture — the
		// recursive walk descends into Q_GROUP and Q_SUB, not just the form's
		// two direct children.
		const { wrapper } = setup();
		const { result } = renderHook(() => useFormDescendantCount(FORM_UUID), {
			wrapper,
		});
		expect(result.current).toBe(5);
	});

	it("counts every descendant under a nested group", () => {
		// Under Q_GROUP we should see Q_AGE + Q_SUB + Q_NOTE = 3.
		const { wrapper } = setup();
		const { result } = renderHook(() => useFormDescendantCount(Q_GROUP), {
			wrapper,
		});
		expect(result.current).toBe(3);
	});

	it("returns 0 when the parent uuid has no children in fieldOrder", () => {
		// An unknown parent uuid gets 0 — the walker starts from
		// `fieldOrder[parent] ?? []` so the branch is safe.
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useFormDescendantCount(asUuid("no-such-uuid")),
			{ wrapper },
		);
		expect(result.current).toBe(0);
	});

	it("returns 0 when called with undefined", () => {
		// Accepting `Uuid | undefined` lets call sites pass URL-derived
		// optional uuids without guarding the hook — the hook itself short-
		// circuits to 0 rather than walking `fieldOrder[undefined]`.
		const { wrapper } = setup();
		const { result } = renderHook(() => useFormDescendantCount(undefined), {
			wrapper,
		});
		expect(result.current).toBe(0);
	});
});
