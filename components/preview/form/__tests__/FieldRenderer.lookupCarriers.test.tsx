import { describe, expect, it } from "vitest";
import { fieldSchema } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { FieldRenderer } from "../FieldRenderer";

const STATE: FieldState = {
	path: "/data/status",
	value: "",
	visible: true,
	required: false,
	valid: true,
	touched: false,
};

describe("FieldRenderer dormant lookup carriers", () => {
	it("rejects lookup-backed choices instead of running the inline fallback", () => {
		const field = fieldSchema.parse({
			uuid: "field-status",
			kind: "single_select",
			id: "status",
			label: "Status",
			options: [
				{ value: "open", label: "Open" },
				{ value: "closed", label: "Closed" },
			],
			optionsSource: {
				kind: "lookup-table",
				tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
				valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
				labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
			},
		});

		expect(() =>
			FieldRenderer({
				field,
				state: STATE,
				onChange: () => undefined,
				onBlur: () => undefined,
			}),
		).toThrow(/lookup-backed select options are dormant/i);
	});
});
