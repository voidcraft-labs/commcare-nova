// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import type { EditorLookupTableDecl } from "@/components/builder/shared/lookupTablePresentation";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CommitOutcome } from "@/lib/domain";
import {
	asUuid,
	type LookupColumnId,
	type LookupTableId,
	type SelectOptionsSource,
	type SingleSelectField,
} from "@/lib/domain";
import { eq, formField, literal, tableColumn } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { OptionsSourceEditor } from "../OptionsSourceEditor";

const captured = vi.hoisted(() => ({
	workbenchProps: null as Record<string, unknown> | null,
	catalog: null as Record<string, unknown> | null,
}));

vi.mock("@/components/builder/shared/PredicateWorkbench", () => ({
	PredicateWorkbench: (props: Record<string, unknown>) => {
		captured.workbenchProps = props;
		return <div data-testid="predicate-workbench" />;
	},
}));

vi.mock("@/components/builder/lookup/BuilderLookupCatalogProvider", () => ({
	useBuilderLookupCatalog: () => captured.catalog,
}));

vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useCaseTypes: () => [],
}));

vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	useUserProperties: () => [],
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
const EMPTY_TABLE = "018f3e8a-7b2c-7def-8abc-1234567890af" as LookupTableId;

const entries = [
	{
		uuid: ROOT,
		id: "district",
		label: "District",
		kind: "text" as const,
		dataType: "text" as const,
		repeat: undefined,
		repeatAncestors: [],
	},
	{
		uuid: OUTER,
		id: "visits",
		label: "Visits",
		kind: "repeat" as const,
		dataType: undefined,
		repeat: OUTER,
		repeatAncestors: [],
	},
	{
		uuid: OUTER_VALUE,
		id: "team",
		label: "Team",
		kind: "text" as const,
		dataType: "text" as const,
		repeat: OUTER,
		repeatAncestors: [OUTER],
	},
	{
		uuid: INNER,
		id: "facilities",
		label: "Facilities",
		kind: "repeat" as const,
		dataType: undefined,
		repeat: INNER,
		repeatAncestors: [OUTER],
	},
	{
		uuid: INNER_VALUE,
		id: "facility_type",
		label: "Facility type",
		kind: "text" as const,
		dataType: "text" as const,
		repeat: INNER,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: CURRENT,
		id: "facility",
		label: "Facility",
		kind: "single_select" as const,
		dataType: "single_select" as const,
		repeat: INNER,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: LATER,
		id: "later",
		label: "Later",
		kind: "text" as const,
		dataType: "text" as const,
		repeat: INNER,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: CHILD,
		id: "child",
		label: "Child",
		kind: "repeat" as const,
		dataType: undefined,
		repeat: CHILD,
		repeatAncestors: [OUTER, INNER],
	},
	{
		uuid: CHILD_VALUE,
		id: "child_value",
		label: "Child value",
		kind: "text" as const,
		dataType: "text" as const,
		repeat: CHILD,
		repeatAncestors: [OUTER, INNER, CHILD],
	},
	{
		uuid: SIBLING,
		id: "sibling",
		label: "Sibling",
		kind: "repeat" as const,
		dataType: undefined,
		repeat: SIBLING,
		repeatAncestors: [],
	},
	{
		uuid: SIBLING_VALUE,
		id: "sibling_value",
		label: "Sibling value",
		kind: "text" as const,
		dataType: "text" as const,
		repeat: SIBLING,
		repeatAncestors: [SIBLING],
	},
] as const;

vi.mock("@/lib/doc/hooks/useFormFieldEntries", () => ({
	useFormFieldEntries: () => entries,
}));

vi.mock("@/lib/routing/hooks", () => ({
	useSelectedFormContext: () => ({
		module: { uuid: MODULE },
		form: { uuid: FORM },
	}),
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

const table = { id: TABLE, name: "Facilities", columns };
const emptyTable: EditorLookupTableDecl = {
	id: EMPTY_TABLE,
	name: "Empty table",
	columns: [],
};

function readyCatalog(
	tables: readonly EditorLookupTableDecl[] = [table],
): Record<string, unknown> {
	return {
		kind: "ready" as const,
		definitions: [],
		tables,
		byId: new Map(tables.map((candidate) => [candidate.id, candidate])),
		lookupContext: { kind: "unavailable" as const },
		retry: vi.fn(async () => undefined),
	};
}

const inlineSource: SelectOptionsSource = {
	kind: "inline",
	options: [
		{
			uuid: asUuid("44444444-4444-4444-8444-444444444441"),
			value: "one",
			label: proseText("One"),
		},
		{
			uuid: asUuid("44444444-4444-4444-8444-444444444442"),
			value: "two",
			label: proseText("Two"),
		},
	],
};

const lookupSource = {
	kind: "lookup" as const,
	tableId: TABLE,
	valueColumnId: CODE,
	labelColumnId: LABEL,
};

function field(source: SelectOptionsSource): SingleSelectField {
	return {
		uuid: CURRENT,
		id: "facility",
		kind: "single_select",
		label: proseText("Facility"),
		optionsSource: source,
	};
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<BlueprintDocProvider>
		<BuilderSessionProvider init={{ canEdit: true }}>
			{children}
		</BuilderSessionProvider>
	</BlueprintDocProvider>
);

function renderEditor(
	source: SelectOptionsSource,
	onChange: (next: SelectOptionsSource) => CommitOutcome,
) {
	return render(
		<OptionsSourceEditor
			field={field(source)}
			value={source}
			onChange={onChange}
			label="Where the choices come from"
			keyName="optionsSource"
		/>,
		{ wrapper },
	);
}

function currentWorkbenchProps(): Record<string, unknown> {
	const props = captured.workbenchProps;
	if (props === null) throw new Error("Predicate workbench was not rendered");
	return props;
}

function pressSelectOption(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
}

async function choose(comboboxName: string, optionName: string): Promise<void> {
	fireEvent.click(screen.getByRole("combobox", { name: comboboxName }));
	await settleBaseUiTransitions();
	pressSelectOption(screen.getByRole("option", { name: optionName }));
	await settleBaseUiTransitions();
}

describe("OptionsSourceEditor", () => {
	it("stages Inline → Table and persists one complete lookup arm only on confirmation", async () => {
		captured.catalog = readyCatalog();
		const onChange = vi.fn(
			(_next: SelectOptionsSource): CommitOutcome => ({ ok: true }),
		);
		renderEditor(inlineSource, onChange);

		await choose("Where the choices come from", "Facilities");
		expect(onChange).not.toHaveBeenCalled();
		expect(
			screen
				.getByRole("button", { name: "Use this table" })
				.hasAttribute("disabled"),
		).toBe(true);

		await choose("Value that gets saved", "Code");
		await choose("Value people see", "Label");
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Use this table" }));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({
			kind: "lookup",
			tableId: TABLE,
			valueColumnId: CODE,
			labelColumnId: LABEL,
		});
		expect(Object.keys(onChange.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
			"kind",
			"labelColumnId",
			"tableId",
			"valueColumnId",
		]);
	});

	it("cancels a staged source without clearing or replacing the committed source", async () => {
		captured.catalog = readyCatalog();
		const onChange = vi.fn(
			(_next: SelectOptionsSource): CommitOutcome => ({ ok: true }),
		);
		renderEditor(inlineSource, onChange);

		await choose("Where the choices come from", "Facilities");
		await choose("Value that gets saved", "Code");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue("one")).toBeDefined();
		expect(screen.getByDisplayValue("two")).toBeDefined();
	});

	it("stages Table → Inline with fresh option identities and no dormant lookup receiver", async () => {
		captured.catalog = readyCatalog();
		const onChange = vi.fn(
			(_next: SelectOptionsSource): CommitOutcome => ({ ok: true }),
		);
		renderEditor(lookupSource, onChange);

		await choose("Where the choices come from", "Options in this question");
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue("option_1")).toBeDefined();
		expect(screen.getByDisplayValue("option_2")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Use these options" }));
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0]?.[0] as SelectOptionsSource;
		expect(next.kind).toBe("inline");
		if (next.kind !== "inline") throw new Error("expected inline source");
		expect(next.options).toHaveLength(2);
		expect(new Set(next.options.map((option) => option.uuid)).size).toBe(2);
		expect(next.options.every((option) => option.uuid.includes("-4"))).toBe(
			true,
		);
		expect(Object.keys(next).sort()).toEqual(["kind", "options"]);
	});

	it("keeps a rejected staged replacement open with the exact gate finding", async () => {
		captured.catalog = readyCatalog();
		const onChange = vi.fn(
			(_next: SelectOptionsSource): CommitOutcome => ({
				ok: false,
				messages: ["That table changed. Choose its current columns."],
			}),
		);
		renderEditor(inlineSource, onChange);

		await choose("Where the choices come from", "Facilities");
		await choose("Value that gets saved", "Code");
		await choose("Value people see", "Label");
		fireEvent.click(screen.getByRole("button", { name: "Use this table" }));

		expect(
			screen.getByRole("button", { name: "Use this table" }),
		).toBeDefined();
		expect(
			screen.getByText("That table changed. Choose its current columns."),
		).toBeDefined();
	});

	it("mounts row-filter authoring in exact table-row and earlier-answer scope", () => {
		captured.catalog = readyCatalog();
		captured.workbenchProps = null;
		const original = eq(tableColumn(TABLE, CODE), literal("north"));
		const source = { ...lookupSource, filter: original };
		const onChange = vi.fn(
			(_next: SelectOptionsSource): CommitOutcome => ({ ok: true }),
		);
		renderEditor(source, onChange);

		expect(screen.getByTestId("predicate-workbench")).toBeDefined();
		expect(captured.workbenchProps).toMatchObject({
			caseDataScope: "table-row",
			currentCaseType: "",
			knownInputs: [],
			tableScope: { tableId: TABLE, columns },
			lookupTables: [table],
			formFields: [
				expect.objectContaining({ uuid: ROOT }),
				expect.objectContaining({ uuid: OUTER_VALUE }),
				expect.objectContaining({ uuid: INNER_VALUE }),
			],
		});
		const workbenchProps = currentWorkbenchProps();
		const offered = (
			workbenchProps.formFields as readonly { uuid: string }[]
		).map((entry) => entry.uuid);
		expect(offered).toEqual([ROOT, OUTER_VALUE, INNER_VALUE]);
		expect(offered).not.toContain(LATER);
		expect(offered).not.toContain(CHILD_VALUE);
		expect(offered).not.toContain(SIBLING_VALUE);

		const replacement = eq(tableColumn(TABLE, LABEL), formField(ROOT));
		act(() => {
			(workbenchProps.onChange as (next: typeof replacement) => void)(
				replacement,
			);
		});
		expect(onChange).toHaveBeenLastCalledWith({
			...lookupSource,
			filter: replacement,
		});
	});

	it("adds and removes a row filter by replacing the same complete lookup arm", () => {
		captured.catalog = readyCatalog();
		captured.workbenchProps = null;
		const onChange = vi.fn(
			(_next: SelectOptionsSource): CommitOutcome => ({ ok: true }),
		);
		renderEditor(lookupSource, onChange);

		fireEvent.click(screen.getByRole("button", { name: "Add row rule" }));
		expect(onChange).toHaveBeenLastCalledWith({
			...lookupSource,
			filter: eq(tableColumn(TABLE, CODE), literal("")),
		});

		const filtered = {
			...lookupSource,
			filter: eq(tableColumn(TABLE, CODE), literal("north")),
		};
		renderEditor(filtered, onChange);
		const workbenchProps = currentWorkbenchProps();
		act(() => {
			(workbenchProps.onRemoveRoot as () => void)();
		});
		expect(onChange).toHaveBeenLastCalledWith(lookupSource);
	});

	it("withholds row-rule authoring when the staged table has no column identity", async () => {
		captured.catalog = readyCatalog([emptyTable]);
		const onChange = vi.fn(
			(_next: SelectOptionsSource): CommitOutcome => ({ ok: true }),
		);
		renderEditor(inlineSource, onChange);

		await choose("Where the choices come from", "Empty table");

		expect(screen.queryByRole("button", { name: "Add row rule" })).toBeNull();
		expect(
			screen.getByText(
				"Add a column to this table before authoring a row rule.",
			),
		).toBeDefined();
		expect(
			screen
				.getByRole("button", { name: "Use this table" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(onChange).not.toHaveBeenCalled();
	});
});
