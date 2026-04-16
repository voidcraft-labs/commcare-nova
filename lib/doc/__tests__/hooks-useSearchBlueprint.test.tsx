// @vitest-environment happy-dom

/**
 * Tests for `useSearchBlueprint` — the client-side search hook that
 * converts the doc store to a denormalized blueprint and delegates to
 * the pure `searchBlueprint` function from `blueprintHelpers.ts`.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useSearchBlueprint } from "@/lib/doc/hooks/useSearchBlueprint";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

describe("useSearchBlueprint", () => {
	it("returns an empty array for an empty doc", () => {
		// No initialDoc → empty doc with zero modules.
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId="empty">{children}</BlueprintDocProvider>
		);

		const { result } = renderHook(() => useSearchBlueprint(), { wrapper });
		const search = result.current;
		expect(search("anything")).toEqual([]);
	});

	it("finds a question by label text", () => {
		const MOD = asUuid("module-1-uuid");
		const FORM = asUuid("form-1-uuid");
		const Q_NAME = asUuid("q-name-0000-0000-0000-000000000000");
		const Q_AGE = asUuid("q-age-0000-0000-0000-000000000000");

		const bp: BlueprintDoc = {
			appId: "s",
			appName: "Search Test",
			connectType: null,
			caseTypes: null,
			modules: {
				[MOD]: { uuid: MOD, id: "registration", name: "Registration" },
			},
			forms: {
				[FORM]: {
					uuid: FORM,
					id: "intake",
					name: "Intake",
					type: "registration",
				},
			},
			fields: {
				[Q_NAME]: {
					uuid: Q_NAME,
					id: "patient_name",
					kind: "text",
					label: "Patient Full Name",
				} as BlueprintDoc["fields"][typeof Q_NAME],
				[Q_AGE]: {
					uuid: Q_AGE,
					id: "age",
					kind: "int",
					label: "Age in Years",
				} as BlueprintDoc["fields"][typeof Q_AGE],
			},
			moduleOrder: [MOD],
			formOrder: { [MOD]: [FORM] },
			fieldOrder: { [FORM]: [Q_NAME, Q_AGE] },
			fieldParent: {},
		};
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId="s" initialDoc={bp}>
				{children}
			</BlueprintDocProvider>
		);

		const { result } = renderHook(() => useSearchBlueprint(), { wrapper });
		const search = result.current;

		// Search for "patient" should match the label "Patient Full Name".
		const hits = search("patient");
		expect(hits.length).toBeGreaterThan(0);
		expect(
			hits.some((r) => r.field === "label" && r.value === "Patient Full Name"),
		).toBe(true);

		// Search for "age" should match the question id "age" and its label.
		const ageHits = search("age");
		expect(ageHits.length).toBeGreaterThan(0);
		expect(ageHits.some((r) => r.type === "question")).toBe(true);
	});
});
