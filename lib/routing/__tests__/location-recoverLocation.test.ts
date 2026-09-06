import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { isValidLocation, recoverLocation } from "../location";
import type { Location } from "../types";

const mod = testUuid("module");
const form = testUuid("form");
const field = testUuid("field");
function fixture() {
	return buildDoc({
		modules: [
			{
				uuid: mod,
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [f({ uuid: field, kind: "text", id: "name" })],
					},
				],
			},
		],
	});
}

describe("location recovery boundaries", () => {
	it("loses only the unavailable ancestor, preserving an existing form after field deletion", () => {
		const doc = fixture();
		const location: Location = {
			kind: "form",
			moduleUuid: mod,
			formUuid: form,
			selectedUuid: field,
		};
		delete doc.fields[field];
		expect(isValidLocation(location, doc)).toBe(false);
		expect(recoverLocation(location, doc)).toEqual({
			kind: "form",
			moduleUuid: mod,
			formUuid: form,
		});
		delete doc.forms[form];
		expect(recoverLocation(location, doc)).toEqual({
			kind: "module",
			moduleUuid: mod,
		});
		delete doc.modules[mod];
		expect(recoverLocation(location, doc)).toEqual({ kind: "home" });
	});

	it.each(["cases", "search-config", "detail-config", "data-review"] as const)(
		"%s requires a case type even while the module remains",
		(kind) => {
			const doc = fixture();
			const location: Location = { kind, moduleUuid: mod };
			delete doc.modules[mod].caseType;
			expect(recoverLocation(location, doc)).toEqual({
				kind: "module",
				moduleUuid: mod,
			});
			delete doc.modules[mod];
			expect(isValidLocation(location, doc)).toBe(false);
			expect(recoverLocation(location, doc)).toEqual({ kind: "home" });
		},
	);

	it("display conditions survive loss of case type and recover through their own owner", () => {
		const doc = fixture();
		delete doc.modules[mod].caseType;
		const moduleCondition: Location = {
			kind: "module-condition",
			moduleUuid: mod,
		};
		const formCondition: Location = {
			kind: "form-condition",
			moduleUuid: mod,
			formUuid: form,
		};
		expect(recoverLocation(moduleCondition, doc)).toBe(moduleCondition);
		expect(recoverLocation(formCondition, doc)).toBe(formCondition);
		delete doc.forms[form];
		expect(isValidLocation(formCondition, doc)).toBe(false);
		expect(recoverLocation(formCondition, doc)).toEqual({
			kind: "module",
			moduleUuid: mod,
		});
		delete doc.modules[mod];
		expect(recoverLocation(moduleCondition, doc)).toEqual({ kind: "home" });
	});
});
