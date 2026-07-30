import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { buildXForm } from "@/lib/commcare/xform";
import type { Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

describe("lookup carriers at the direct XForm boundary", () => {
	it("throws for a lookup-backed select when no wire naming is supplied", () => {
		const doc = buildDoc({
			appName: "Lookup carrier",
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
									label: proseText("Status"),
									optionsSource: {
										kind: "lookup",
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
				xmlns: "http://openrosa.org/formdesigner/lookup",
			}),
		).toThrow(
			/lookup-backed select reached XForm emission with no lookup wire naming/i,
		);
	});
});
