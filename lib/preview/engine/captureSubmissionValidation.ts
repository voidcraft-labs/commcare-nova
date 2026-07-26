import { z } from "zod";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import { MAX_SUBMITTED_CAPTURE_COUNT } from "@/lib/domain/captureFormats";

const captureSubmissionProjectionSchema = z
	.object({
		entryKey: z.string().uuid(),
		formUuid: z.string().uuid(),
		attachmentNames: z
			.array(z.string().min(1).max(255))
			.max(MAX_SUBMITTED_CAPTURE_COUNT),
		attachmentRefs: z
			.array(
				z
					.object({
						attachmentName: z.string().min(1).max(255),
						fieldUuid: z.string().uuid(),
						instancePath: z.string().min(1).max(1024),
					})
					.strict(),
			)
			.max(MAX_SUBMITTED_CAPTURE_COUNT),
	})
	.strict();

export type CaptureSubmissionProjection = z.infer<
	typeof captureSubmissionProjectionSchema
>;

/** Runtime gate for the client-carried capture projection. */
export function validateCaptureSubmissionProjection(
	input: unknown,
): CaptureSubmissionProjection {
	const projection = captureSubmissionProjectionSchema.safeParse(input);
	if (!projection.success) {
		throw new CaptureSubmissionRejectedError(
			`A form submission may carry at most ${MAX_SUBMITTED_CAPTURE_COUNT} valid attachment answers.`,
		);
	}
	if (
		projection.data.attachmentNames.length !==
			projection.data.attachmentRefs.length ||
		projection.data.attachmentNames.some(
			(name, index) =>
				name !== projection.data.attachmentRefs[index]?.attachmentName,
		)
	) {
		throw new CaptureSubmissionRejectedError(
			"The submitted attachment-name projection does not match its exact answer references.",
		);
	}
	return projection.data;
}
