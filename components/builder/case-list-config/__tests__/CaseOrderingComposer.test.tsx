// @vitest-environment happy-dom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
	type CaseType,
	type Column,
	calculatedColumn,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import { CaseOrderingComposer } from "../SortPriorityStack";
import { resolveSortedColumns } from "../sortPriority";

const session = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => session.canEdit,
}));

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Patient name", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};

function column(
	uuidSuffix: string,
	field: string,
	header: string,
	order: string,
	sort?: Column["sort"],
): Column {
	return {
		uuid: asUuid(`00000000-0000-4000-8000-${uuidSuffix.padStart(12, "0")}`),
		kind: "plain",
		field,
		header,
		order,
		...(sort === undefined ? {} : { sort }),
	};
}

const NAME = column("1", "case_name", "Patient name", "a", {
	direction: "asc",
	priority: 0,
});
const DOB = column("2", "dob", "Date of birth", "b");
const AGE = column("3", "age", "Age", "c", {
	direction: "desc",
	priority: 1,
});

function ControlledComposer({
	initial,
	onChange,
}: {
	readonly initial: readonly Column[];
	readonly onChange: (next: readonly Column[]) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<CaseOrderingComposer
			value={value}
			caseType={PATIENT}
			caseTypes={[PATIENT]}
			onChange={(next) => {
				onChange(next);
				setValue([...next]);
			}}
		/>
	);
}

async function settleMenuAnimation() {
	await act(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
}

describe("CaseOrderingComposer", () => {
	beforeEach(() => {
		session.canEdit = true;
	});

	it("adds, changes, and removes a natural type-aware ordering rule", async () => {
		const onChange = vi.fn();
		render(
			<ControlledComposer initial={[NAME, DOB, AGE]} onChange={onChange} />,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Add another way to sort cases" }),
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Date of birth" }));

		const dateRule = screen
			.getByRole("button", {
				name: "Remove Date of birth from default order",
			})
			.closest<HTMLElement>("[data-case-ordering-rule]");
		expect(dateRule).not.toBeNull();
		if (dateRule === null) throw new Error("Date ordering rule was not found");
		expect(within(dateRule).getByText("Earliest first")).toBeDefined();
		expect(onChange).toHaveBeenCalledTimes(1);

		fireEvent.click(
			within(dateRule).getByRole("button", {
				name: /change direction for date of birth.*earliest first/i,
			}),
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Latest first" }));

		expect(
			onChange.mock.calls
				.at(-1)?.[0]
				.find((entry: Column) => entry.uuid === DOB.uuid)?.sort,
		).toEqual({ direction: "desc", priority: 2 });

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove Date of birth from default order",
			}),
		);
		expect(
			onChange.mock.calls
				.at(-1)?.[0]
				.find((entry: Column) => entry.uuid === DOB.uuid)?.sort,
		).toBeUndefined();
		expect(onChange).toHaveBeenCalledTimes(3);

		await settleMenuAnimation();
	});

	it("uses First and Then copy and announces keyboard reordering", () => {
		const onChange = vi.fn();
		const dateSorted: Column = {
			...DOB,
			sort: { direction: "asc", priority: 2 },
		};
		render(
			<ControlledComposer
				initial={[NAME, AGE, dateSorted]}
				onChange={onChange}
			/>,
		);

		expect(screen.getByText("First")).toBeDefined();
		expect(screen.getAllByText("Then")).toHaveLength(2);
		expect(screen.getByText("A to Z")).toBeDefined();
		expect(screen.getByText("Highest first")).toBeDefined();
		expect(screen.getByText("Earliest first")).toBeDefined();

		fireEvent.keyDown(
			screen.getByRole("button", { name: /reorder patient name/i }),
			{ key: "ArrowDown" },
		);

		const latest = onChange.mock.calls.at(-1)?.[0] as readonly Column[];
		expect(
			[...latest]
				.filter((entry) => entry.sort !== undefined)
				.sort((a, b) => (a.sort?.priority ?? 0) - (b.sort?.priority ?? 0))
				.map((entry) => entry.uuid),
		).toEqual([AGE.uuid, NAME.uuid, DOB.uuid]);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes after Age.",
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /reorder patient name/i }),
			{ key: "Home" },
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes first.",
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /reorder patient name/i }),
			{ key: "End" },
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes after Date of birth.",
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /reorder patient name/i }),
			{ key: "ArrowUp" },
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes after Age.",
		);
	});

	it("uses the calculated result type for friendly directions", () => {
		const score = {
			...calculatedColumn(
				asUuid("00000000-0000-4000-8000-000000000090"),
				"Risk score",
				term(prop("patient", "age")),
			),
			sort: { direction: "asc" as const, priority: 0 },
		};
		const nextVisit = {
			...calculatedColumn(
				asUuid("00000000-0000-4000-8000-000000000091"),
				"Calculated visit date",
				term(prop("patient", "dob")),
			),
			sort: { direction: "desc" as const, priority: 1 },
		};

		render(
			<CaseOrderingComposer
				value={[score, nextVisit]}
				caseType={PATIENT}
				caseTypes={[PATIENT]}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByText("Lowest first")).toBeDefined();
		expect(screen.getByText("Latest first")).toBeDefined();
		expect(screen.queryByText("A to Z")).toBeNull();
	});

	it("uses canonical fallback labels for legacy default-order fields", () => {
		const legacyCaseType: CaseType = {
			name: "legacy_patient",
			properties: [
				{ name: "case_name", label: "case_name", data_type: "text" },
				{ name: "external_id", label: "external_id", data_type: "text" },
				{ name: "date_opened", label: "date_opened", data_type: "datetime" },
			],
		};
		const legacyColumns = [
			column("101", "name", "", "a", { direction: "asc", priority: 0 }),
			column("102", "external-id", "", "b", {
				direction: "asc",
				priority: 1,
			}),
			column("103", "date-opened", "", "c", {
				direction: "desc",
				priority: 2,
			}),
		];

		render(
			<CaseOrderingComposer
				value={legacyColumns}
				caseType={legacyCaseType}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByText("Case name")).toBeDefined();
		expect(screen.getByText("External ID")).toBeDefined();
		expect(screen.getByText("Date opened")).toBeDefined();
		expect(screen.getByText("Latest first")).toBeDefined();
		expect(screen.queryByText("External id")).toBeNull();
		expect(screen.queryByText("Name")).toBeNull();
	});

	it("breaks equal priorities by the independent Results arrangement", () => {
		const laterInResults = {
			...NAME,
			listOrder: "z",
			sort: { direction: "asc" as const, priority: 0 },
		};
		const firstInResults = {
			...AGE,
			listOrder: "a",
			sort: { direction: "desc" as const, priority: 0 },
		};

		expect(
			resolveSortedColumns([laterInResults, firstInResults]).map(
				(column) => column.uuid,
			),
		).toEqual([firstInResults.uuid, laterInResults.uuid]);
	});

	it("shows the ordering without edit affordances to viewers", () => {
		session.canEdit = false;
		render(
			<CaseOrderingComposer
				value={[NAME, DOB, AGE]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByText("Default order")).toBeDefined();
		expect(screen.getByText("A to Z")).toBeDefined();
		expect(
			screen.queryByRole("button", {
				name: "Add another way to sort cases",
			}),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /reorder patient name/i }),
		).toBeNull();
		expect(
			screen.queryByRole("button", {
				name: /remove patient name from default order/i,
			}),
		).toBeNull();
	});
});
