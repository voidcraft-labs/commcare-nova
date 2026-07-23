import { describe, expect, it } from "vitest";
import {
	authoredCaseIdNamespaceName,
	authoredCaseIdPrefix,
	deriveAuthoredCaseId,
	MAX_AUTHORED_CASE_ID_LENGTH,
	MAX_AUTHORED_CASE_KEY_LENGTH,
} from "../caseOperationIdentity";
import { asUuid } from "../uuid";

const FORM = asUuid("66666666-6666-4666-8666-666666666666");
const OPERATION = asUuid("44444444-4444-4444-8444-444444444444");
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

	it("keeps the raw key exact and bounds the final HQ case id", () => {
		const composed = deriveAuthoredCaseId(SCOPE, " é ");
		const decomposed = deriveAuthoredCaseId(SCOPE, " e\u0301 ");
		expect(composed).toMatchObject({ ok: true });
		expect(decomposed).toMatchObject({ ok: true });
		expect(composed).not.toEqual(decomposed);

		const maximum = deriveAuthoredCaseId(
			SCOPE,
			"x".repeat(MAX_AUTHORED_CASE_KEY_LENGTH),
		);
		expect(maximum.ok).toBe(true);
		if (maximum.ok) {
			expect(maximum.caseId.length).toBe(MAX_AUTHORED_CASE_ID_LENGTH);
		}
		expect(deriveAuthoredCaseId(SCOPE, "")).toMatchObject({
			ok: false,
			reason: "blank",
		});
		expect(
			deriveAuthoredCaseId(SCOPE, "x".repeat(MAX_AUTHORED_CASE_KEY_LENGTH + 1)),
		).toMatchObject({ ok: false, reason: "too-long" });
	});

	it("separates apps, forms, operations, and declared case types", () => {
		const baseline = authoredCaseIdPrefix(SCOPE);
		const variants = [
			{ ...SCOPE, appId: "another-app" },
			{
				...SCOPE,
				formUuid: asUuid("77777777-7777-4777-8777-777777777777"),
			},
			{
				...SCOPE,
				operationUuid: asUuid("88888888-8888-4888-8888-888888888888"),
			},
			{ ...SCOPE, caseType: "patient" },
		];
		for (const variant of variants) {
			expect(authoredCaseIdPrefix(variant)).not.toBe(baseline);
		}
	});
});
