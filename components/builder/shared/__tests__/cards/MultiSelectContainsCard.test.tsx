// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { type ComponentProps, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activateWithEnter,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaseType } from "@/lib/domain";
import {
	literal,
	multiSelectAny,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { PredicateCardEditor as ProductionPredicateCardEditor } from "../../PredicateCardEditor";

// The card spells each option's authored label against the document; every
// production mount sits inside the builder's provider.
function PredicateCardEditor(
	props: ComponentProps<typeof ProductionPredicateCardEditor>,
) {
	return (
		<BlueprintDocProvider appId="test-app">
			<ProductionPredicateCardEditor {...props} />
		</BlueprintDocProvider>
	);
}

const OPTIONS = [
	{ value: "a", label: proseText("Alpha") },
	{ value: "b", label: proseText("Beta") },
	{ value: "c", label: proseText("Gamma") },
	{ value: "d", label: proseText("Delta") },
] as const;

type CaseOption = NonNullable<
	CaseType["properties"][number]["options"]
>[number];

function caseType(options: readonly CaseOption[] = OPTIONS): CaseType {
	return {
		name: "patient",
		properties: [
			{
				name: "tags",
				label: proseText("Tags"),
				data_type: "multi_select",
				options: [...options],
			},
		],
	};
}

function seed(...values: string[]): Predicate {
	const [first = "", ...rest] = values;
	return multiSelectAny(
		prop("patient", "tags"),
		literal(first),
		...rest.map((value) => literal(value)),
	);
}

function Controlled({
	initial,
	patient = caseType(),
}: {
	readonly initial: Predicate;
	readonly patient?: CaseType;
}) {
	const [value, setValue] = useState(initial);
	return (
		<PredicateCardEditor
			value={value}
			onChange={setValue}
			caseTypes={[patient]}
			currentCaseType="patient"
		/>
	);
}

afterEach(async () => {
	cleanup();
	await settleBaseUiTransitions();
});

describe("MultiSelectContainsCard", () => {
	it("uses Nova's information vocabulary for the picker and empty state", () => {
		render(<Controlled initial={seed("")} patient={caseType([])} />);
		expect(
			screen.getByRole("button", {
				name: "Multiple-choice information: Tags",
			}),
		).toBeDefined();
		expect(
			screen.getByText("This information has no choices yet"),
		).toBeDefined();
	});

	it("keeps storage values quiet when authored labels are unique", () => {
		render(
			<Controlled
				initial={seed("vip", "new")}
				patient={caseType([
					{ value: "vip", label: proseText("Priority client") },
					{ value: "new", label: proseText("New client") },
				])}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Remove Priority client" }),
		).toBeDefined();
		expect(screen.queryByText("(vip)")).toBeNull();
		expect(screen.queryByText("Saved as vip")).toBeNull();
	});

	it("reveals storage values only when duplicate labels need disambiguation", () => {
		render(
			<Controlled
				initial={seed("open_a", "closed")}
				patient={caseType([
					{ value: "open_a", label: proseText("Open") },
					{ value: "open_b", label: proseText("Open") },
					{ value: "closed", label: proseText("Closed") },
				])}
			/>,
		);
		expect(screen.getByText("(open_a)")).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: "Remove Open, saved as open_a",
			}),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add option" }));
		expect(screen.getByText("Saved as open_b")).toBeDefined();
	});

	it("removes an invalid non-string value by its authored chip index", async () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={multiSelectAny(
					prop("patient", "tags"),
					literal(7),
					literal("a"),
				)}
				onChange={onChange}
				caseTypes={[caseType()]}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Remove 7" }));
		// Removal restores focus to the surviving chip once React commits, and
		// that chip's tooltip opens on focus.
		await settleBaseUiTransitions();

		expect(onChange).toHaveBeenLastCalledWith(seed("a"));
	});

	it("focuses the next chip after keyboard deletion", async () => {
		render(<Controlled initial={seed("a", "b", "c")} />);
		activateWithEnter(screen.getByRole("button", { name: "Remove Beta" }));
		const next = screen.getByRole("button", { name: "Remove Gamma" });
		await waitFor(() => expect(document.activeElement).toBe(next));
	});

	it("focuses the previous chip when no next chip existed", async () => {
		render(<Controlled initial={seed("a", "b", "c", "d")} />);
		activateWithEnter(screen.getByRole("button", { name: "Remove Delta" }));
		const previous = screen.getByRole("button", { name: "Remove Gamma" });
		await waitFor(() => expect(document.activeElement).toBe(previous));
	});

	it("focuses Add option when the surviving chip is no longer removable", async () => {
		render(<Controlled initial={seed("a", "b")} />);
		activateWithEnter(screen.getByRole("button", { name: "Remove Alpha" }));
		const add = screen.getByRole("button", { name: "Add option" });
		await waitFor(() => expect(document.activeElement).toBe(add));
	});
});
