import { describe, expect, it } from "vitest";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	SchemaNotSyncedError,
} from "../errors";

describe("case-store error payloads", () => {
	it("preserves the requested case identity on a catchable missing-row error", () => {
		const error = new CaseNotFoundError("case-123");
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: "CaseNotFoundError",
			caseId: "case-123",
		});
	});

	it.each([
		[CaseTypeNotInBlueprintError, "CaseTypeNotInBlueprintError"],
		[SchemaNotSyncedError, "SchemaNotSyncedError"],
	] as const)(
		"%s carries the app and type for API error mapping",
		(ErrorType, name) => {
			const error = new ErrorType("app-1", "patient");
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({
				name,
				appId: "app-1",
				caseType: "patient",
			});
		},
	);

	it("preserves structured validation failures and includes their paths in diagnostics", () => {
		const failures = [
			{ path: "/age", message: "must be integer" },
			{ path: "", message: "unknown phone", additionalProperty: "phone" },
		];
		const error = new CasePropertiesValidationError(
			"app-1",
			"patient",
			failures,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: "CasePropertiesValidationError",
			appId: "app-1",
			caseType: "patient",
			failures,
		});
		expect(error.message).toContain("/age: must be integer");
		expect(error.message).toContain("<root>: unknown phone");
	});

	it("accepts an absent validator error list as an empty failure payload", () => {
		const error = new CasePropertiesValidationError("app-1", "patient", []);
		expect(error.failures).toEqual([]);
	});
});
