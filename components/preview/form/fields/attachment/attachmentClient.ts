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

interface AttachmentTaskContext {
	readonly signal: AbortSignal;
	readonly isCurrent: () => boolean;
}

interface PathTask {
	readonly controller: AbortController;
	readonly generation: number;
}

interface EntryQueue {
	tail: Promise<void>;
	pending: number;
	readonly paths: Map<string, PathTask>;
}

const entryQueues = new Map<string, EntryQueue>();

function queueFor(entryKey: string): EntryQueue {
	let queue = entryQueues.get(entryKey);
	if (queue === undefined) {
		queue = { tail: Promise.resolve(), pending: 0, paths: new Map() };
		entryQueues.set(entryKey, queue);
	}
	return queue;
}

function enqueue<T>(entryKey: string, work: () => Promise<T>): Promise<T> {
	const queue = queueFor(entryKey);
	queue.pending += 1;
	const result = queue.tail.then(work, work);
	queue.tail = result.then(
		() => undefined,
		() => undefined,
	);
	return result.finally(() => {
		queue.pending -= 1;
		if (queue.pending === 0 && queue.paths.size === 0) {
			entryQueues.delete(entryKey);
		}
	});
}

/**
 * Serialize one capture mutation with every other capture path in the entry.
 *
 * Starting a newer task for the same concrete path aborts the older network
 * flow immediately; its generation predicate also fences callbacks that had
 * already escaped the abort boundary.
 */
export function runAttachmentTask<T>(args: {
	entryKey: string;
	instancePath: string;
	task: (context: AttachmentTaskContext) => Promise<T>;
}): Promise<T> {
	const queue = queueFor(args.entryKey);
	const previous = queue.paths.get(args.instancePath);
	previous?.controller.abort();
	const current: PathTask = {
		controller: new AbortController(),
		generation: (previous?.generation ?? 0) + 1,
	};
	queue.paths.set(args.instancePath, current);
	const isCurrent = () =>
		entryQueues.get(args.entryKey) === queue &&
		queue.paths.get(args.instancePath) === current &&
		!current.controller.signal.aborted;
	return enqueue(args.entryKey, async () => {
		current.controller.signal.throwIfAborted();
		return await args.task({
			signal: current.controller.signal,
			isCurrent,
		});
	}).finally(() => {
		if (queue.paths.get(args.instancePath) === current) {
			queue.paths.delete(args.instancePath);
		}
		if (queue.pending === 0 && queue.paths.size === 0) {
			entryQueues.delete(args.entryKey);
		}
	});
}

/** Abort and invalidate one concrete capture path. */
export function cancelAttachmentTask(
	entryKey: string,
	instancePath: string,
): void {
	const queue = entryQueues.get(entryKey);
	const current = queue?.paths.get(instancePath);
	current?.controller.abort();
	if (current !== undefined) queue?.paths.delete(instancePath);
	if (queue?.pending === 0 && queue.paths.size === 0) {
		entryQueues.delete(entryKey);
	}
}

/** Abort every path in an entry before a form-wide reset. */
export function cancelAttachmentEntry(entryKey: string): void {
	const queue = entryQueues.get(entryKey);
	if (queue === undefined) return;
	for (const current of queue.paths.values()) current.controller.abort();
	queue.paths.clear();
	if (queue.pending === 0) entryQueues.delete(entryKey);
}

/**
 * Put submit/reset behind every capture mutation already queued for the form.
 * New capture tasks queue after the barrier, so the callback observes one
 * stable attachment answer set for its whole lifetime.
 */
export function runFormAttachmentBarrier<T>(
	entryKey: string,
	task: () => Promise<T>,
): Promise<T> {
	return enqueue(entryKey, task);
}

export function isAttachmentTaskAbort(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === "AbortError"
		: (error as { name?: unknown } | null)?.name === "AbortError";
}

async function postJson<T>(
	url: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal,
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
	}>(
		`/api/apps/${encodeURIComponent(appId)}/attachments`,
		{
			entryKey,
			fieldUuid,
			instancePath,
			filename: file.name,
			sizeBytes: file.size,
		},
		signal,
	);
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
	// A create-only retry can receive 412 after the first PUT actually landed
	// but its response was lost. Confirm is the authority on that immutable
	// generation, so let it distinguish success from a missing/mismatched body.
	if (!put.ok && put.status !== 412) {
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
		undefined,
		signal,
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
 * costs a staged orphan — which the scheduled row sweep and bucket TTL reap —
 * instead of a live answer pointing at nothing.
 */
export async function discardAttachment(args: {
	appId: string;
	attachmentId: string;
	signal?: AbortSignal;
}): Promise<void> {
	const response = await fetch(
		`/api/apps/${encodeURIComponent(args.appId)}/attachments/${encodeURIComponent(
			args.attachmentId,
		)}`,
		{ method: "DELETE", signal: args.signal },
	);
	if (!response.ok && response.status !== 404) {
		throw new Error("The staged attachment cleanup request failed.");
	}
}

/**
 * Move one staged answer to its new concrete path after repeat compaction.
 *
 * The attachment id is the stable answer identity; positional repeat indices
 * are only its current projection. The server revalidates both paths against
 * the committed field before changing the row.
 */
export async function retargetAttachment(args: {
	appId: string;
	attachmentId: string;
	expectedInstancePath: string;
	instancePath: string;
	signal?: AbortSignal;
}): Promise<void> {
	const response = await fetch(
		`/api/apps/${encodeURIComponent(args.appId)}/attachments/${encodeURIComponent(
			args.attachmentId,
		)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				expectedInstancePath: args.expectedInstancePath,
				instancePath: args.instancePath,
			}),
			signal: args.signal,
		},
	);
	if (!response.ok) {
		throw new AttachmentRejected(
			"This attachment couldn't follow its repeat row. Attach it again.",
		);
	}
}
