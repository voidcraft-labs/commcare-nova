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

export interface AttachmentTaskContext {
	readonly signal: AbortSignal;
	readonly isCurrent: () => boolean;
	/** Monotonic intent generation for this entry-local stable slot. */
	readonly generation: number;
}

interface PathTask {
	readonly controller: AbortController;
	readonly generation: number;
}

interface EntryQueue {
	tail: Promise<void>;
	pending: number;
	readonly paths: Map<string, PathTask>;
	readonly generations: Map<string, number>;
	readonly notReady: Map<string, string>;
}

const entryQueues = new Map<string, EntryQueue>();

interface AttachmentSlot {
	readonly appId: string;
	/** Engine path the stable slot currently projects onto. */
	desiredInstancePath: string;
	/** Confirmed row plus the path its immutable server row currently holds. */
	owned?: {
		readonly attachment: StagedAttachment;
		instancePath: string;
	};
	/**
	 * A retarget failure asked the engine to clear this answer. Consuming the
	 * marker lets the mounted control distinguish that coordinator clear from
	 * a user/reset clear, so it does not abort a newer queued replacement.
	 */
	coordinatorAnswerClearGeneration?: number;
}

/**
 * Entry-local capture identity is stable; concrete repeat indices are not.
 *
 * A slot key is the field UUID plus the stable render identities of every
 * enclosing repeat instance. `desiredInstancePath` is only its current
 * positional projection. Keeping the two separate lets a hidden control and
 * an in-flight signature survive `[1] → [0]` compaction without pretending
 * the server row already moved.
 */
const attachmentSlots = new Map<string, Map<string, AttachmentSlot>>();

export interface SignaturePoint {
	/** Fraction of the current canvas width, normally within `[0, 1]`. */
	readonly x: number;
	/** Fraction of the current canvas height, normally within `[0, 1]`. */
	readonly y: number;
}

const signatureDrafts = new Map<string, Map<string, SignaturePoint[][]>>();

function taskKey(args: {
	readonly slotKey?: string;
	readonly instancePath?: string;
}): string {
	const key = args.slotKey ?? args.instancePath;
	if (key === undefined) {
		throw new Error("An attachment task requires a stable slot key.");
	}
	return key;
}

function slotsFor(entryKey: string): Map<string, AttachmentSlot> {
	let entry = attachmentSlots.get(entryKey);
	if (entry === undefined) {
		entry = new Map();
		attachmentSlots.set(entryKey, entry);
	}
	return entry;
}

function queueFor(entryKey: string): EntryQueue {
	let queue = entryQueues.get(entryKey);
	if (queue === undefined) {
		queue = {
			tail: Promise.resolve(),
			pending: 0,
			paths: new Map(),
			generations: new Map(),
			notReady: new Map(),
		};
		entryQueues.set(entryKey, queue);
	}
	return queue;
}

function releaseQueueIfIdle(entryKey: string, queue: EntryQueue): void {
	if (
		queue.pending === 0 &&
		queue.paths.size === 0 &&
		queue.notReady.size === 0
	) {
		entryQueues.delete(entryKey);
	}
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
		releaseQueueIfIdle(entryKey, queue);
	});
}

/**
 * Serialize one capture mutation with every other capture path in the entry.
 *
 * Starting a newer task for the same stable slot aborts the older network
 * flow immediately; its generation predicate also fences callbacks that had
 * already escaped the abort boundary.
 */
export function runAttachmentTask<T>(args: {
	entryKey: string;
	/** Stable client identity. Concrete paths are accepted only as a
	 * compatibility fallback for non-repeat callers. */
	slotKey?: string;
	instancePath?: string;
	task: (context: AttachmentTaskContext) => Promise<T>;
}): Promise<T> {
	const queue = queueFor(args.entryKey);
	const key = taskKey(args);
	const previous = queue.paths.get(key);
	previous?.controller.abort();
	const generation = (queue.generations.get(key) ?? 0) + 1;
	queue.generations.set(key, generation);
	const current: PathTask = {
		controller: new AbortController(),
		generation,
	};
	queue.paths.set(key, current);
	const isCurrent = () =>
		entryQueues.get(args.entryKey) === queue &&
		queue.paths.get(key) === current &&
		!current.controller.signal.aborted;
	return enqueue(args.entryKey, async () => {
		current.controller.signal.throwIfAborted();
		return await args.task({
			signal: current.controller.signal,
			isCurrent,
			generation,
		});
	}).finally(() => {
		if (queue.paths.get(key) === current) {
			queue.paths.delete(key);
		}
		releaseQueueIfIdle(args.entryKey, queue);
	});
}

/** Abort and invalidate one stable capture slot. */
export function cancelAttachmentTask(entryKey: string, slotKey: string): void {
	const queue = entryQueues.get(entryKey);
	const current = queue?.paths.get(slotKey);
	current?.controller.abort();
	if (current !== undefined) queue?.paths.delete(slotKey);
	if (queue !== undefined) releaseQueueIfIdle(entryKey, queue);
}

/** Abort every path in an entry before a form-wide reset. */
export function cancelAttachmentEntry(entryKey: string): void {
	const queue = entryQueues.get(entryKey);
	if (queue === undefined) return;
	for (const current of queue.paths.values()) current.controller.abort();
	queue.paths.clear();
	queue.notReady.clear();
	releaseQueueIfIdle(entryKey, queue);
}

/** A visible capture draft that cannot yet be represented by a staged row. */
export class AttachmentNotReadyError extends Error {
	readonly name = "AttachmentNotReadyError";
}

export function markAttachmentNotReady(
	entryKey: string,
	slotKey: string,
	message: string,
): void {
	queueFor(entryKey).notReady.set(slotKey, message);
}

export function clearAttachmentNotReady(
	entryKey: string,
	slotKey: string,
): void {
	const queue = entryQueues.get(entryKey);
	if (queue === undefined) return;
	queue.notReady.delete(slotKey);
	releaseQueueIfIdle(entryKey, queue);
}

export type AttachmentSlotDisposition = "active" | "dormant" | "removed";

export interface FormAttachmentBarrierOptions {
	readonly classifySlot: (slot: {
		readonly slotKey: string;
		readonly instancePath: string;
	}) => AttachmentSlotDisposition;
}

function retireAttachmentSlot(entryKey: string, slotKey: string): void {
	const slots = attachmentSlots.get(entryKey);
	const slot = slots?.get(slotKey);
	slots?.delete(slotKey);
	if (slots?.size === 0) attachmentSlots.delete(entryKey);
	cancelAttachmentTask(entryKey, slotKey);
	clearAttachmentNotReady(entryKey, slotKey);
	clearSignatureDraft(entryKey, slotKey);
	if (slot?.owned !== undefined) {
		void discardAttachment({
			appId: slot.appId,
			attachmentId: slot.owned.attachment.attachmentId,
		}).catch(() => undefined);
	}
}

/**
 * Put Submit behind every capture mutation already queued for the form.
 * New capture tasks queue after the barrier, so the callback observes one
 * stable attachment answer set for its whole lifetime.
 */
export function runFormAttachmentBarrier<T>(
	entryKey: string,
	task: () => Promise<T>,
	options?: FormAttachmentBarrierOptions,
): Promise<T> {
	const queue = queueFor(entryKey);
	return enqueue(entryKey, async () => {
		const slots = attachmentSlots.get(entryKey);
		const keys = new Set([...(slots?.keys() ?? []), ...queue.notReady.keys()]);
		const dispositions = new Map<string, AttachmentSlotDisposition>();
		for (const slotKey of keys) {
			const instancePath = slots?.get(slotKey)?.desiredInstancePath ?? slotKey;
			const disposition =
				options?.classifySlot({ slotKey, instancePath }) ?? "active";
			dispositions.set(slotKey, disposition);
			if (disposition === "removed") {
				retireAttachmentSlot(entryKey, slotKey);
			}
		}
		for (const [slotKey, message] of queue.notReady) {
			if ((dispositions.get(slotKey) ?? "active") === "active") {
				throw new AttachmentNotReadyError(message);
			}
		}
		return task();
	});
}

/** Register one stable slot's current positional projection. Ordinary
 * component unmounts deliberately leave this record intact. */
export function registerAttachmentSlotPath(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	instancePath: string;
}): void {
	const slots = slotsFor(args.entryKey);
	const current = slots.get(args.slotKey);
	slots.set(args.slotKey, {
		appId: args.appId,
		desiredInstancePath: args.instancePath,
		...(current?.appId === args.appId && current.owned !== undefined
			? { owned: current.owned }
			: {}),
		...(current?.appId === args.appId &&
		current.coordinatorAnswerClearGeneration !== undefined
			? {
					coordinatorAnswerClearGeneration:
						current.coordinatorAnswerClearGeneration,
				}
			: {}),
	});
}

/** Read the authoritative current engine projection for an upload callback. */
export function getAttachmentSlotPath(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
}): string | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	return slot?.appId === args.appId ? slot.desiredInstancePath : undefined;
}

/** Remember confirmed row ownership above any one rendered component. */
export function rememberOwnedStagedAttachment(args: {
	appId: string;
	entryKey: string;
	slotKey?: string;
	instancePath: string;
	attachment: StagedAttachment;
}): void {
	const key = taskKey(args);
	const slots = slotsFor(args.entryKey);
	const current = slots.get(key);
	slots.set(key, {
		appId: args.appId,
		desiredInstancePath:
			current?.appId === args.appId
				? current.desiredInstancePath
				: args.instancePath,
		owned: {
			attachment: args.attachment,
			instancePath: args.instancePath,
		},
	});
}

/**
 * Consume the one-shot marker paired with a retarget-failure answer clear.
 * The marker never crosses entry/app scope and a confirmed replacement
 * clears it before projecting its new answer.
 */
export function consumeCoordinatorAttachmentAnswerClear(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
}): { readonly preserveNewerTask: boolean } | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (
		slot?.appId !== args.appId ||
		slot.coordinatorAnswerClearGeneration === undefined
	) {
		return undefined;
	}
	const failedGeneration = slot.coordinatorAnswerClearGeneration;
	slot.coordinatorAnswerClearGeneration = undefined;
	return {
		preserveNewerTask:
			(entryQueues.get(args.entryKey)?.generations.get(args.slotKey) ?? 0) >
			failedGeneration,
	};
}

export function getOwnedStagedAttachment(args: {
	appId: string;
	entryKey: string;
	slotKey?: string;
	instancePath?: string;
}): StagedAttachment | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(taskKey(args));
	return slot?.appId === args.appId ? slot.owned?.attachment : undefined;
}

export function forgetOwnedStagedAttachment(args: {
	appId: string;
	entryKey: string;
	slotKey?: string;
	instancePath?: string;
}): StagedAttachment | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(taskKey(args));
	if (slot?.appId !== args.appId || slot.owned === undefined) return undefined;
	const attachment = slot.owned.attachment;
	slot.owned = undefined;
	return attachment;
}

export interface AttachmentRepeatCompaction {
	readonly removedPrefix: string;
	readonly moves: ReadonlyArray<{
		readonly fromPrefix: string;
		readonly toPrefix: string;
	}>;
}

export interface AttachmentRetargetFailure {
	readonly slotKey: string;
	readonly instancePath: string;
}

function descendantPath(path: string, prefix: string): boolean {
	return path.startsWith(`${prefix}/`);
}

/**
 * Reconcile every registered slot after one engine-owned repeat compaction.
 *
 * This runs independently of rendered relevance. It updates desired paths
 * synchronously, then queues server CAS work behind any already-visible
 * upload/encoding and ahead of Submit. A pending signature therefore keeps
 * its stable slot/draft/notReady blocker, and a row confirmed against the old
 * path is retargeted only after that latest ink owns the slot.
 */
export async function reconcileAttachmentRepeatCompaction(args: {
	appId: string;
	entryKey: string;
	compaction: AttachmentRepeatCompaction;
	onRetargetFailure?: (failure: AttachmentRetargetFailure) => void;
}): Promise<readonly AttachmentRetargetFailure[]> {
	const slots = attachmentSlots.get(args.entryKey);
	if (slots === undefined) return [];
	const jobs: Array<Promise<AttachmentRetargetFailure | undefined>> = [];

	for (const [slotKey, slot] of [...slots]) {
		if (slot.appId !== args.appId) continue;
		const currentPath = slot.desiredInstancePath;
		if (descendantPath(currentPath, args.compaction.removedPrefix)) {
			const owned = slot.owned?.attachment;
			slots.delete(slotKey);
			cancelAttachmentTask(args.entryKey, slotKey);
			clearAttachmentNotReady(args.entryKey, slotKey);
			clearSignatureDraft(args.entryKey, slotKey);
			if (owned !== undefined) {
				jobs.push(
					enqueue(args.entryKey, async () => {
						await discardAttachment({
							appId: args.appId,
							attachmentId: owned.attachmentId,
						}).catch(() => undefined);
						return undefined;
					}),
				);
			}
			continue;
		}

		const move = args.compaction.moves.find(({ fromPrefix }) =>
			descendantPath(currentPath, fromPrefix),
		);
		if (move === undefined) continue;
		slot.desiredInstancePath = `${move.toPrefix}${currentPath.slice(
			move.fromPrefix.length,
		)}`;
		const scheduledGeneration =
			queueFor(args.entryKey).generations.get(slotKey) ?? 0;
		jobs.push(
			enqueue(args.entryKey, async () => {
				const live = attachmentSlots.get(args.entryKey)?.get(slotKey);
				if (live?.appId !== args.appId || live.owned === undefined) {
					return undefined;
				}
				const target = live.desiredInstancePath;
				const expected = live.owned.instancePath;
				if (target === expected) return undefined;
				const attachment = live.owned.attachment;
				try {
					await retargetAttachment({
						appId: args.appId,
						attachmentId: attachment.attachmentId,
						expectedInstancePath: expected,
						instancePath: target,
					});
					const latest = attachmentSlots
						.get(args.entryKey)
						?.get(slotKey)?.owned;
					if (latest?.attachment.attachmentId === attachment.attachmentId) {
						latest.instancePath = target;
					}
					return undefined;
				} catch {
					const latest = attachmentSlots.get(args.entryKey)?.get(slotKey);
					if (
						latest?.owned?.attachment.attachmentId === attachment.attachmentId
					) {
						latest.owned = undefined;
						latest.coordinatorAnswerClearGeneration = scheduledGeneration;
					}
					void discardAttachment({
						appId: args.appId,
						attachmentId: attachment.attachmentId,
					}).catch(() => undefined);
					const failure = { slotKey, instancePath: target };
					args.onRetargetFailure?.(failure);
					return failure;
				}
			}),
		);
	}
	if (slots.size === 0) attachmentSlots.delete(args.entryKey);
	return (await Promise.all(jobs)).filter(
		(failure): failure is AttachmentRetargetFailure => failure !== undefined,
	);
}

export function getSignatureDraft(
	entryKey: string,
	instancePath: string,
): SignaturePoint[][] {
	return (
		signatureDrafts
			.get(entryKey)
			?.get(instancePath)
			?.map((stroke) => stroke.map((point) => ({ ...point }))) ?? []
	);
}

export function rememberSignatureDraft(
	entryKey: string,
	instancePath: string,
	strokes: SignaturePoint[][],
): void {
	let entry = signatureDrafts.get(entryKey);
	if (entry === undefined) {
		entry = new Map();
		signatureDrafts.set(entryKey, entry);
	}
	entry.set(
		instancePath,
		strokes.map((stroke) => stroke.map((point) => ({ ...point }))),
	);
}

export function clearSignatureDraft(
	entryKey: string,
	instancePath: string,
): void {
	const entry = signatureDrafts.get(entryKey);
	entry?.delete(instancePath);
	if (entry?.size === 0) signatureDrafts.delete(entryKey);
}

/**
 * End the real form-entry lifetime. Ordinary field unmounts must never call
 * this; navigation, persona rotation, and Clear form do.
 */
function detachAttachmentEntry(args: {
	appId: string;
	entryKey: string;
}): string[] {
	cancelAttachmentEntry(args.entryKey);
	signatureDrafts.delete(args.entryKey);
	const entry = attachmentSlots.get(args.entryKey);
	attachmentSlots.delete(args.entryKey);
	if (entry === undefined) return [];
	return [
		...new Set(
			[...entry.values()]
				.filter((slot) => slot.appId === args.appId)
				.flatMap((slot) =>
					slot.owned === undefined ? [] : [slot.owned.attachment.attachmentId],
				),
		),
	];
}

/**
 * Retire an entry synchronously, then make deletion a cancellation-safe
 * best-effort cleanup. The staged-row/object TTL remains the final backstop
 * if the browser disappears or a DELETE response never arrives.
 */
export function retireAttachmentEntry(args: {
	appId: string;
	entryKey: string;
}): void {
	for (const attachmentId of detachAttachmentEntry(args)) {
		void discardAttachment({ appId: args.appId, attachmentId }).catch(
			() => undefined,
		);
	}
}

/** Awaitable variant retained for explicit cleanup and focused tests. */
export async function discardAttachmentEntry(args: {
	appId: string;
	entryKey: string;
}): Promise<void> {
	const ids = detachAttachmentEntry(args);
	await Promise.all(
		ids.map((attachmentId) =>
			discardAttachment({ appId: args.appId, attachmentId }).catch(
				() => undefined,
			),
		),
	);
}

/** Test-only process-local cleanup; never performs network I/O. */
export function __resetAttachmentCoordinatorForTests(): void {
	for (const queue of entryQueues.values()) {
		for (const path of queue.paths.values()) path.controller.abort();
	}
	entryQueues.clear();
	attachmentSlots.clear();
	signatureDrafts.clear();
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
