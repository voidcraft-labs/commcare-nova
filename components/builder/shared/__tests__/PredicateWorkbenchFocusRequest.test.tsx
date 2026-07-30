// @vitest-environment happy-dom

import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaseType } from "@/lib/domain";
import {
	and,
	eq,
	input,
	literal,
	prop,
	whenInput,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { PredicateWorkbench } from "../PredicateWorkbench";

// The surfaces here spell authored prose against the document; every production
// mount sits inside the builder's provider. Wrapping at `render` reproduces it
// and carries through each `rerender`.
function DocumentProvider({ children }: { readonly children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="test-app">{children}</BlueprintDocProvider>
	);
}

function render(ui: ReactElement) {
	return rtlRender(ui, { wrapper: DocumentProvider });
}

const caseTypes: readonly CaseType[] = [
	{
		name: "client",
		properties: [
			{ name: "case_name", label: proseText("Client name"), data_type: "text" },
			{ name: "region", label: proseText("Region"), data_type: "text" },
		],
	},
];

function activeRegion(path: readonly (string | number)[]): HTMLElement {
	const id = JSON.stringify(path);
	const region = [
		...document.querySelectorAll<HTMLElement>("[data-workbench-focus-id]"),
	].find((candidate) => candidate.dataset.workbenchFocusId === id);
	if (region === undefined) throw new Error(`Missing active region ${id}`);
	return region;
}

describe("PredicateWorkbench dependency focus", () => {
	it("opens and focuses the exact nested expression occurrence", async () => {
		const value = and(
			eq(prop("client", "region"), literal("North")),
			eq(prop("client", "case_name"), input(testUuid("query"))),
		);

		render(
			<PredicateWorkbench
				value={value}
				onChange={vi.fn()}
				caseTypes={caseTypes}
				currentCaseType="client"
				knownInputs={[
					{
						uuid: testUuid("query"),
						name: "query",
						label: "Client name",
						data_type: "text",
					},
				]}
				focusRequest={{ token: 1, path: ["and", 1, "right"] }}
			/>,
		);

		await waitFor(() => {
			expect(
				activeRegion(["and", 1, "right"]).contains(document.activeElement),
			).toBe(true);
		});
	});

	it("recovers a trigger path to its owning rule and replays the same path", async () => {
		const value = whenInput(
			input(testUuid("query")),
			eq(prop("client", "region"), literal("North")),
		);
		const { rerender } = render(
			<PredicateWorkbench
				value={value}
				onChange={vi.fn()}
				caseTypes={caseTypes}
				currentCaseType="client"
				knownInputs={[
					{
						uuid: testUuid("query"),
						name: "query",
						label: "Client name",
						data_type: "text",
					},
				]}
				focusRequest={{
					token: 1,
					path: ["when-input-present", "input"],
				}}
			/>,
		);
		await waitFor(() => {
			expect(activeRegion([]).contains(document.activeElement)).toBe(true);
		});

		screen.getByRole("button", { name: "Change condition type" }).focus();
		rerender(
			<PredicateWorkbench
				value={value}
				onChange={vi.fn()}
				caseTypes={caseTypes}
				currentCaseType="client"
				knownInputs={[
					{
						uuid: testUuid("query"),
						name: "query",
						label: "Client name",
						data_type: "text",
					},
				]}
				focusRequest={{
					token: 2,
					path: ["when-input-present", "input"],
				}}
			/>,
		);
		await waitFor(() => {
			expect(activeRegion([]).contains(document.activeElement)).toBe(true);
		});
	});
});
