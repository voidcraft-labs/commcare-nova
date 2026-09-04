// @vitest-environment happy-dom

import {
	fireEvent,
	render as rtlRender,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaseType } from "@/lib/domain";
import { eq, input, literal, prop, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { AssignedCasesSetting } from "../canvas/AssignedCasesSetting";
import { SearchConditionCanvas } from "../canvas/SearchConditionCanvas";

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

describe("Search-field dependency review focus", () => {
	it("reopens Assigned cases and focuses its labeled select", async () => {
		const value = term(input(testUuid("query")));
		const { rerender } = render(
			<AssignedCasesSetting value={value} onChange={vi.fn()} canEdit />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /more availability settings/i }),
		);
		expect(
			screen.queryByLabelText("Cases assigned to the person using the app"),
		).toBeNull();

		rerender(
			<AssignedCasesSetting
				value={value}
				onChange={vi.fn()}
				canEdit
				reviewRequest={{ token: 1 }}
			/>,
		);

		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByLabelText("Cases assigned to the person using the app"),
			);
		});
	});

	it("does not let Back autofocus overwrite an exact condition target", async () => {
		render(
			<SearchConditionCanvas
				context={{ kind: "input", slot: "match", label: "Region" }}
				value={eq(prop("client", "region"), input(testUuid("query")))}
				onChange={vi.fn()}
				onBack={vi.fn()}
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
				dependencyReview={{
					token: 1,
					path: ["right"],
					inputLabel: "Client name",
				}}
			/>,
		);

		await waitFor(() => {
			expect(document.activeElement).toBe(
				document.querySelector("[data-workbench-active-heading]"),
			);
			expect(
				document
					.querySelector("[data-workbench-focus-id]")
					?.getAttribute("data-workbench-focus-id"),
			).toBe('["right"]');
		});
		expect(document.activeElement).not.toBe(
			screen.getByRole("button", {
				name: "Back to Client name search field",
			}),
		);
	});

	it("focuses a newly created condition instead of Back", async () => {
		render(
			<SearchConditionCanvas
				context={{ kind: "search-button" }}
				value={eq(prop("client", "region"), literal("North"))}
				onChange={vi.fn()}
				onBack={vi.fn()}
				caseTypes={caseTypes}
				currentCaseType="client"
				focusRequest={{
					token: 1,
					path: [],
					focusTarget: "first-control",
				}}
			/>,
		);

		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole("button", {
					name: "Condition source: Case information",
				}),
			);
		});
		expect(document.activeElement).not.toBe(
			screen.getByRole("button", { name: "Back to Search" }),
		);
	});

	it("keeps its mount-effect dependency list stable across focus prop changes", () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const props = {
			context: { kind: "search-button" } as const,
			value: eq(prop("client", "region"), literal("North")),
			onChange: vi.fn(),
			onBack: vi.fn(),
			caseTypes,
			currentCaseType: "client",
		};
		const { rerender } = render(<SearchConditionCanvas {...props} />);

		rerender(
			<SearchConditionCanvas
				{...props}
				focusRequest={{ token: 1, path: [] }}
			/>,
		);

		expect(
			consoleError.mock.calls.some((call) =>
				call.some(
					(value) =>
						typeof value === "string" &&
						value.includes("dependency array changed size"),
				),
			),
		).toBe(false);
		consoleError.mockRestore();
	});

	it("keeps ordinary Search-condition navigation focused on Back", () => {
		render(
			<SearchConditionCanvas
				context={{ kind: "input", slot: "match", label: "Region" }}
				value={eq(prop("client", "region"), literal("North"))}
				onChange={vi.fn()}
				onBack={vi.fn()}
				caseTypes={caseTypes}
				currentCaseType="client"
			/>,
		);

		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Back to Search" }),
		);
	});
});
