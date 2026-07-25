// Browser half of the form-attachment lane: initiate → PUT → confirm.
//
// The same three steps the media library uses, and for the same reason —
// bytes go straight to GCS on a signed URL so a 4 MB photo never travels
// through Cloud Run. The answer is set only after confirm returns, because
// a `pending` row's object may not exist yet and a submission that
// promoted one would carry a name with nothing behind it.

/** What a staged attachment gives the form: the answer, plus what to show. */
export interface StagedAttachment {
	/** The value the form answer holds. */
	readonly attachmentName: string;
	readonly attachmentId: string;
	/** The name the worker picked. Shown while this page is open, and
	 *  deliberately not persisted — see `AttachmentField`. */
	readonly originalFilename: string;
	readonly sizeBytes: number;
}

/** A rejection the worker should read, distinct from a transport failure. */
export class AttachmentRejected extends Error {
	readonly name = "AttachmentRejected";
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!res.ok) {
		// The routes speak person-to-person for the 4xx cases, so surface
		// their message verbatim rather than inventing a generic one.
		const detail = await res
			.json()
			.then((j: { error?: string }) => j.error)
			.catch(() => undefined);
		throw new AttachmentRejected(
			detail ??
				"That attachment couldn't be saved. Check your connection and try again.",
		);
	}
	return res.json() as Promise<T>;
}

/**
 * Stage one file against a capture question.
 *
 * Neither the file's kind nor its size is trusted from here — the initiate
 * route reads the question's kind from the committed blueprint and checks
 * the extension against what the device would accept for exactly that
 * kind. This function's own checks exist only so the worker hears about a
 * wrong file before the bytes upload, not as the gate.
 */
export async function stageAttachment(args: {
	appId: string;
	entryKey: string;
	fieldUuid: string;
	instancePath: string;
	file: File;
	signal?: AbortSignal;
}): Promise<StagedAttachment> {
	const { appId, entryKey, fieldUuid, instancePath, file, signal } = args;
	const initiate = await postJson<{
		attachmentId: string;
		attachmentName: string;
		uploadUrl: string;
		uploadContentType: string;
		uploadHeaders: Record<string, string>;
	}>(`/api/apps/${encodeURIComponent(appId)}/attachments`, {
		entryKey,
		fieldUuid,
		instancePath,
		filename: file.name,
		sizeBytes: file.size,
	});
	signal?.throwIfAborted();

	const put = await fetch(initiate.uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Type": initiate.uploadContentType,
			...initiate.uploadHeaders,
		},
		body: file,
		signal,
	});
	if (!put.ok) {
		throw new AttachmentRejected(
			"The upload didn't finish. Check your connection and attach the file again.",
		);
	}
	signal?.throwIfAborted();

	const confirmed = await postJson<{
		attachmentId: string;
		attachmentName: string;
		originalFilename: string;
		sizeBytes: number;
	}>(
		`/api/apps/${encodeURIComponent(appId)}/attachments/${encodeURIComponent(
			initiate.attachmentId,
		)}`,
	);
	return {
		attachmentId: confirmed.attachmentId,
		attachmentName: confirmed.attachmentName,
		originalFilename: confirmed.originalFilename,
		sizeBytes: confirmed.sizeBytes,
	};
}

/**
 * Discard a staged attachment.
 *
 * The caller clears its answer FIRST and calls this second. That ordering
 * is the opposite of the real runtime's, which deletes the bytes before
 * attempting the answer change and leaves a required question naming a
 * file it just removed. Doing it this way round means a failed delete
 * costs a staged orphan — which reconciliation discards and the bucket TTL
 * reaps — instead of a live answer pointing at nothing.
 */
export async function discardAttachment(args: {
	appId: string;
	attachmentId: string;
}): Promise<void> {
	await fetch(
		`/api/apps/${encodeURIComponent(args.appId)}/attachments/${encodeURIComponent(
			args.attachmentId,
		)}`,
		{ method: "DELETE" },
	);
}
