// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FormFieldEntry } from "@/lib/doc/formFieldEntries";
import { asUuid, type SingleSelectField } from "@/lib/domain";
import type { LookupOptionsSource } from "@/lib/domain/lookupCarriers";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { eq, formField, literal, tableColumn } from "@/lib/domain/predicate";
import { OptionsSourceEditor } from "../OptionsSourceEditor";

const captured = vi.hoisted(() => ({
	workbenchProps: null as Record<string, unknown> | null,
	updateField: vi.fn(() => ({ ok: true as const, messages: [] as string[] })),
	openProjectData: vi.fn(),
}));

vi.mock("@/components/builder/shared/PredicateWorkbench", () => ({
	PredicateWorkbench: (props: Record<string, unknown>) => {
		captured.workbenchProps = props;
		return <div data-testid="predicate-workbench" />;
	},
}));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		inline: { updateField: captured.updateField },
	}),
}));

vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useCaseTypes: () => [],
}));

const MODULE = asUuid("11111111-1111-4111-8111-111111111111");
const FORM = asUuid("22222222-2222-4222-8222-222222222222");
const ROOT = asUuid("33333333-3333-4333-8333-333333333331");
const OUTER = asUuid("33333333-3333-4333-8333-333333333332");
const OUTER_VALUE = asUuid("33333333-3333-4333-8333-333333333333");
const INNER = asUuid("33333333-3333-4333-8333-333333333334");
const INNER_VALUE = asUuid("33333333-3333-4333-8333-333333333335");
const CURRENT = asUuid("33333333-3333-4333-8333-333333333336");
const LATER = asUuid("33333333-3333-4333-8333-333333333337");
const CHILD = asUuid("33333333-3333-4333-8333-333333333338");
const CHILD_VALUE = asUuid("33333333-3333-4333-8333-333333333339");
const SIBLING = asUuid("33333333-3333-4333-8333-333333333340");
const SIBLING_VALUE = asUuid("33333333-3333-4333-8333-333333333341");

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const CODE = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LABEL = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;

const entries: readonly FormFieldEntry[] = [
	{
		uuid: ROOT,
		id: "district",
		label: "District",
		kind: "text",
		dataType: "text",
		repeat: undefined,
		repeatAncestors: [],
	},
	{
		uuid: OUTER,
		id: "visits",
		label: "Visits",
		kind: "repeat",
		dataType: undefined,
		repeat: OUTER,
		repeatAncestors: [],
	},
	{
		uuid: OUTER_VALUE,
		id: "team",
		label: "Team",
		kind: "text",
		dataType: "text",
		repeat: OUTER,
		repeatAncestors: [OUTER],
	},
	{
		uuid: INNER,
		id: "facilities",
		label: "Facilities",
		kind: "repeat",
		dataType: undefined,
		repeat: INNER,
		repeatAncestors: [OUTER],
	},
	{
		uuid: INNER_VALUE,
		id: "facility_type",
		label: "Facility type",
		kind: "text",
		dataType: "text",
		repeat: INNER,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: CURRENT,
		id: "facility",
		label: "Facility",
		kind: "single_select",
		dataType: "single_select",
		repeat: INNER,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: LATER,
		id: "later",
		label: "Later",
		kind: "text",
		dataType: "text",
		repeat: INNER,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: CHILD,
		id: "child",
		label: "Child",
		kind: "repeat",
		dataType: undefined,
		repeat: CHILD,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: CHILD_VALUE,
		id: "child_value",
		label: "Child value",
		kind: "text",
		dataType: "text",
		repeat: CHILD,
		repeatAncestors: [OUTER, INNER, CHILD],
	},
	{
		uuid: SIBLING,
		id: "sibling",
		label: "Sibling",
		kind: "repeat",
		dataType: undefined,
		repeat: SIBLING,
		repeatAncestors: [],
	},
	{
		uuid: SIBLING_VALUE,
		id: "sibling_value",
		label: "Sibling value",
		kind: "text",
		dataType: "text",
		repeat: SIBLING,
		repeatAncestors: [SIBLING],
	},
];

vi.mock("@/lib/doc/hooks/useFormFieldEntries", () => ({
	useFormFieldEntries: () => entries,
}));

vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	useUserProperties: () => [],
}));

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ openProjectData: captured.openProjectData }),
	useSelectedFormContext: () => ({
		module: { uuid: MODULE },
		form: { uuid: FORM },
	}),
}));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => true,
}));

const columns = [
	{ id: CODE, wireName: "code", label: "Code", dataType: "text" as const },
	{
		id: LABEL,
		wireName: "label",
		label: "Label",
		dataType: "text" as const,
	},
] as const;

vi.mock("../useProjectLookupDefinitions", () => ({
	useProjectLookupDefinitions: () => {
		const table = { id: TABLE, name: "Facilities", columns };
		return {
			definitions: [table],
			byId: new Map([[TABLE, table]]),
			loadingFocused: false,
			loadingList: false,
			lookupContext: { kind: "unavailable" },
			listFailure: null,
			focusedFailure: null,
			retryList: vi.fn(),
			retryFocused: vi.fn(),
		};
	},
}));

const source = {
	kind: "lookup" as const,
	tableId: TABLE,
	valueColumnId: CODE,
	labelColumnId: LABEL,
};

function workbenchProps(): Record<string, unknown> {
	if (captured.workbenchProps === null) {
		throw new Error("Expected the predicate workbench to render.");
	}
	return captured.workbenchProps;
}

function field(filter?: LookupOptionsSource["filter"]) {
	return {
		uuid: CURRENT,
		id: "facility",
		kind: "single_select" as const,
		label: "Facility",
		optionsSource: { ...source, ...(filter !== undefined && { filter }) },
	} satisfies SingleSelectField;
}

describe("OptionsSourceEditor lookup-row filter", () => {
	it("mounts the shared editor with exact table-row scope and admitted earlier answers", () => {
		render(
			<OptionsSourceEditor
				field={field(eq(tableColumn(TABLE, CODE), literal("north")))}
				value={source}
				onChange={() => ({ ok: true })}
				label="Options source"
				keyName="optionsSource"
			/>,
		);

		expect(screen.getByTestId("predicate-workbench")).toBeDefined();
		expect(captured.workbenchProps).toMatchObject({
			caseDataScope: "table-row",
			currentCaseType: "",
			knownInputs: [],
			tableScope: { tableId: TABLE, columns },
			lookupTables: [{ id: TABLE, name: "Facilities", columns }],
			formFields: [
				expect.objectContaining({ uuid: ROOT }),
				expect.objectContaining({ uuid: OUTER_VALUE }),
				expect.objectContaining({ uuid: INNER_VALUE }),
			],
		});
		const offered = (
			workbenchProps().formFields as readonly { uuid: string }[]
		).map((entry) => entry.uuid);
		expect(offered).toEqual([ROOT, OUTER_VALUE, INNER_VALUE]);
		expect(offered).not.toContain(LATER);
		expect(offered).not.toContain(CHILD_VALUE);
		expect(offered).not.toContain(SIBLING_VALUE);
	});

	it("writes a complete source when the row rule changes or is removed", () => {
		const original = eq(tableColumn(TABLE, CODE), literal("north"));
		render(
			<OptionsSourceEditor
				field={field(original)}
				value={source}
				onChange={() => ({ ok: true })}
				label="Options source"
				keyName="optionsSource"
			/>,
		);
		const replacement = eq(tableColumn(TABLE, CODE), formField(ROOT));

		act(() => {
			(workbenchProps().onChange as (next: typeof replacement) => void)(
				replacement,
			);
		});
		expect(captured.updateField).toHaveBeenLastCalledWith(
			CURRENT,
			"single_select",
			{ optionsSource: { ...source, filter: replacement } },
		);

		act(() => {
			(workbenchProps().onRemoveRoot as () => void)();
		});
		expect(captured.updateField).toHaveBeenLastCalledWith(
			CURRENT,
			"single_select",
			{ optionsSource: source },
		);
	});

	it("seeds Add row rule from the active table column", () => {
		render(
			<OptionsSourceEditor
				field={field()}
				value={source}
				onChange={() => ({ ok: true })}
				label="Options source"
				keyName="optionsSource"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add row rule" }));
		expect(captured.updateField).toHaveBeenLastCalledWith(
			CURRENT,
			"single_select",
			{
				optionsSource: {
					...source,
					filter: eq(tableColumn(TABLE, CODE), literal("")),
				},
			},
		);
	});
});
