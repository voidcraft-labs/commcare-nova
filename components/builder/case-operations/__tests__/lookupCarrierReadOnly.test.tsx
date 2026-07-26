// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	asUuid,
	type CaseOperation,
	type LookupColumnId,
	type LookupTableId,
} from "@/lib/domain";
import {
	eq,
	literal,
	matchAll,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { CaseOperationDetailCanvas } from "../CaseOperationDetailCanvas";
import { CaseOperationInspectorBody } from "../CaseOperationInspectorBody";

const dispatchProbes = vi.hoisted(() => ({
	callbacks: [] as (() => void)[],
}));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => true,
}));

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({
		openFormOperations: vi.fn(),
	}),
}));

/* These shared editors have their own interaction suites. Here they expose
 * their write callbacks directly so this boundary test can attempt a dispatch
 * even though the native disabled fieldset would suppress a real click. */
vi.mock("@/components/builder/shared/CaseTypePicker", () => ({
	CaseTypePicker: ({
		disabled,
		onChange,
	}: {
		disabled?: boolean;
		onChange: (value: string) => void;
	}) => {
		dispatchProbes.callbacks.push(() => onChange("other_type"));
		return <span data-case-type-disabled={String(disabled)} />;
	},
}));

vi.mock("../CaseTargetPicker", () => ({
	CaseTargetPicker: ({
		disabled,
		onChange,
	}: {
		disabled?: boolean;
		onChange: (value: { kind: "session" }) => void;
	}) => {
		dispatchProbes.callbacks.push(() => onChange({ kind: "session" }));
		return <span data-case-target-disabled={String(disabled)} />;
	},
}));

vi.mock("@/components/builder/shared/ExpressionCardEditor", () => ({
	ExpressionCardEditor: ({
		onChange,
	}: {
		onChange: (value: {
			kind: "term";
			term: { kind: "literal"; value: string };
		}) => void;
	}) => {
		dispatchProbes.callbacks.push(() =>
			onChange({
				kind: "term",
				term: { kind: "literal", value: "changed" },
			}),
		);
		return <span data-expression-editor />;
	},
}));

vi.mock("@/components/builder/shared/PredicateWorkbench", () => ({
	PredicateWorkbench: ({
		onChange,
	}: {
		onChange: (value: { kind: "match-all" }) => void;
	}) => {
		dispatchProbes.callbacks.push(() => onChange({ kind: "match-all" }));
		return <span data-predicate-editor />;
	},
}));

vi.mock("../CaseOperationLinks", () => ({
	CaseOperationLinks: ({
		canEdit,
		onChange,
	}: {
		canEdit: boolean;
		onChange: (value: undefined) => void;
	}) => {
		dispatchProbes.callbacks.push(() => onChange(undefined));
		return <span data-links-can-edit={String(canEdit)} />;
	},
}));

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const lookupExpression = tableLookup(TABLE, COLUMN, matchAll());
const lookupPredicate = eq(tableColumn(TABLE, COLUMN), literal("enabled"));

function carrierOperations(): readonly {
	readonly slot: string;
	readonly operation: CaseOperation;
}[] {
	const base = (suffix: string, id: string): CaseOperation => ({
		uuid: asUuid(`30000000-0000-4000-8000-${suffix.padStart(12, "0")}`),
		id,
		order: "a",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
	});
	return [
		{
			slot: "condition",
			operation: {
				...base("1", "carrier_condition"),
				condition: lookupPredicate,
			},
		},
		{
			slot: "name",
			operation: {
				...base("2", "carrier_name"),
				action: "create",
				target: { kind: "new" },
				name: lookupExpression,
			},
		},
		{
			slot: "owner",
			operation: { ...base("3", "carrier_owner"), owner: lookupExpression },
		},
		{
			slot: "rename",
			operation: { ...base("4", "carrier_rename"), rename: lookupExpression },
		},
		{
			slot: "operation target",
			operation: {
				...base("5", "carrier_target"),
				target: { kind: "expression", expr: lookupExpression },
			},
		},
		{
			slot: "write value",
			operation: {
				...base("6", "carrier_write_value"),
				writes: [{ property: "nickname", value: lookupExpression }],
			},
		},
		{
			slot: "write condition",
			operation: {
				...base("7", "carrier_write_condition"),
				writes: [
					{
						property: "nickname",
						value: term(literal("visible")),
						condition: lookupPredicate,
					},
				],
			},
		},
		{
			slot: "link target",
			operation: {
				...base("8", "carrier_link"),
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: { kind: "expression", expr: lookupExpression },
						relationship: "child",
					},
				],
			},
		},
	];
}

type DocApi = ReturnType<typeof useBlueprintDocApi>;

function ApiProbe({ capture }: { readonly capture: (api: DocApi) => void }) {
	capture(useBlueprintDocApi());
	return null;
}

describe("lookup-bearing case-operation authoring surfaces", () => {
	beforeEach(() => {
		dispatchProbes.callbacks = [];
	});

	it.each(carrierOperations())(
		"keeps every $slot control persistently read-only without dispatching",
		({ operation }) => {
			const doc = buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "nickname", label: "Nickname", data_type: "text" },
						],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [{ name: "Edit", type: "followup" }],
					},
				],
			});
			const moduleUuid = doc.moduleOrder[0];
			const formUuid = doc.formOrder[moduleUuid][0];
			doc.forms[formUuid].caseOperations = [operation];
			let api: DocApi | undefined;

			const { container } = render(
				<BlueprintDocProvider appId={doc.appId} initialDoc={doc}>
					<ApiProbe capture={(value) => (api = value)} />
					<CaseOperationInspectorBody
						moduleUuid={moduleUuid}
						formUuid={formUuid}
						operationUuid={operation.uuid}
					/>
					<CaseOperationDetailCanvas
						moduleUuid={moduleUuid}
						formUuid={formUuid}
						operationUuid={operation.uuid}
					/>
				</BlueprintDocProvider>,
			);
			if (api === undefined)
				throw new Error("document API probe did not mount");
			const before = api.getState();
			const historyBefore = api.temporal.getState().pastStates.length;
			const applyMany = vi.spyOn(api.getState(), "applyMany");

			expect(screen.getAllByRole("note")).toHaveLength(2);
			for (const note of screen.getAllByRole("note")) {
				expect(note.textContent).toContain(
					"Nova preserves but cannot safely edit from this surface",
				);
				expect(note.textContent).toContain(
					"You can still move it from the case changes list",
				);
			}
			const fieldsets = [...container.querySelectorAll("fieldset")];
			expect(fieldsets).toHaveLength(2);
			expect(fieldsets.every((fieldset) => fieldset.disabled)).toBe(true);
			expect(
				container.querySelector('[data-case-type-disabled="true"]'),
			).not.toBeNull();
			expect(
				container.querySelector('[data-case-target-disabled="true"]'),
			).not.toBeNull();
			expect(
				container.querySelector('[data-links-can-edit="false"]'),
			).not.toBeNull();

			const callbacks = [...dispatchProbes.callbacks];
			act(() => {
				for (const callback of callbacks) callback();
			});

			expect(applyMany).not.toHaveBeenCalled();
			expect(api.getState()).toBe(before);
			expect(api.temporal.getState().pastStates).toHaveLength(historyBefore);
		},
	);
});
