// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useSearchFilter } from "@/lib/doc/hooks/useSearchFilter";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";
import { buildFixture } from "./searchFilterFixture";

// React is retained only for active/idle subscription ownership. Search
// matches, ancestor visibility, and localized offsets are direct state tests.
function wrapWithDoc(doc?: BlueprintDoc, language: string | null = null) {
	if (doc) assertAdmittedDoc(doc);
	return ({ children }: { children: ReactNode }) => (
		<BlueprintDocProvider appId={doc?.appId ?? "empty"} initialDoc={doc}>
			<BlueprintAuthoringLanguageContext value={language}>
				{children}
			</BlueprintAuthoringLanguageContext>
		</BlueprintDocProvider>
	);
}
describe("search subscription lifecycle", () => {
	it("stays unsubscribed while idle and observes the latest labels when search starts", () => {
		let renders = 0;
		const { result, rerender } = renderHook(
			({ query }) => {
				renders++;
				return {
					search: useSearchFilter(query),
					edit: useBlueprintMutations(),
				};
			},
			{ initialProps: { query: "" }, wrapper: wrapWithDoc(buildFixture()) },
		);
		const before = renders;
		const uuid = testUuid("q-name-0000-0000-0000-000000000000");
		act(() =>
			expect(
				result.current.edit.updateField(uuid, "text", {
					label: proseText("New nickname"),
				}),
			).toEqual({ ok: true }),
		);
		expect(renders).toBe(before);
		expect(result.current.search).toBeNull();
		rerender({ query: "nickname" });
		expect(result.current.search?.matchMap.get(uuid)).toEqual([[4, 12]]);
		act(() =>
			expect(
				result.current.edit.updateField(uuid, "text", {
					label: proseText("Given name"),
				}),
			).toEqual({ ok: true }),
		);
		expect(result.current.search?.visibleFieldUuids.size).toBe(0);
		rerender({ query: "given" });
		expect(result.current.search?.matchMap.get(uuid)).toEqual([[0, 5]]);
	});
});
