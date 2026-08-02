// Browser half of the form-attachment lane: initiate → PUT → confirm.
//
// The same three steps the media library uses, and for the same reason:
// bytes go straight to GCS on a signed URL so a 4 MB photo never travels
// through Cloud Run. The answer is set only after confirm returns, because
// a `pending` row's object may not exist yet and a submission that
// promoted one would carry a name with nothing behind it.

import { asUuid, type Uuid } from "@/lib/domain";
import {
	type InstancePathProjection,
	projectInstancePath,
} from "@/lib/preview/engine/instancePaths";
import type { AccessPhase } from "@/lib/session/store";

/** What a staged attachment gives the form: the answer, plus what to show. */
export interface StagedAttachment {
	/** The value the form answer holds. */
	readonly attachmentName: string;
	readonly attachmentId: string;
	/** The name the worker picked. Shown while this page is open, and
	 *  deliberately not persisted: see `AttachmentField`. */
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

export type AttachmentCommitResult = "committed" | "canceled" | "refused";

export interface AttachmentEntryAuthoritySnapshot {
	readonly appId: string | undefined;
	/** The controller's exact live entry identity. A rotated controller makes
	 * every task and destructive token from the prior entry stale immediately,
	 * before React's passive teardown can retire that entry. */
	readonly entryKey: string | undefined;
	readonly formUuid: string | undefined;
	readonly projectId: string | undefined;
	readonly actorUserId: string | undefined;
	readonly ownerId: string | undefined;
	readonly scopeEpoch: number;
	readonly accessPhase: AccessPhase;
	readonly canEdit: boolean;
}

interface AttachmentEntryAuthorityState {
	generation: number;
	snapshot: AttachmentEntryAuthoritySnapshot;
	readCurrent: () => AttachmentEntryAuthoritySnapshot;
}

declare const attachmentEntryWriteAuthorityTokenBrand: unique symbol;

/** Opaque capability captured by one rendered destructive control.
 *
 * Callers may only obtain it while the coordinator's exact entry authority is
 * active. Its generation becomes stale on every access/scope tuple change,
 * including a loss followed by restoration before React commits a new
 * handler. */
export interface AttachmentEntryWriteAuthorityToken {
	readonly [attachmentEntryWriteAuthorityTokenBrand]: true;
}

interface AttachmentEntryWriteAuthorityTokenState {
	readonly entryKey: string;
	readonly generation: number;
}

interface PathTask {
	readonly controller: AbortController;
	readonly generation: number;
	/**
	 * Submission-time identity is independent of the private queue key.
	 *
	 * Most work is keyed directly by the stable slot. Clear uses a unique
	 * queue key so a later file pick cannot supersede its answer mutation,
	 * but it must still be classified as the real question/path when Submit
	 * reconciles active, dormant, and removed captures.
	 */
	readonly target: AttachmentTaskTarget;
}

export interface AttachmentTaskTarget {
	readonly slotKey: string;
	readonly instancePath: string;
	readonly fieldUuid?: string;
}

interface EntryQueue {
	tail: Promise<void>;
	pending: number;
	readonly paths: Map<string, PathTask>;
	readonly maintenance: Map<string, Set<AbortController>>;
	readonly generations: Map<string, number>;
	readonly notReady: Map<string, string>;
}

const entryQueues = new Map<string, EntryQueue>();
const entryAuthorities = new Map<string, AttachmentEntryAuthorityState>();
const entryWriteAuthorityTokens = new WeakMap<
	AttachmentEntryWriteAuthorityToken,
	AttachmentEntryWriteAuthorityTokenState
>();

interface AttachmentSlot {
	readonly appId: string;
	readonly fieldUuid?: string;
	/** Worker-visible capture family. Retarget recovery copy differs for the
	 * one drawn kind because "attach a replacement" is not its gesture. */
	captureKind?: string;
	/** Engine path the stable slot currently projects onto. */
	desiredInstancePath: string;
	/** Confirmed row plus the path its immutable server row currently holds. */
	owned?: {
		readonly attachment: StagedAttachment;
		instancePath: string;
	};
	/** Recoverable, entry-local failure retained across ordinary remounts. */
	issue?: AttachmentSlotIssue;
	/** Generation that established `issue`; diagnostics from older work may
	 * never clear a newer replacement/save. */
	issueGeneration?: number;
	/**
	 * Why a confirmed owner still differs from its current projection.
	 * `suspended` is the only state a barrier may resume automatically;
	 * `failed` remains an explicit Retry/replacement/remove decision.
	 */
	retargetState?: "queued" | "suspended" | "failed";
	/**
	 * A worker-picked file is entry/slot state, not component state. Keeping the
	 * exact File object here lets relevance and group remounts restore both the
	 * filename and the generation's Cancel/recovery controls without attempting
	 * to repopulate the browser's protected file input value.
	 */
	draft?: AttachmentSlotDraft;
}

export interface AttachmentSlotIssue {
	readonly kind: "retarget" | "replace" | "save" | "invariant";
	readonly message: string;
}

export interface AttachmentSlotDraft {
	readonly file: File;
	readonly status: "queued-upload" | "uploading" | "needs-attention";
	readonly generation?: number;
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

/**
 * Resolve a newly rendered control back to the entry-local slot that already
 * owns its stable field UUID and concrete path.
 *
 * A group↔repeat authoring conversion changes the renderer's repeat-scope key
 * even though the capture field itself keeps its UUID. The engine publishes
 * the path move before React remounts the control, so the old slot can be
 * recovered by `(field UUID, current concrete path)` instead of minting a
 * second owner for the same answer.
 */
export function resolveAttachmentSlotKey(args: {
	appId: string;
	entryKey: string;
	requestedSlotKey: string;
	instancePath: string;
	fieldUuid: string;
}): string {
	const slots = attachmentSlots.get(args.entryKey);
	const requested = slots?.get(args.requestedSlotKey);
	if (requested?.appId === args.appId) return args.requestedSlotKey;
	const matches = [...(slots ?? [])].filter(
		([, slot]) =>
			slot.appId === args.appId &&
			slot.fieldUuid === args.fieldUuid &&
			slot.desiredInstancePath === args.instancePath,
	);
	return matches.length === 1 ? matches[0][0] : args.requestedSlotKey;
}

export interface SignaturePoint {
	/** Fraction of the current canvas width, normally within `[0, 1]`. */
	readonly x: number;
	/** Fraction of the current canvas height, normally within `[0, 1]`. */
	readonly y: number;
}

export interface SignatureCanvasGeometry {
	readonly cssWidth: number;
	readonly cssHeight: number;
	readonly devicePixelRatio: number;
	readonly backingWidth: number;
	readonly backingHeight: number;
}

interface SignatureDraftState {
	strokes: SignaturePoint[][];
	encodedGeometry?: SignatureCanvasGeometry;
	undoStrokes?: SignaturePoint[][];
	needsEncoding: boolean;
	/** Authority generation under which the retained ink was last authored. */
	authorityGeneration?: number;
}

const signatureDrafts = new Map<string, Map<string, SignatureDraftState>>();
const attachmentSlotStateListeners = new Map<string, Set<() => void>>();

/** Whether this slot owns worker-authored capture payload that must survive an
 * ambiguous topology event. Browser geometry and Clear undo history are not
 * current answers; only a confirmed row, a picked File, or actual signature
 * points justify an invariant blocker. */
function attachmentSlotHasRetainedPayload(
	entryKey: string,
	slotKey: string,
	slot: AttachmentSlot,
): boolean {
	if (slot.owned !== undefined || slot.draft !== undefined) return true;
	return (
		signatureDrafts
			.get(entryKey)
			?.get(slotKey)
			?.strokes.some((stroke) => stroke.length > 0) ?? false
	);
}

const ATTACHMENT_CLEANUP_TIMEOUT_MS = 10_000;
const ATTACHMENT_REQUEST_TIMEOUT_MS = 30_000;
const BARRIER_RECLASSIFY_MS = 25;

interface DetachedAttachmentCleanup {
	readonly controller: AbortController;
	readonly timeoutId: ReturnType<typeof setTimeout>;
	completion: Promise<void>;
}

const detachedAttachmentCleanups = new Set<DetachedAttachmentCleanup>();

function slotsFor(entryKey: string): Map<string, AttachmentSlot> {
	let entry = attachmentSlots.get(entryKey);
	if (entry === undefined) {
		entry = new Map();
		attachmentSlots.set(entryKey, entry);
	}
	return entry;
}

function notifyAttachmentSlotState(entryKey: string): void {
	for (const listener of attachmentSlotStateListeners.get(entryKey) ?? []) {
		listener();
	}
}

function sameAttachmentEntryAuthority(
	left: AttachmentEntryAuthoritySnapshot,
	right: AttachmentEntryAuthoritySnapshot,
): boolean {
	return (
		left.appId === right.appId &&
		left.entryKey === right.entryKey &&
		left.formUuid === right.formUuid &&
		left.projectId === right.projectId &&
		left.actorUserId === right.actorUserId &&
		left.ownerId === right.ownerId &&
		left.scopeEpoch === right.scopeEpoch &&
		left.accessPhase === right.accessPhase &&
		left.canEdit === right.canEdit
	);
}

function activeAttachmentEntryAuthority(
	snapshot: AttachmentEntryAuthoritySnapshot,
	entryKey: string,
): boolean {
	return (
		snapshot.appId !== undefined &&
		snapshot.entryKey === entryKey &&
		snapshot.formUuid !== undefined &&
		snapshot.projectId !== undefined &&
		snapshot.actorUserId !== undefined &&
		snapshot.ownerId !== undefined &&
		snapshot.accessPhase === "authorized" &&
		snapshot.canEdit
	);
}

/** Preserve the intent to repair any owned row whose immutable server path no
 * longer matches the stable slot's projection. An invariant finding and an
 * explicit failed retry are worker-owned recovery states; every other
 * mismatch is safe to suspend and automatically resume. */
function suspendAttachmentRetargetMismatch(slot: AttachmentSlot): boolean {
	if (
		slot.owned === undefined ||
		slot.owned.instancePath === slot.desiredInstancePath ||
		slot.issue?.kind === "invariant" ||
		slot.retargetState === "failed"
	) {
		return false;
	}
	slot.retargetState = "suspended";
	return true;
}

function abortAttachmentEntryOperations(entryKey: string): void {
	const queue = entryQueues.get(entryKey);
	if (queue === undefined) return;
	for (const current of queue.paths.values()) current.controller.abort();
	for (const controllers of queue.maintenance.values()) {
		for (const controller of controllers) controller.abort();
	}
	queue.paths.clear();
	queue.maintenance.clear();
	// Drafts, staged ownership, and not-ready blockers are deliberately
	// retained. A transient access refresh must not erase the worker's work.
	releaseQueueIfIdle(entryKey, queue);
}

/**
 * Install the form owner's current write-capability tuple.
 *
 * This is called synchronously by `FormScreen`, above individual attachment
 * controls, so a scope/access transition fences queued work even while every
 * capture field is hidden or unmounted.
 */
export function setAttachmentEntryAuthority(args: {
	readonly entryKey: string;
	readonly snapshot: AttachmentEntryAuthoritySnapshot;
	readonly readCurrent: () => AttachmentEntryAuthoritySnapshot;
}): number {
	const existing = entryAuthorities.get(args.entryKey);
	if (
		existing !== undefined &&
		sameAttachmentEntryAuthority(existing.snapshot, args.snapshot)
	) {
		existing.readCurrent = args.readCurrent;
		return existing.generation;
	}
	const generation = (existing?.generation ?? 0) + 1;
	entryAuthorities.set(args.entryKey, {
		generation,
		snapshot: { ...args.snapshot },
		readCurrent: args.readCurrent,
	});
	const slots = attachmentSlots.get(args.entryKey);
	if (existing !== undefined) {
		for (const slot of slots?.values() ?? []) {
			suspendAttachmentRetargetMismatch(slot);
		}
		abortAttachmentEntryOperations(args.entryKey);
	}
	// Every tuple change invalidates the operation generation, even when React
	// batches refreshing away and the next committed render is already
	// authorized. Any file task that was queued/running in the old generation
	// must become an explicit retained draft instead of looking permanently
	// busy after its request was aborted.
	if (
		existing !== undefined ||
		!activeAttachmentEntryAuthority(args.snapshot, args.entryKey)
	) {
		for (const [slotKey, slot] of slots ?? []) {
			suspendAttachmentRetargetMismatch(slot);
			if (slot.draft === undefined || slot.draft.status === "needs-attention") {
				continue;
			}
			slot.draft = {
				...slot.draft,
				status: "needs-attention",
			};
			if (slot.issue === undefined) {
				slot.issue = {
					kind: "save",
					message:
						"This attachment was paused while edit access refreshed. Retry now, choose a different file, or remove it.",
				};
				slot.issueGeneration = slot.draft.generation ?? generation;
			}
			markAttachmentNotReady(args.entryKey, slotKey, slot.issue.message);
		}
	}
	if (
		activeAttachmentEntryAuthority(args.snapshot, args.entryKey) &&
		sameAttachmentEntryAuthority(args.snapshot, args.readCurrent())
	) {
		// A retarget's request generation was fenced by the access transition,
		// but its stable owner and desired path deliberately survived. Restore
		// every mismatch synchronously so Submit from the same render joins
		// behind the replacement CAS.
		for (const [slotKey, slot] of slots ?? []) {
			if (
				slot.appId === args.snapshot.appId &&
				slot.owned !== undefined &&
				slot.owned.instancePath !== slot.desiredInstancePath &&
				slot.retargetState === "suspended" &&
				slot.issue?.kind !== "invariant"
			) {
				void enqueueAttachmentSlotRetarget({
					appId: slot.appId,
					entryKey: args.entryKey,
					slotKey,
				});
			}
		}
	}
	return generation;
}

function attachmentEntryAuthorityToken(
	entryKey: string,
): AttachmentEntryWriteAuthorityToken | undefined {
	const authority = entryAuthorities.get(entryKey);
	if (authority === undefined) return undefined;
	if (
		!activeAttachmentEntryAuthority(authority.snapshot, entryKey) ||
		!sameAttachmentEntryAuthority(authority.snapshot, authority.readCurrent())
	) {
		return undefined;
	}
	const token = {} as AttachmentEntryWriteAuthorityToken;
	entryWriteAuthorityTokens.set(token, {
		entryKey,
		generation: authority.generation,
	});
	return token;
}

function attachmentEntryAuthorityIsCurrent(
	entryKey: string,
	token: AttachmentEntryWriteAuthorityToken | undefined,
): boolean {
	if (token === undefined) return false;
	const authority = entryAuthorities.get(entryKey);
	const tokenState = entryWriteAuthorityTokens.get(token);
	return (
		authority !== undefined &&
		tokenState?.entryKey === entryKey &&
		authority.generation === tokenState.generation &&
		activeAttachmentEntryAuthority(authority.snapshot, entryKey) &&
		sameAttachmentEntryAuthority(authority.snapshot, authority.readCurrent())
	);
}

function authorityAbort(): DOMException {
	return new DOMException("Attachment write authority changed.", "AbortError");
}

export function hasAttachmentEntryWriteAuthority(entryKey: string): boolean {
	return attachmentEntryAuthorityToken(entryKey) !== undefined;
}

/** Capture the exact active generation for a rendered destructive control.
 * A missing token is read-only UI; callers must never manufacture one. */
export function captureAttachmentEntryWriteAuthority(
	entryKey: string,
	expectedScopeEpoch: number,
): AttachmentEntryWriteAuthorityToken | undefined {
	if (
		entryAuthorities.get(entryKey)?.snapshot.scopeEpoch !== expectedScopeEpoch
	) {
		return undefined;
	}
	return attachmentEntryAuthorityToken(entryKey);
}

/** Run one synchronous destructive action only while the captured authority
 * generation is still exact-current.
 *
 * A missing token always fails closed. This is the imperative boundary for
 * stale React handlers: access loss, a viewer downgrade, or loss + restoration
 * rotates the coordinator generation before this callback can mutate the form
 * entry. */
export function runWithAttachmentEntryWriteAuthority(args: {
	readonly entryKey: string;
	readonly token: AttachmentEntryWriteAuthorityToken | undefined;
	readonly action: () => void;
}): boolean {
	if (
		args.token === undefined ||
		!attachmentEntryAuthorityIsCurrent(args.entryKey, args.token)
	) {
		return false;
	}
	args.action();
	return true;
}

function retargetIssueFor(slot: AttachmentSlot): AttachmentSlotIssue {
	return slot.captureKind === "signature"
		? {
				kind: "retarget",
				message:
					"This signature could not move to the question's current location. Retry now, draw it again, or use Clear signature.",
			}
		: {
				kind: "retarget",
				message:
					"This attachment could not move to the question's current location. Retry now, attach a replacement, or remove it.",
			};
}

function migrationInvariantIssue(slot: AttachmentSlot): AttachmentSlotIssue {
	return slot.captureKind === "signature"
		? {
				kind: "invariant",
				message:
					"This signature was preserved because the question's new location could not be verified. Reload this app before submitting, or use Clear signature.",
			}
		: {
				kind: "invariant",
				message:
					"This attachment was preserved because the question's new location could not be verified. Reload this app before submitting, or remove the attachment.",
			};
}

function nextAttachmentSlotGeneration(
	entryKey: string,
	slotKey: string,
): number {
	const queue = queueFor(entryKey);
	const generation = (queue.generations.get(slotKey) ?? 0) + 1;
	queue.generations.set(slotKey, generation);
	return generation;
}

function setSlotIssue(
	entryKey: string,
	slotKey: string,
	slot: AttachmentSlot,
	issue: AttachmentSlotIssue,
	generation: number,
): void {
	slot.issue = issue;
	slot.issueGeneration = generation;
	markAttachmentNotReady(entryKey, slotKey, issue.message);
	notifyAttachmentSlotState(entryKey);
}

function clearSlotIssue(
	entryKey: string,
	slotKey: string,
	slot: AttachmentSlot,
	options?: { kind?: AttachmentSlotIssue["kind"]; maximumGeneration?: number },
): void {
	if (slot.issue === undefined) return;
	if (options?.kind !== undefined && slot.issue.kind !== options.kind) return;
	if (
		options?.maximumGeneration !== undefined &&
		(slot.issueGeneration ?? 0) > options.maximumGeneration
	) {
		return;
	}
	slot.issue = undefined;
	slot.issueGeneration = undefined;
	clearAttachmentNotReady(entryKey, slotKey);
	notifyAttachmentSlotState(entryKey);
}

export function getAttachmentSlotIssue(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
}): AttachmentSlotIssue | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId || slot.issue === undefined) return undefined;
	return { ...slot.issue };
}

/** A path-unverified owner cannot safely attach itself to today's rendered
 * tree. FormScreen exposes these as a separate recovery-only surface so the
 * worker can remove the exact stable slot without blessing a guessed path. */
export interface AttachmentInvariantRecovery {
	readonly slotKey: string;
	readonly fieldUuid: Uuid;
	readonly captureKind?: string;
	readonly message: string;
}

export function listAttachmentInvariantRecoveries(args: {
	appId: string;
	entryKey: string;
}): readonly AttachmentInvariantRecovery[] {
	const recoveries: AttachmentInvariantRecovery[] = [];
	for (const [slotKey, slot] of attachmentSlots.get(args.entryKey) ?? []) {
		if (
			slot.appId !== args.appId ||
			slot.fieldUuid === undefined ||
			slot.issue?.kind !== "invariant"
		) {
			continue;
		}
		recoveries.push({
			slotKey,
			fieldUuid: asUuid(slot.fieldUuid),
			...(slot.captureKind === undefined
				? {}
				: { captureKind: slot.captureKind }),
			message: slot.issue.message,
		});
	}
	return recoveries;
}

/** Destructive recovery for one explicitly selected invariant slot. Recheck
 * app + issue identity at the click boundary so a stale panel can never
 * remove a newer successfully-mapped owner. */
export function discardAttachmentInvariantRecovery(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	authority: AttachmentEntryWriteAuthorityToken | undefined;
}): boolean {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId || slot.issue?.kind !== "invariant") {
		return false;
	}
	return runWithAttachmentEntryWriteAuthority({
		entryKey: args.entryKey,
		token: args.authority,
		action: () => {
			// Recheck the exact recovery identity inside the authorized action.
			// The action is synchronous, but keeping both predicates adjacent to
			// retirement makes future refactors fail closed too.
			const current = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
			if (
				current?.appId !== args.appId ||
				current.issue?.kind !== "invariant"
			) {
				return;
			}
			retireAttachmentSlot(args.entryKey, args.slotKey);
		},
	});
}

export function getAttachmentSlotDraft(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
}): AttachmentSlotDraft | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId || slot.draft === undefined) return undefined;
	return { ...slot.draft };
}

export function rememberAttachmentSlotDraft(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	file: File;
	status: AttachmentSlotDraft["status"];
	generation?: number;
}): void {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId) return;
	slot.draft = {
		file: args.file,
		status: args.status,
		...(args.generation === undefined ? {} : { generation: args.generation }),
	};
	notifyAttachmentSlotState(args.entryKey);
}

export function clearAttachmentSlotDraft(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	maximumGeneration?: number;
}): void {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId || slot.draft === undefined) return;
	if (
		args.maximumGeneration !== undefined &&
		(slot.draft.generation ?? 0) > args.maximumGeneration
	) {
		return;
	}
	slot.draft = undefined;
	notifyAttachmentSlotState(args.entryKey);
}

export function subscribeAttachmentSlotState(
	entryKey: string,
	listener: () => void,
): () => void {
	let listeners = attachmentSlotStateListeners.get(entryKey);
	if (listeners === undefined) {
		listeners = new Set();
		attachmentSlotStateListeners.set(entryKey, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) {
			attachmentSlotStateListeners.delete(entryKey);
		}
	};
}

export function setAttachmentSlotIssue(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	issue: AttachmentSlotIssue;
}): void {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId) return;
	const generation =
		entryQueues.get(args.entryKey)?.generations.get(args.slotKey) ?? 0;
	setSlotIssue(args.entryKey, args.slotKey, slot, args.issue, generation);
}

export function clearAttachmentSlotIssue(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	kind?: AttachmentSlotIssue["kind"];
	maximumGeneration?: number;
}): void {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId) return;
	clearSlotIssue(args.entryKey, args.slotKey, slot, {
		kind: args.kind,
		maximumGeneration: args.maximumGeneration,
	});
}

function queueFor(entryKey: string): EntryQueue {
	let queue = entryQueues.get(entryKey);
	if (queue === undefined) {
		queue = {
			tail: Promise.resolve(),
			pending: 0,
			paths: new Map(),
			maintenance: new Map(),
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
		queue.maintenance.size === 0 &&
		queue.notReady.size === 0
	) {
		entryQueues.delete(entryKey);
	}
}

function enqueueSlotMaintenance<T>(
	entryKey: string,
	slotKey: string,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const authorityToken = attachmentEntryAuthorityToken(entryKey);
	if (authorityToken === undefined) {
		return Promise.reject(authorityAbort());
	}
	const queue = queueFor(entryKey);
	const controller = new AbortController();
	let controllers = queue.maintenance.get(slotKey);
	if (controllers === undefined) {
		controllers = new Set();
		queue.maintenance.set(slotKey, controllers);
	}
	controllers.add(controller);
	return enqueue(entryKey, async () => {
		controller.signal.throwIfAborted();
		if (!attachmentEntryAuthorityIsCurrent(entryKey, authorityToken)) {
			throw authorityAbort();
		}
		const result = await work(controller.signal);
		if (!attachmentEntryAuthorityIsCurrent(entryKey, authorityToken)) {
			throw authorityAbort();
		}
		return result;
	}).finally(() => {
		controllers?.delete(controller);
		if (controllers?.size === 0) queue.maintenance.delete(slotKey);
		releaseQueueIfIdle(entryKey, queue);
	});
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
	/** Stable client identity. Concrete indexed paths are projections and are
	 * never accepted as an alternate task identity. */
	slotKey: string;
	/**
	 * The real capture target when the private queue key is intentionally
	 * synthetic (currently destructive Clear). Omit for ordinary slot work.
	 */
	target?: AttachmentTaskTarget;
	task: (context: AttachmentTaskContext) => Promise<T>;
}): Promise<T> {
	const authorityToken = attachmentEntryAuthorityToken(args.entryKey);
	if (authorityToken === undefined) {
		return Promise.reject(authorityAbort());
	}
	const queue = queueFor(args.entryKey);
	const key = args.slotKey;
	const previous = queue.paths.get(key);
	previous?.controller.abort();
	// A worker's new slot intent also supersedes queued/running path
	// maintenance. Otherwise an offline repeat-retarget PATCH could hold a
	// confirmed replacement or new signature behind it indefinitely.
	for (const controller of queue.maintenance.get(key) ?? []) controller.abort();
	queue.maintenance.delete(key);
	const generation = nextAttachmentSlotGeneration(args.entryKey, key);
	const registeredSlot = attachmentSlots
		.get(args.entryKey)
		?.get(args.target?.slotKey ?? key);
	const current: PathTask = {
		controller: new AbortController(),
		generation,
		target: {
			slotKey: args.target?.slotKey ?? key,
			instancePath:
				args.target?.instancePath ?? registeredSlot?.desiredInstancePath ?? key,
			...((args.target?.fieldUuid ?? registeredSlot?.fieldUuid)
				? {
						fieldUuid: args.target?.fieldUuid ?? registeredSlot?.fieldUuid,
					}
				: {}),
		},
	};
	queue.paths.set(key, current);
	const isCurrent = () =>
		entryQueues.get(args.entryKey) === queue &&
		queue.paths.get(key) === current &&
		!current.controller.signal.aborted &&
		attachmentEntryAuthorityIsCurrent(args.entryKey, authorityToken);
	return enqueue(args.entryKey, async () => {
		current.controller.signal.throwIfAborted();
		if (!attachmentEntryAuthorityIsCurrent(args.entryKey, authorityToken)) {
			throw authorityAbort();
		}
		const result = await args.task({
			signal: current.controller.signal,
			isCurrent,
			generation,
		});
		if (!attachmentEntryAuthorityIsCurrent(args.entryKey, authorityToken)) {
			throw authorityAbort();
		}
		return result;
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
	for (const controller of queue?.maintenance.get(slotKey) ?? []) {
		controller.abort();
	}
	queue?.maintenance.delete(slotKey);
	if (queue !== undefined) releaseQueueIfIdle(entryKey, queue);
}

/** Abort every direct, synthetic, and maintenance operation whose real target
 * is one stable slot. Authority loss and slot retirement use this stronger
 * boundary; ordinary newer intents still cancel only their direct generation. */
export function cancelAttachmentSlotWork(
	entryKey: string,
	slotKey: string,
): void {
	const queue = entryQueues.get(entryKey);
	if (queue === undefined) return;
	for (const [key, current] of [...queue.paths]) {
		if (key !== slotKey && current.target.slotKey !== slotKey) continue;
		current.controller.abort();
		queue.paths.delete(key);
	}
	for (const controller of queue.maintenance.get(slotKey) ?? []) {
		controller.abort();
	}
	queue.maintenance.delete(slotKey);
	releaseQueueIfIdle(entryKey, queue);
}

/** Abort every path in an entry before a form-wide reset. */
export function cancelAttachmentEntry(entryKey: string): void {
	const queue = entryQueues.get(entryKey);
	if (queue === undefined) return;
	for (const current of queue.paths.values()) current.controller.abort();
	for (const controllers of queue.maintenance.values()) {
		for (const controller of controllers) controller.abort();
	}
	queue.paths.clear();
	queue.maintenance.clear();
	queue.notReady.clear();
	releaseQueueIfIdle(entryKey, queue);
}

/** A visible capture draft that cannot yet be represented by a staged row. */
export class AttachmentNotReadyError extends Error {
	readonly name = "AttachmentNotReadyError";

	constructor(
		message: string,
		readonly slotKey: string,
		readonly instancePath: string,
		readonly fieldUuid?: string,
	) {
		super(message);
	}
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

/**
 * Cleanup is hygiene, never a correctness gate. Give the browser a bounded
 * attempt and deliberately detach it from the entry queue; the row sweep and
 * GCS lifecycle remain the durable backstop.
 */
export function scheduleAttachmentCleanup(args: {
	appId: string;
	attachmentId: string;
}): void {
	const controller = new AbortController();
	const cleanup: DetachedAttachmentCleanup = {
		controller,
		timeoutId: setTimeout(
			() => controller.abort(),
			ATTACHMENT_CLEANUP_TIMEOUT_MS,
		),
		completion: Promise.resolve(),
	};
	cleanup.completion = discardAttachment({
		...args,
		signal: controller.signal,
	})
		.catch(() => undefined)
		.finally(() => {
			clearTimeout(cleanup.timeoutId);
			detachedAttachmentCleanups.delete(cleanup);
		});
	detachedAttachmentCleanups.add(cleanup);
}

function retireAttachmentSlot(entryKey: string, slotKey: string): void {
	const slots = attachmentSlots.get(entryKey);
	const slot = slots?.get(slotKey);
	slots?.delete(slotKey);
	if (slots?.size === 0) attachmentSlots.delete(entryKey);
	cancelAttachmentSlotWork(entryKey, slotKey);
	clearAttachmentNotReady(entryKey, slotKey);
	clearSignatureDraft(entryKey, slotKey);
	notifyAttachmentSlotState(entryKey);
	if (slot?.owned !== undefined) {
		scheduleAttachmentCleanup({
			appId: slot.appId,
			attachmentId: slot.owned.attachment.attachmentId,
		});
	}
}

function reconcileBarrierDispositions(
	entryKey: string,
	queue: EntryQueue,
	options: FormAttachmentBarrierOptions | undefined,
): ReadonlyMap<string, AttachmentSlotDisposition> {
	const slots = attachmentSlots.get(entryKey);
	const targets = new Map<string, AttachmentTaskTarget>();
	for (const [slotKey, slot] of slots ?? []) {
		targets.set(slotKey, {
			slotKey,
			instancePath: slot.desiredInstancePath,
			...(slot.fieldUuid === undefined ? {} : { fieldUuid: slot.fieldUuid }),
		});
	}
	for (const task of queue.paths.values()) {
		const registered = slots?.get(task.target.slotKey);
		targets.set(task.target.slotKey, {
			...task.target,
			instancePath: registered?.desiredInstancePath ?? task.target.instancePath,
			...(registered?.fieldUuid === undefined
				? {}
				: { fieldUuid: registered.fieldUuid }),
		});
	}
	for (const slotKey of [
		...queue.maintenance.keys(),
		...queue.notReady.keys(),
	]) {
		if (targets.has(slotKey)) continue;
		const registered = slots?.get(slotKey);
		targets.set(slotKey, {
			slotKey,
			instancePath: registered?.desiredInstancePath ?? slotKey,
			...(registered?.fieldUuid === undefined
				? {}
				: { fieldUuid: registered.fieldUuid }),
		});
	}
	const dispositions = new Map<string, AttachmentSlotDisposition>();
	for (const [slotKey, target] of targets) {
		const classified =
			options?.classifySlot({
				slotKey,
				instancePath: target.instancePath,
			}) ?? "active";
		const registered = slots?.get(slotKey);
		// An invalid authored-path event is not evidence that the stable owner
		// disappeared. Preserve it and keep Submit blocked even if the engine's
		// now-current topology can no longer classify the old path.
		const disposition =
			registered?.issue?.kind === "invariant" ? "active" : classified;
		dispositions.set(slotKey, disposition);
		if (disposition === "removed") {
			retireAttachmentSlot(entryKey, slotKey);
		} else if (disposition === "dormant") {
			// Preserve a picked file above the now-unmounted control. If Submit
			// later fails and the question becomes relevant again, the worker
			// gets the same filename and an actionable stable-slot blocker
			// instead of a deceptively empty picker.
			const slot = slots?.get(slotKey);
			const currentTask = [...queue.paths.values()].find(
				(task) => task.target.slotKey === slotKey,
			);
			if (
				slot?.draft !== undefined &&
				slot.draft.status !== "needs-attention"
			) {
				slot.draft = {
					...slot.draft,
					status: "needs-attention",
					...(currentTask === undefined
						? {}
						: { generation: currentTask.generation }),
				};
				setSlotIssue(
					entryKey,
					slotKey,
					slot,
					{
						kind: "save",
						message:
							"That attachment couldn't be saved. Retry now, choose a different file, or remove it.",
					},
					currentTask?.generation ?? slot.draft.generation ?? 0,
				);
			}
			if (
				slot?.owned !== undefined &&
				slot.owned.instancePath !== slot.desiredInstancePath &&
				slot.issue?.kind !== "invariant" &&
				slot.retargetState !== "failed"
			) {
				slot.retargetState = "suspended";
				const generation =
					queue.generations.get(slotKey) ??
					nextAttachmentSlotGeneration(entryKey, slotKey);
				if (
					(slot.issue === undefined || slot.issue.kind === "retarget") &&
					(slot.issueGeneration ?? 0) <= generation
				) {
					setSlotIssue(
						entryKey,
						slotKey,
						slot,
						retargetIssueFor(slot),
						generation,
					);
				}
			}
			// A dormant draft remains registered and not-ready. Only its
			// signal-aware active work is cancelled so Submit cannot starve
			// behind a question that no longer participates.
			cancelAttachmentTask(entryKey, slotKey);
		} else {
			const slot = slots?.get(slotKey);
			if (
				slot?.owned !== undefined &&
				slot.owned.instancePath !== slot.desiredInstancePath &&
				slot.issue?.kind !== "invariant" &&
				slot.retargetState === "suspended"
			) {
				const hasMaintenance = queue.maintenance.has(slotKey);
				// A dormant barrier may have aborted generation N after its PATCH
				// committed but before the response arrived. Reactivation owns N+1
				// so the late continuation cannot clear or replace its blocker.
				const generation = hasMaintenance
					? (queue.generations.get(slotKey) ?? 0)
					: nextAttachmentSlotGeneration(entryKey, slotKey);
				if (
					(slot.issue === undefined || slot.issue.kind === "retarget") &&
					(slot.issueGeneration ?? 0) <= generation
				) {
					setSlotIssue(
						entryKey,
						slotKey,
						slot,
						retargetIssueFor(slot),
						generation,
					);
				}
				if (!hasMaintenance) {
					void enqueueAttachmentSlotRetarget({
						appId: slot.appId,
						entryKey,
						slotKey,
						generation,
					});
				}
			}
		}
	}
	// Synthetic queue keys (for example a destructive Clear) are classified
	// by their real target above. A dormant target retains that explicit intent
	// and lets it run ahead of Submit; only a removed target retires the task.
	for (const [key, task] of [...queue.paths]) {
		const disposition = dispositions.get(task.target.slotKey) ?? "active";
		if (disposition === "removed" && key !== task.target.slotKey) {
			cancelAttachmentTask(entryKey, key);
		}
	}
	return dispositions;
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
	// Classification must happen before the barrier joins the tail: otherwise
	// a signal-aware task for a now-hidden/removed slot can sit ahead of Submit
	// forever and the code that would abort it is itself waiting behind it.
	reconcileBarrierDispositions(entryKey, queue, options);
	const monitor =
		options === undefined
			? undefined
			: setInterval(() => {
					reconcileBarrierDispositions(entryKey, queue, options);
				}, BARRIER_RECLASSIFY_MS);
	return enqueue(entryKey, async () => {
		const dispositions = reconcileBarrierDispositions(entryKey, queue, options);
		for (const [slotKey, message] of queue.notReady) {
			if ((dispositions.get(slotKey) ?? "active") === "active") {
				const slot = attachmentSlots.get(entryKey)?.get(slotKey);
				throw new AttachmentNotReadyError(
					message,
					slotKey,
					slot?.desiredInstancePath ?? slotKey,
					slot?.fieldUuid,
				);
			}
		}
		return task();
	}).finally(() => {
		if (monitor !== undefined) clearInterval(monitor);
	});
}

/** Register one stable slot's current positional projection. Ordinary
 * component unmounts deliberately leave this record intact. */
export function registerAttachmentSlotPath(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	instancePath: string;
	fieldUuid?: string;
	captureKind?: string;
}): void {
	const slots = slotsFor(args.entryKey);
	const current = slots.get(args.slotKey);
	slots.set(args.slotKey, {
		appId: args.appId,
		fieldUuid:
			current?.appId === args.appId
				? (args.fieldUuid ?? current.fieldUuid)
				: args.fieldUuid,
		captureKind:
			current?.appId === args.appId
				? (args.captureKind ?? current.captureKind)
				: args.captureKind,
		desiredInstancePath: args.instancePath,
		...(current?.appId === args.appId && current.owned !== undefined
			? { owned: current.owned }
			: {}),
		...(current?.appId === args.appId && current.issue !== undefined
			? {
					issue: current.issue,
					issueGeneration: current.issueGeneration,
				}
			: {}),
		...(current?.appId === args.appId && current.retargetState !== undefined
			? { retargetState: current.retargetState }
			: {}),
		...(current?.appId === args.appId && current.draft !== undefined
			? { draft: current.draft }
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
	slotKey: string;
	instancePath: string;
	attachment: StagedAttachment;
	/**
	 * A confirmed generation may clear only its own/older picked-file draft.
	 * Callers that already own an entry-wide generation fence pass it here;
	 * setup/reconciliation callers omit it and publish an authoritative owner.
	 */
	maximumDraftGeneration?: number;
}): void {
	const key = args.slotKey;
	const slots = slotsFor(args.entryKey);
	const current = slots.get(key);
	const newerDraft =
		current?.appId === args.appId &&
		current.draft !== undefined &&
		args.maximumDraftGeneration !== undefined &&
		(current.draft.generation ?? 0) > args.maximumDraftGeneration
			? current.draft
			: undefined;
	const desiredInstancePath =
		current?.appId === args.appId
			? current.desiredInstancePath
			: args.instancePath;
	const ownerMatchesCurrent =
		current?.appId === args.appId &&
		current.owned?.attachment.attachmentId === args.attachment.attachmentId;
	const retargetState =
		args.instancePath === desiredInstancePath
			? undefined
			: ownerMatchesCurrent && current.retargetState !== undefined
				? current.retargetState
				: "queued";
	slots.set(key, {
		appId: args.appId,
		fieldUuid: current?.appId === args.appId ? current.fieldUuid : undefined,
		captureKind:
			current?.appId === args.appId ? current.captureKind : undefined,
		desiredInstancePath,
		owned: {
			attachment: args.attachment,
			instancePath: args.instancePath,
		},
		...(retargetState === undefined ? {} : { retargetState }),
		...(newerDraft === undefined ? {} : { draft: newerDraft }),
		...(newerDraft !== undefined && current?.issue !== undefined
			? {
					issue: current.issue,
					issueGeneration: current.issueGeneration,
				}
			: {}),
	});
	if (newerDraft === undefined) {
		clearAttachmentNotReady(args.entryKey, key);
	}
	notifyAttachmentSlotState(args.entryKey);
}

export function getOwnedStagedAttachment(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
}): StagedAttachment | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	return slot?.appId === args.appId ? slot.owned?.attachment : undefined;
}

export function forgetOwnedStagedAttachment(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
}): StagedAttachment | undefined {
	const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (slot?.appId !== args.appId) return undefined;
	const attachment = slot.owned?.attachment;
	slot.owned = undefined;
	clearSlotIssue(args.entryKey, args.slotKey, slot);
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

function enqueueAttachmentSlotRetarget(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	generation?: number;
}): Promise<AttachmentRetargetFailure | undefined> {
	const generation =
		args.generation ??
		nextAttachmentSlotGeneration(args.entryKey, args.slotKey);
	const scheduled = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
	if (scheduled?.appId === args.appId) scheduled.retargetState = "queued";
	return enqueueSlotMaintenance(args.entryKey, args.slotKey, async (signal) => {
		const live = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
		if (live?.appId !== args.appId || live.owned === undefined) {
			return undefined;
		}
		const attachment = live.owned.attachment;
		const target = live.desiredInstancePath;
		try {
			await convergeAttachmentRetarget({
				appId: args.appId,
				entryKey: args.entryKey,
				slotKey: args.slotKey,
				signal,
				maximumIssueGeneration: generation,
			});
			const latest = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
			if (
				latest?.appId === args.appId &&
				(entryQueues.get(args.entryKey)?.generations.get(args.slotKey) ??
					generation) === generation
			) {
				latest.retargetState = undefined;
			}
			return undefined;
		} catch (error) {
			if (isAttachmentTaskAbort(error)) throw error;
			const latest = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
			if (
				latest?.owned?.attachment.attachmentId === attachment.attachmentId &&
				(latest.issueGeneration ?? 0) <= generation &&
				(entryQueues.get(args.entryKey)?.generations.get(args.slotKey) ??
					generation) === generation
			) {
				latest.retargetState = "failed";
				setSlotIssue(
					args.entryKey,
					args.slotKey,
					latest,
					retargetIssueFor(latest),
					generation,
				);
			}
			return { slotKey: args.slotKey, instancePath: target };
		}
	}).catch((error: unknown) => {
		if (isAttachmentTaskAbort(error)) return undefined;
		throw error;
	});
}

const MAX_RETARGET_RECONCILIATION_ATTEMPTS = 4;

/**
 * Move one retained row to the slot's latest desired projection.
 *
 * A prior PATCH can commit while its response is lost. On the next move the
 * server returns the locked row's actual path; adopting that coordinate and
 * retrying turns the operation into A→B (unknown response), then B→C rather
 * than leaving the client permanently stuck on expected=A.
 */
async function convergeAttachmentRetarget(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
	signal: AbortSignal;
	isCurrent?: () => boolean;
	maximumIssueGeneration?: number;
}): Promise<void> {
	for (
		let attempt = 0;
		attempt < MAX_RETARGET_RECONCILIATION_ATTEMPTS;
		attempt += 1
	) {
		args.signal.throwIfAborted();
		if (args.isCurrent !== undefined && !args.isCurrent()) {
			throw authorityAbort();
		}
		const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
		if (slot?.appId !== args.appId || slot.owned === undefined) {
			throw new AttachmentRejected(
				"This attachment is no longer available. Attach a replacement or remove it.",
			);
		}
		const attachmentId = slot.owned.attachment.attachmentId;
		const expectedInstancePath = slot.owned.instancePath;
		const instancePath = slot.desiredInstancePath;
		if (expectedInstancePath === instancePath) {
			clearSlotIssue(args.entryKey, args.slotKey, slot, {
				kind: "retarget",
				maximumGeneration: args.maximumIssueGeneration,
			});
			return;
		}
		const authoritativePath = await retargetAttachment({
			appId: args.appId,
			attachmentId,
			expectedInstancePath,
			instancePath,
			signal: args.signal,
		});
		if (args.isCurrent !== undefined && !args.isCurrent()) {
			throw authorityAbort();
		}
		const latest = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
		if (
			latest?.appId !== args.appId ||
			latest.owned?.attachment.attachmentId !== attachmentId
		) {
			throw authorityAbort();
		}
		latest.owned.instancePath = authoritativePath;
		if (authoritativePath === latest.desiredInstancePath) {
			clearSlotIssue(args.entryKey, args.slotKey, latest, {
				kind: "retarget",
				maximumGeneration: args.maximumIssueGeneration,
			});
			return;
		}
	}
	throw new AttachmentRejected(
		"This attachment kept moving while its repeat rows changed. Retry now.",
	);
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
}): Promise<readonly AttachmentRetargetFailure[]> {
	const slots = attachmentSlots.get(args.entryKey);
	if (slots === undefined) return [];
	const jobs: Array<Promise<AttachmentRetargetFailure | undefined>> = [];

	for (const [slotKey, slot] of [...slots]) {
		if (slot.appId !== args.appId) continue;
		const currentPath = slot.desiredInstancePath;
		if (descendantPath(currentPath, args.compaction.removedPrefix)) {
			retireAttachmentSlot(args.entryKey, slotKey);
			continue;
		}

		const move = args.compaction.moves.find(({ fromPrefix }) =>
			descendantPath(currentPath, fromPrefix),
		);
		if (move === undefined) continue;
		slot.desiredInstancePath = `${move.toPrefix}${currentPath.slice(
			move.fromPrefix.length,
		)}`;
		jobs.push(
			enqueueAttachmentSlotRetarget({
				appId: args.appId,
				entryKey: args.entryKey,
				slotKey,
			}),
		);
	}
	if (slots.size === 0) attachmentSlots.delete(args.entryKey);
	return (await Promise.all(jobs)).filter(
		(failure): failure is AttachmentRetargetFailure => failure !== undefined,
	);
}

export interface AttachmentAuthoredPathMigration {
	readonly moves: ReadonlyArray<
		| {
				readonly kind: "retained";
				readonly fieldUuid: string;
				readonly previous: {
					readonly pathTemplate: string;
					readonly segmentKeys: readonly string[];
					readonly captureKind?: string;
				};
				readonly current: {
					readonly pathTemplate: string;
					readonly segmentKeys: readonly string[];
					readonly captureKind?: string;
				};
		  }
		| {
				readonly kind: "deleted";
				readonly fieldUuid: string;
				readonly previous: {
					readonly pathTemplate: string;
					readonly segmentKeys: readonly string[];
					readonly captureKind: string;
				};
		  }
	>;
}

type AuthoredCaptureMove = AttachmentAuthoredPathMigration["moves"][number];

interface AuthoredCaptureSlotPlan {
	readonly slotKey: string;
	readonly slot: AttachmentSlot;
	readonly move?: AuthoredCaptureMove;
	readonly projection: InstancePathProjection;
}

function projectAuthoredCaptureSlot(
	slot: AttachmentSlot,
	move: AuthoredCaptureMove | undefined,
): InstancePathProjection {
	if (move === undefined || move.previous.captureKind === undefined) {
		return {
			kind: "invalid",
			reason:
				"The capture path migration did not name one previous capture identity.",
		};
	}
	const current =
		move.kind === "deleted"
			? move.previous
			: move.kind === "retained" && move.current !== undefined
				? move.current
				: undefined;
	if (current === undefined) {
		return {
			kind: "invalid",
			reason:
				"The capture path migration did not include a retained destination.",
		};
	}
	return projectInstancePath(
		slot.desiredInstancePath,
		move.previous.pathTemplate,
		current.pathTemplate,
		{
			oldSegmentKeys: move.previous.segmentKeys,
			newSegmentKeys: current.segmentKeys,
		},
	);
}

/**
 * Reconcile capture ownership after a live authoring rename or
 * group↔repeat conversion.
 *
 * The engine publishes these moves before React can remount a renamed
 * question. Every slot's desired path is projected synchronously before ANY
 * PATCH or DELETE starts, so swaps and simultaneous path/kind changes observe
 * one complete topology. Stable segment identities, not positional depth, carry
 * repeat indices across retained ancestors.
 *
 * `removed` is the one destructive projection: a repeat instance above index
 * zero legitimately has no home after its stable ancestor disappears.
 * `invalid` means the event/path identities cannot prove that fact; it fences
 * active work, preserves the exact owner/draft/signature, and installs an
 * invariant Submit blocker. A capture-kind conversion is not retargeted: once
 * its mapped destination is installed, the incompatible old row is cleaned up
 * and the stable field UUID retains an actionable replacement blocker.
 */
export async function reconcileAttachmentAuthoredPathMigration(args: {
	appId: string;
	entryKey: string;
	migration: AttachmentAuthoredPathMigration;
}): Promise<readonly AttachmentRetargetFailure[]> {
	const slots = attachmentSlots.get(args.entryKey);
	if (slots === undefined) return [];
	const jobs: Array<Promise<AttachmentRetargetFailure | undefined>> = [];
	const movesByField = new Map<string, AuthoredCaptureMove | undefined>();
	for (const move of args.migration.moves) {
		movesByField.set(
			move.fieldUuid,
			movesByField.has(move.fieldUuid) ? undefined : move,
		);
	}
	const plans: AuthoredCaptureSlotPlan[] = [];
	for (const [slotKey, slot] of [...slots]) {
		if (slot.appId !== args.appId || slot.fieldUuid === undefined) continue;
		if (!movesByField.has(slot.fieldUuid)) continue;
		const move = movesByField.get(slot.fieldUuid);
		plans.push({
			slotKey,
			slot,
			move,
			projection: projectAuthoredCaptureSlot(slot, move),
		});
	}

	// Batch projection is the synchronous ownership boundary. Do not start a
	// cleanup or a row CAS until every retained destination is installed.
	for (const plan of plans) {
		if (plan.projection.kind === "mapped") {
			plan.slot.desiredInstancePath = plan.projection.path;
		}
	}

	for (const { slotKey, slot, move, projection } of plans) {
		/* Stable field UUID deletion is destructive authority in its own right.
		 * It must retire a previously preserved invariant slot even when the
		 * old path can no longer be projected into today's tree. Duplicate
		 * deletion records are represented by `move === undefined` above and
		 * remain non-destructive. */
		if (move?.kind === "deleted") {
			retireAttachmentSlot(args.entryKey, slotKey);
			continue;
		}
		if (projection.kind === "invalid" || move === undefined) {
			cancelAttachmentSlotWork(args.entryKey, slotKey);
			if (!attachmentSlotHasRetainedPayload(args.entryKey, slotKey, slot)) {
				retireAttachmentSlot(args.entryKey, slotKey);
				continue;
			}
			if (slot.draft !== undefined && slot.draft.status !== "needs-attention") {
				slot.draft = { ...slot.draft, status: "needs-attention" };
			}
			const generation = nextAttachmentSlotGeneration(args.entryKey, slotKey);
			setSlotIssue(
				args.entryKey,
				slotKey,
				slot,
				migrationInvariantIssue(slot),
				generation,
			);
			continue;
		}
		if (projection.kind === "removed") {
			retireAttachmentSlot(args.entryKey, slotKey);
			continue;
		}

		if (move.kind !== "retained" || move.current === undefined) {
			cancelAttachmentSlotWork(args.entryKey, slotKey);
			if (!attachmentSlotHasRetainedPayload(args.entryKey, slotKey, slot)) {
				retireAttachmentSlot(args.entryKey, slotKey);
				continue;
			}
			const generation = nextAttachmentSlotGeneration(args.entryKey, slotKey);
			setSlotIssue(
				args.entryKey,
				slotKey,
				slot,
				migrationInvariantIssue(slot),
				generation,
			);
			continue;
		}

		if (move.current.captureKind === undefined) {
			retireAttachmentSlot(args.entryKey, slotKey);
			continue;
		}

		if (move.previous.captureKind !== move.current.captureKind) {
			cancelAttachmentSlotWork(args.entryKey, slotKey);
			const previous = slot.owned?.attachment;
			slot.owned = undefined;
			slot.draft = undefined;
			slot.captureKind = move.current.captureKind;
			clearSignatureDraft(args.entryKey, slotKey);
			clearAttachmentNotReady(args.entryKey, slotKey);
			clearSlotIssue(args.entryKey, slotKey, slot);
			if (previous !== undefined) {
				scheduleAttachmentCleanup({
					appId: args.appId,
					attachmentId: previous.attachmentId,
				});
			}
			const issue: AttachmentSlotIssue =
				move.current.captureKind === "signature"
					? {
							kind: "replace",
							message:
								"This question is now a signature. Draw a new signature before submitting.",
						}
					: {
							kind: "replace",
							message:
								"This question's attachment type changed. Attach a new file before submitting.",
						};
			const generation =
				entryQueues.get(args.entryKey)?.generations.get(slotKey) ?? 0;
			setSlotIssue(args.entryKey, slotKey, slot, issue, generation);
			continue;
		}

		slot.captureKind = move.current.captureKind;
		jobs.push(
			enqueueAttachmentSlotRetarget({
				appId: args.appId,
				entryKey: args.entryKey,
				slotKey,
			}),
		);
	}
	if (slots.size === 0) attachmentSlots.delete(args.entryKey);
	return (await Promise.all(jobs)).filter(
		(failure): failure is AttachmentRetargetFailure => failure !== undefined,
	);
}

/**
 * Retry the exact retained row/path CAS after a recoverable compaction failure.
 * The operation is a normal slot generation, so a replacement chosen afterward
 * aborts/fences it and becomes the only owner.
 */
export async function retryAttachmentRetarget(args: {
	appId: string;
	entryKey: string;
	slotKey: string;
}): Promise<void> {
	await runAttachmentTask({
		entryKey: args.entryKey,
		slotKey: args.slotKey,
		task: async (context) => {
			const slot = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
			if (slot?.appId !== args.appId || slot.owned === undefined) {
				throw new AttachmentRejected(
					"This attachment is no longer available. Attach a replacement or remove it.",
				);
			}
			slot.retargetState = "queued";
			const attachmentId = slot.owned.attachment.attachmentId;
			try {
				await convergeAttachmentRetarget({
					appId: args.appId,
					entryKey: args.entryKey,
					slotKey: args.slotKey,
					signal: context.signal,
					isCurrent: context.isCurrent,
					maximumIssueGeneration: context.generation,
				});
				if (context.isCurrent()) slot.retargetState = undefined;
			} catch (error) {
				if (isAttachmentTaskAbort(error) || !context.isCurrent()) throw error;
				const latest = attachmentSlots.get(args.entryKey)?.get(args.slotKey);
				if (
					latest?.appId === args.appId &&
					latest.owned?.attachment.attachmentId === attachmentId
				) {
					latest.retargetState = "failed";
					setSlotIssue(
						args.entryKey,
						args.slotKey,
						latest,
						retargetIssueFor(latest),
						context.generation,
					);
				}
				throw error;
			}
		},
	});
}

export function getSignatureDraft(
	entryKey: string,
	instancePath: string,
): SignaturePoint[][] {
	return (
		signatureDrafts
			.get(entryKey)
			?.get(instancePath)
			?.strokes.map((stroke) => stroke.map((point) => ({ ...point }))) ?? []
	);
}

export function rememberSignatureDraft(
	entryKey: string,
	instancePath: string,
	strokes: SignaturePoint[][],
	needsEncoding = true,
): void {
	let entry = signatureDrafts.get(entryKey);
	if (entry === undefined) {
		entry = new Map();
		signatureDrafts.set(entryKey, entry);
	}
	const current = entry.get(instancePath);
	entry.set(instancePath, {
		strokes: strokes.map((stroke) => stroke.map((point) => ({ ...point }))),
		needsEncoding,
		authorityGeneration: entryAuthorities.get(entryKey)?.generation,
		...(current?.encodedGeometry === undefined
			? {}
			: { encodedGeometry: { ...current.encodedGeometry } }),
		...(current?.undoStrokes === undefined
			? {}
			: {
					undoStrokes: current.undoStrokes.map((stroke) =>
						stroke.map((point) => ({ ...point })),
					),
				}),
	});
}

export function signatureDraftNeedsEncoding(
	entryKey: string,
	instancePath: string,
): boolean {
	return (
		signatureDrafts.get(entryKey)?.get(instancePath)?.needsEncoding ?? false
	);
}

export function getSignatureUndoDraft(
	entryKey: string,
	instancePath: string,
): SignaturePoint[][] | undefined {
	const strokes = signatureDrafts.get(entryKey)?.get(instancePath)?.undoStrokes;
	return strokes?.map((stroke) => stroke.map((point) => ({ ...point })));
}

/**
 * Clear active ink while retaining one stable inverse action. This survives
 * ordinary relevance/group remounts; only entry retirement discards it.
 */
export function rememberClearedSignatureDraft(
	entryKey: string,
	instancePath: string,
	strokes: SignaturePoint[][] | undefined,
): void {
	let entry = signatureDrafts.get(entryKey);
	if (entry === undefined) {
		entry = new Map();
		signatureDrafts.set(entryKey, entry);
	}
	const current = entry.get(instancePath);
	entry.set(instancePath, {
		strokes: [],
		needsEncoding: false,
		authorityGeneration: entryAuthorities.get(entryKey)?.generation,
		...(current?.encodedGeometry === undefined
			? {}
			: { encodedGeometry: { ...current.encodedGeometry } }),
		...(strokes === undefined
			? {}
			: {
					undoStrokes: strokes.map((stroke) =>
						stroke.map((point) => ({ ...point })),
					),
				}),
	});
}

export function clearSignatureUndoDraft(
	entryKey: string,
	instancePath: string,
): void {
	const state = signatureDrafts.get(entryKey)?.get(instancePath);
	if (state === undefined) return;
	state.undoStrokes = undefined;
}

export function getSignatureEncodedGeometry(
	entryKey: string,
	instancePath: string,
): SignatureCanvasGeometry | undefined {
	const geometry = signatureDrafts
		.get(entryKey)
		?.get(instancePath)?.encodedGeometry;
	return geometry === undefined ? undefined : { ...geometry };
}

export function rememberSignatureEncodedGeometry(
	entryKey: string,
	instancePath: string,
	geometry: SignatureCanvasGeometry,
): void {
	let entry = signatureDrafts.get(entryKey);
	if (entry === undefined) {
		entry = new Map();
		signatureDrafts.set(entryKey, entry);
	}
	const current = entry.get(instancePath);
	entry.set(instancePath, {
		strokes:
			current?.strokes.map((stroke) => stroke.map((point) => ({ ...point }))) ??
			[],
		encodedGeometry: { ...geometry },
		needsEncoding: false,
		authorityGeneration: entryAuthorities.get(entryKey)?.generation,
		...(current?.undoStrokes === undefined
			? {}
			: {
					undoStrokes: current.undoStrokes.map((stroke) =>
						stroke.map((point) => ({ ...point })),
					),
				}),
	});
}

/**
 * Adopt retained dirty ink into the current capability generation.
 *
 * Returns false while the entry is read-only/refreshing or when no dirty ink
 * exists. The pad uses this on authority restoration before re-encoding.
 */
export function rearmSignatureDraftForCurrentAuthority(
	entryKey: string,
	instancePath: string,
): boolean {
	const authority = entryAuthorities.get(entryKey);
	if (
		authority === undefined ||
		attachmentEntryAuthorityToken(entryKey) === undefined
	) {
		return false;
	}
	const state = signatureDrafts.get(entryKey)?.get(instancePath);
	if (
		state === undefined ||
		state.strokes.length === 0 ||
		!state.needsEncoding ||
		state.authorityGeneration === authority.generation
	) {
		return false;
	}
	state.authorityGeneration = authority.generation;
	return true;
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
	entryAuthorities.delete(args.entryKey);
	signatureDrafts.delete(args.entryKey);
	attachmentSlotStateListeners.delete(args.entryKey);
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
		scheduleAttachmentCleanup({ appId: args.appId, attachmentId });
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

/** Test-only process-local cleanup; never initiates network I/O. */
export async function __resetAttachmentCoordinatorForTests(): Promise<void> {
	for (const queue of entryQueues.values()) {
		for (const path of queue.paths.values()) path.controller.abort();
		for (const controllers of queue.maintenance.values()) {
			for (const controller of controllers) controller.abort();
		}
	}
	const detachedCleanups = [...detachedAttachmentCleanups];
	for (const cleanup of detachedCleanups) {
		clearTimeout(cleanup.timeoutId);
		cleanup.controller.abort();
	}
	await Promise.all(detachedCleanups.map((cleanup) => cleanup.completion));
	detachedAttachmentCleanups.clear();
	entryQueues.clear();
	entryAuthorities.clear();
	attachmentSlots.clear();
	signatureDrafts.clear();
	attachmentSlotStateListeners.clear();
}

export function isAttachmentTaskAbort(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === "AbortError"
		: (error as { name?: unknown } | null)?.name === "AbortError";
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Every foreground request owns a deadline in addition to the slot's
 * generation signal. The explicit race matters because a browser/fetch mock
 * that fails to observe abort must not hold the entry-wide queue forever.
 */
async function withAttachmentRequestDeadline<T>(
	work: (signal: AbortSignal) => Promise<T>,
	externalSignal?: AbortSignal,
): Promise<T> {
	externalSignal?.throwIfAborted();
	const controller = new AbortController();
	const boundaryClosed = Symbol("attachment request boundary closed");
	let closeBoundary!: () => void;
	let rejectBoundary!: (reason: unknown) => void;
	const boundary = new Promise<typeof boundaryClosed>((resolve, reject) => {
		closeBoundary = () => resolve(boundaryClosed);
		rejectBoundary = reject;
	});
	const onExternalAbort = () => {
		const reason =
			externalSignal === undefined
				? new DOMException("Aborted", "AbortError")
				: abortReason(externalSignal);
		controller.abort(reason);
		rejectBoundary(reason);
	};
	externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	if (externalSignal?.aborted) onExternalAbort();
	const timeoutId = setTimeout(() => {
		const error = new AttachmentRejected(
			"The attachment request timed out. Check your connection and try again.",
		);
		controller.abort(error);
		rejectBoundary(error);
	}, ATTACHMENT_REQUEST_TIMEOUT_MS);
	try {
		const result = await Promise.race([work(controller.signal), boundary]);
		if (result === boundaryClosed) {
			throw new Error(
				"Attachment request boundary closed before fetch settled.",
			);
		}
		return result;
	} finally {
		// Settle the losing boundary after a successful/failed fetch so the
		// coordinator does not retain a permanently pending Promise.
		closeBoundary();
		clearTimeout(timeoutId);
		externalSignal?.removeEventListener("abort", onExternalAbort);
	}
}

async function fetchWithDeadline(
	input: RequestInfo | URL,
	init: RequestInit,
	externalSignal?: AbortSignal,
): Promise<Response> {
	return withAttachmentRequestDeadline(async (signal) => {
		const response = await fetch(input, { ...init, signal });
		// Headers are not completion. Keep the request boundary (and the
		// caller's Cancel signal) attached until the peer's success or error
		// body has actually ended. This also prevents an ignored response body
		// from retaining a transport outside the entry coordinator.
		await response.arrayBuffer();
		return response;
	}, externalSignal);
}

async function postJson<T>(
	url: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	return withAttachmentRequestDeadline(async (requestSignal) => {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: requestSignal,
		});
		if (!res.ok) {
			// Parsing the route's person-to-person error is part of the same
			// request deadline. A peer that sends headers and stalls its body
			// must not hold the form-wide attachment queue forever.
			const detail = await res
				.json()
				.then((j: { error?: string }) => j.error)
				.catch(() => undefined);
			throw new AttachmentRejected(
				detail ??
					"That attachment couldn't be saved. Check your connection and try again.",
			);
		}
		return (await res.json()) as T;
	}, signal);
}

/**
 * Stage one file against a capture question.
 *
 * Neither the file's kind nor its size is trusted from here, the initiate
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
	try {
		signal?.throwIfAborted();

		const put = await fetchWithDeadline(
			initiate.uploadUrl,
			{
				method: "PUT",
				headers: {
					"Content-Type": initiate.uploadContentType,
					...initiate.uploadHeaders,
				},
				body: file,
			},
			signal,
		);
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
	} catch (error) {
		// POST minted a row, but no confirmed owner exists. Compensate outside
		// the entry queue and never wait on DELETE: a failed/hung cleanup is an
		// expiring orphan, not a reason to freeze the worker's form.
		scheduleAttachmentCleanup({
			appId,
			attachmentId: initiate.attachmentId,
		});
		throw error;
	}
}

/**
 * Discard a staged attachment.
 *
 * The caller clears its answer FIRST and calls this second. That ordering
 * is the opposite of the real runtime's, which deletes the bytes before
 * attempting the answer change and leaves a required question naming a
 * file it just removed. Doing it this way round means a failed delete
 * costs a staged orphan, which the scheduled row sweep and bucket TTL reap:
 * instead of a live answer pointing at nothing.
 */
export async function discardAttachment(args: {
	appId: string;
	attachmentId: string;
	signal?: AbortSignal;
}): Promise<void> {
	const response = await fetchWithDeadline(
		`/api/apps/${encodeURIComponent(args.appId)}/attachments/${encodeURIComponent(
			args.attachmentId,
		)}`,
		{ method: "DELETE" },
		args.signal,
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
}): Promise<string> {
	return withAttachmentRequestDeadline(async (requestSignal) => {
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
				signal: requestSignal,
			},
		);
		if (!response.ok) {
			const detail = await response
				.json()
				.then((body: { error?: unknown }) =>
					typeof body.error === "string" ? body.error : undefined,
				)
				.catch(() => undefined);
			throw new AttachmentRejected(
				detail ??
					"This attachment couldn't follow its repeat row. Attach it again.",
			);
		}
		const body = (await response.json()) as { instancePath?: unknown };
		if (
			typeof body.instancePath !== "string" ||
			body.instancePath.length === 0
		) {
			throw new AttachmentRejected(
				"The attachment move returned an invalid path. Retry now.",
			);
		}
		return body.instancePath;
	}, args.signal);
}
