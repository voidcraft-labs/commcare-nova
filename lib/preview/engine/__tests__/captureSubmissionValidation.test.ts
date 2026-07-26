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
		attachmentNames: attachmentRefs.map((entry) => entry.attachmentName),
		attachmentRefs,
	};
}

describe("validateCaptureSubmissionProjection", () => {
	it("accepts the exact bounded name/ref projection", () => {
		expect(validateCaptureSubmissionProjection(projection(2))).toEqual(
			projection(2),
		);
	});

	it("rejects an attachment set above the CommCare submission cap", () => {
		expect(() =>
			validateCaptureSubmissionProjection(
				projection(MAX_SUBMITTED_CAPTURE_COUNT + 1),
			),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("rejects malformed or over-posted structured references at runtime", () => {
		const malformed = projection(1);
		expect(() =>
			validateCaptureSubmissionProjection({
				...malformed,
				attachmentRefs: [
					{
						...malformed.attachmentRefs[0],
						fieldUuid: "not-a-uuid",
						untrusted: true,
					},
				],
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("rejects a name projection that differs from the structured refs", () => {
		expect(() =>
			validateCaptureSubmissionProjection({
				...projection(1),
				attachmentNames: ["different.png"],
			}),
		).toThrow(/does not match/);
	});
});
