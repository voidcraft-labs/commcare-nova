/** Canonical chat-thread attachment traversal and identity rewrites. */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function attachmentArray(message: unknown): unknown[] | null {
	const metadata = asRecord(asRecord(message)?.metadata);
	return Array.isArray(metadata?.attachments) ? metadata.attachments : null;
}

/** Every canonical `metadata.attachments[*].assetId` in stored order. */
export function collectThreadAttachmentAssetIds(
	messages: readonly unknown[],
): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		for (const attachment of attachmentArray(message) ?? []) {
			const assetId = asRecord(attachment)?.assetId;
			if (typeof assetId === "string" && assetId.length > 0) ids.push(assetId);
		}
	}
	return ids;
}

/**
 * Rewrite only canonical attachment asset identity. Message ids, parts, order,
 * filenames, MIME types, titles, summaries, and unrelated metadata survive
 * byte-for-byte at the JSON-value layer.
 */
export function remapThreadAttachmentAssetIds(
	messages: readonly unknown[],
	assetIdMap: ReadonlyMap<string, string>,
): unknown[] {
	return messages.map((message) => {
		const messageRecord = asRecord(message);
		const metadata = asRecord(messageRecord?.metadata);
		const attachments = attachmentArray(message);
		if (!messageRecord || !metadata || !attachments) return message;

		let changed = false;
		const remapped = attachments.map((attachment) => {
			const record = asRecord(attachment);
			const assetId = record?.assetId;
			const destination =
				typeof assetId === "string" ? assetIdMap.get(assetId) : undefined;
			if (!record || destination === undefined || destination === assetId) {
				return attachment;
			}
			changed = true;
			return { ...record, assetId: destination };
		});
		return changed
			? { ...messageRecord, metadata: { ...metadata, attachments: remapped } }
			: message;
	});
}

/**
 * Existing stored messages own their attachment metadata. A stale client may
 * contribute richer parts or other metadata for the same message id, but it
 * cannot replace, add, or resurrect attachment asset ids after a Project move.
 */
export function preserveStoredThreadAttachments(
	stored: unknown,
	candidate: unknown,
): unknown {
	const candidateRecord = asRecord(candidate);
	if (!candidateRecord) return candidate;
	const storedAttachments = attachmentArray(stored);
	const candidateMetadata = asRecord(candidateRecord.metadata);

	if (storedAttachments !== null) {
		return {
			...candidateRecord,
			metadata: {
				...(candidateMetadata ?? {}),
				attachments: storedAttachments,
			},
		};
	}
	if (!candidateMetadata || !("attachments" in candidateMetadata)) {
		return candidate;
	}
	const { attachments: _stale, ...metadata } = candidateMetadata;
	const next = { ...candidateRecord };
	if (Object.keys(metadata).length === 0) {
		delete next.metadata;
	} else {
		next.metadata = metadata;
	}
	return next;
}
