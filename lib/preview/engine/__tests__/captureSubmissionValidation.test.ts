import { describe, expect, it } from "vitest";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import { MAX_SUBMITTED_CAPTURE_COUNT } from "@/lib/domain/captureFormats";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";

const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const FORM_UUID = "22222222-2222-4222-8222-222222222222";
const FIELD_UUID = "33333333-3333-4333-8333-333333333333";

function projection(count: number) {
	const attachmentRefs = Array.from({ length: count }, (_, index) => ({
		attachmentName: `attachment-${index}.png`,
		fieldUuid: FIELD_UUID,
		instancePath: `/data/visits[${index}]/photo`,
	}));
	return {
		entryKey: ENTRY_KEY,
		formUuid: FORM_UUID,
		attachmentRefs,
	};
}

describe("validateCaptureSubmissionProjection", () => {
	it("accepts the exact bounded attachment-reference projection", () => {
		expect(
			validateCaptureSubmissionProjection(
				projection(MAX_SUBMITTED_CAPTURE_COUNT),
			),
		).toEqual(projection(MAX_SUBMITTED_CAPTURE_COUNT));
	});

	it("accepts the narrow submitted-answer projection for a close condition", () => {
		const submitted = {
			...projection(0),
			closeConditionAnswers: {
				fieldUuid: FIELD_UUID,
				values: ["ready"],
			},
		};
		expect(validateCaptureSubmissionProjection(submitted)).toEqual(submitted);
	});

	it("rejects an attachment set above the CommCare submission cap", () => {
		expect(() =>
			validateCaptureSubmissionProjection(
				projection(MAX_SUBMITTED_CAPTURE_COUNT + 1),
			),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it.each([
		{ fieldUuid: "not-a-uuid" },
		{ untrusted: true },
		{ attachmentName: "" },
		{ attachmentName: "a".repeat(256) },
		{ instancePath: "" },
		{ instancePath: "a".repeat(1025) },
	])("refuses an independently malformed attachment reference: %j", (patch) => {
		const valid = projection(1);
		expect(() =>
			validateCaptureSubmissionProjection({
				...valid,
				attachmentRefs: [{ ...valid.attachmentRefs[0], ...patch }],
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("rejects the retired name-only protocol even beside otherwise valid structured references", () => {
		expect(() =>
			validateCaptureSubmissionProjection({
				...projection(1),
				attachmentNames: [],
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("projects only capture protocol fields out of the complete submission envelope", () => {
		const valid = projection(0);
		expect(
			validateCaptureSubmissionProjection({
				...valid,
				kind: "survey",
				properties: {},
			}),
		).toEqual(valid);
	});

	it("rejects malformed or over-posted close-condition answers", () => {
		expect(() =>
			validateCaptureSubmissionProjection({
				...projection(0),
				closeConditionAnswers: {
					fieldUuid: FIELD_UUID,
					values: ["ready"],
					operator: "selected",
				},
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("rejects a projection missing any required protocol field", () => {
		const valid = projection(1);
		for (const field of ["entryKey", "formUuid", "attachmentRefs"] as const) {
			expect(() =>
				validateCaptureSubmissionProjection({
					...valid,
					[field]: undefined,
				}),
			).toThrow(CaptureSubmissionRejectedError);
		}
	});
});
