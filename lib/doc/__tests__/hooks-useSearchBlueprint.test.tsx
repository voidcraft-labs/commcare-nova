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
import type { AppBlueprint } from "@/lib/schemas/blueprint";

describe("useSearchBlueprint", () => {
	it("returns an empty array for an empty doc", () => {
		// No initialBlueprint → empty doc with zero modules.
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId="empty">{children}</BlueprintDocProvider>
		);

		const { result } = renderHook(() => useSearchBlueprint(), { wrapper });
		const search = result.current;
		expect(search("anything")).toEqual([]);
	});

	it("finds a question by label text", () => {
		const bp: AppBlueprint = {
			app_name: "Search Test",
			connect_type: undefined,
			case_types: null,
			modules: [
				{
					name: "Registration",
					forms: [
						{
							name: "Intake",
							type: "registration",
							questions: [
								{
									uuid: "q-name-0000-0000-0000-000000000000",
									id: "patient_name",
									type: "text",
									label: "Patient Full Name",
								},
								{
									uuid: "q-age-0000-0000-0000-000000000000",
									id: "age",
									type: "int",
									label: "Age in Years",
								},
							],
						},
					],
				},
			],
		};
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId="s" initialBlueprint={bp}>
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
