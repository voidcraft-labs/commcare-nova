import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	authoredCaseIdNamespaceName,
	authoredCaseIdPrefix,
	deriveAuthoredCaseId,
} from "../caseOperationIdentity";

const FORM = testUuid("66666666-6666-4666-8666-666666666666");
const OPERATION = testUuid("44444444-4444-4444-8444-444444444444");
const SCOPE = {
	appId: "test-app",
	formUuid: FORM,
	operationUuid: OPERATION,
	caseType: "visit",
};

describe("authored case-operation identity", () => {
	it("pins the versioned namespace tuple and UUIDv5 vector", () => {
		expect(authoredCaseIdNamespaceName(SCOPE)).toBe(
			'["nova-case-v1","test-app","66666666-6666-4666-8666-666666666666","44444444-4444-4444-8444-444444444444","visit"]',
		);
		expect(authoredCaseIdPrefix(SCOPE)).toBe(
			"nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:",
		);
	});

	it("keeps raw whitespace and Unicode normalization forms exact", () => {
		for (const key of [" é ", " e\u0301 ", " "]) {
			expect(deriveAuthoredCaseId(SCOPE, key)).toEqual({
				ok: true,
				caseId: `nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:${key}`,
			});
		}
	});

	it("bounds the complete ID in UTF-16 units, including astral keys", () => {
		const key = `${"😀".repeat(102)}x`;
		const expectedId = `nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:${key}`;
		expect(expectedId).toHaveLength(255);
		expect(deriveAuthoredCaseId(SCOPE, key)).toEqual({
			ok: true,
			caseId: expectedId,
		});
		expect(deriveAuthoredCaseId(SCOPE, "")).toEqual({
			ok: false,
			reason: "blank",
			maxKeyLength: 205,
		});
		for (const oversized of ["x".repeat(206), "😀".repeat(103)]) {
			expect(deriveAuthoredCaseId(SCOPE, oversized)).toEqual({
				ok: false,
				reason: "too-long",
				maxKeyLength: 205,
			});
		}
	});

	it("separates apps, forms, operations, and declared case types", () => {
		const baseline = authoredCaseIdPrefix(SCOPE);
		const variants = [
			{ ...SCOPE, appId: "another-app" },
			{
				...SCOPE,
				formUuid: testUuid("77777777-7777-4777-8777-777777777777"),
			},
			{
				...SCOPE,
				operationUuid: testUuid("88888888-8888-4888-8888-888888888888"),
			},
			{ ...SCOPE, caseType: "patient" },
		];
		for (const variant of variants) {
			expect(authoredCaseIdPrefix(variant)).not.toBe(baseline);
		}
	});
});
