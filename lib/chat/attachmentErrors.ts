import type { MediaReferenceProjectionError } from "@/lib/db/mediaAssets";

/** Internal evidence stays off the conversation and HTTP response. */
export class ThreadAttachmentUnavailableError extends Error {
	readonly name = "ThreadAttachmentUnavailableError";
	constructor(
		readonly admission: "incoming" | "durable",
		readonly detail: MediaReferenceProjectionError,
	) {
		super(
			admission === "durable"
				? "A file already used by this conversation is unavailable. We've recorded the problem. You can start a new conversation while we investigate."
				: detail.reason === "not-ready"
					? "One of this message's files is not ready. Once it finishes uploading, you can attach it again."
					: "One of this message's files is unavailable. Remove it and choose a file from this Project before trying again.",
			{ cause: detail },
		);
	}
}
