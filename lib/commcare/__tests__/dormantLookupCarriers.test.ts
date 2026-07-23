import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { buildXForm } from "@/lib/commcare/xform";
import type { Uuid } from "@/lib/domain";

describe("lookup carriers at the direct XForm boundary", () => {
	it("throws for a lookup-backed select when no wire naming is supplied", () => {
		const doc = buildDoc({
			appName: "Dormant lookup carrier",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
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
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = Object.keys(doc.forms)[0] as Uuid;

		expect(() =>
			buildXForm(doc, formUuid, {
				xmlns: "http://openrosa.org/formdesigner/dormant-lookup",
			}),
		).toThrow(
			/lookup-backed select reached XForm emission with no lookup wire naming/i,
		);
	});
});
