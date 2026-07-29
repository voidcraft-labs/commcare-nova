// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/column/columnCards.smoke.test.tsx
//
// Table-driven smoke + round-trip test for every column card in
// the registry. Two invariants pinned here:
//
//   1. Every kind's `defaultValue(ctx)` factory produces a Column
//      that round-trips through `columnSchema.parse`. The schema
//      is the structural contract every wire emitter trusts;
//      defaults that fail to parse would surface only at save
//      time and break the editor's "what you author is what gets
//      persisted" guarantee.
//
//   2. Every card mounts via `ColumnEditor` without throwing. A
//      throw would crash the whole case-list-config Display
//      section.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type CaseType, type Column, columnSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { ColumnEditor } from "../../../ColumnEditor";
import {
	type ColumnEditContext,
	columnCardSchemas,
} from "../../../columnEditorSchemas";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: proseText("Name"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
		{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
		{ name: "wakeup", label: proseText("Wake time"), data_type: "time" },
		{
			name: "status",
			label: proseText("Status"),
			data_type: "single_select",
			options: [
				{ value: "active", label: proseText("Active") },
				{ value: "inactive", label: proseText("Inactive") },
			],
		},
		{
			name: "tags",
			label: proseText("Tags"),
			data_type: "multi_select",
			options: [
				{ value: "vip", label: proseText("VIP") },
				{ value: "new", label: proseText("New") },
			],
		},
	],
};

const ctx: ColumnEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
};

const allKinds = Object.keys(columnCardSchemas) as Column["kind"][];

describe("column cards smoke — defaultValue parses through columnSchema", () => {
	for (const kind of allKinds) {
		it(`${kind}: default value is parseable`, () => {
			const value = columnCardSchemas[kind].defaultValue(ctx);
			expect(() => columnSchema.parse(value)).not.toThrow();
			expect(value.kind).toBe(kind);
		});
	}
});

describe("column cards smoke — mount via ColumnEditor", () => {
	for (const kind of allKinds) {
		it(`${kind}: mounts inside ColumnEditor`, () => {
			const value = columnCardSchemas[kind].defaultValue(ctx);
			const { container } = render(
				<ColumnEditor
					value={value}
					onChange={() => {}}
					caseTypes={ctx.caseTypes}
					currentCaseType={ctx.currentCaseType}
				/>,
			);
			expect(container.firstElementChild).not.toBeNull();
		});
	}
});
