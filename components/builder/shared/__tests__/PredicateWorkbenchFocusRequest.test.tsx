// @vitest-environment happy-dom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	and,
	eq,
	input,
	literal,
	prop,
	whenInput,
} from "@/lib/domain/predicate";
import { PredicateWorkbench } from "../PredicateWorkbench";

const caseTypes: readonly CaseType[] = [
	{
		name: "client",
		properties: [
			{ name: "case_name", label: "Client name", data_type: "text" },
			{ name: "region", label: "Region", data_type: "text" },
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
			eq(prop("client", "case_name"), input("query")),
		);

		render(
			<PredicateWorkbench
				value={value}
				onChange={vi.fn()}
				caseTypes={caseTypes}
				currentCaseType="client"
				knownInputs={[
					{ name: "query", label: "Client name", data_type: "text" },
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
			input("query"),
			eq(prop("client", "region"), literal("North")),
		);
		const { rerender } = render(
			<PredicateWorkbench
				value={value}
				onChange={vi.fn()}
				caseTypes={caseTypes}
				currentCaseType="client"
				knownInputs={[
					{ name: "query", label: "Client name", data_type: "text" },
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
					{ name: "query", label: "Client name", data_type: "text" },
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
