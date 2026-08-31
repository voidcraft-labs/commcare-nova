import { z } from "zod";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import { uuidSchema } from "@/lib/domain";
import { MAX_SUBMITTED_CAPTURE_COUNT } from "@/lib/domain/captureFormats";

const captureSubmissionProjectionSchema = z
	.object({
		entryKey: z.string().uuid(),
		formUuid: uuidSchema,
		attachmentRefs: z
			.array(
				z
					.object({
						attachmentName: z.string().min(1).max(255),
						fieldUuid: uuidSchema,
						instancePath: z.string().min(1).max(1024),
					})
					.strict(),
			)
			.max(MAX_SUBMITTED_CAPTURE_COUNT),
		closeConditionAnswers: z
			.object({
				fieldUuid: uuidSchema,
				values: z.array(z.string()),
			})
			.strict()
			.optional(),
	})
	.strip();

export type CaptureSubmissionProjection = z.infer<
	typeof captureSubmissionProjectionSchema
>;

/** Runtime gate for the client-carried capture projection. */
export function validateCaptureSubmissionProjection(
	input: unknown,
): CaptureSubmissionProjection {
	if (
		typeof input === "object" &&
		input !== null &&
		Object.hasOwn(input, "attachmentNames")
	) {
		throw new CaptureSubmissionRejectedError(
			"The retired attachmentNames submission field is not accepted.",
		);
	}
	const projection = captureSubmissionProjectionSchema.safeParse(input);
	if (!projection.success) {
		throw new CaptureSubmissionRejectedError(
			`A form submission requires a valid form identity, submitted answer projection, and at most ${MAX_SUBMITTED_CAPTURE_COUNT} exact attachment answers.`,
		);
	}
	return projection.data;
}
