/** Chat transcript, continuation and authority decisions shared by the live
 * controller and its direct protocol tests. No transport or React ownership. */
import type { ChatStatus, UIMessage } from "ai";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import type { ThreadDoc } from "@/lib/db/types";
import {
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain/blueprint";
import { uuidSchema } from "@/lib/domain/uuid";
import type { DesignSessionScope } from "@/lib/generation/designProgressWire";
import type {
	DesignProgressState,
	DesignProgressView,
} from "@/lib/session/designProgressStore";

/**
 * A design session owns the composer's one activity line for every unfinished
 * design/build stage, including the read-only post-materialization build. Once
 * the durable completion frame arrives it keeps ownership only until the
 * transport closes, so the final confirmation cannot briefly uncover an older
 * generic run warning and a settled app returns to the normal quiet composer.
 */
export function designProgressOwnsActivityStatus(
	view: Pick<DesignProgressView, "active" | "stage">,
	status: ChatStatus,
): boolean {
	/* A transport error must be visible until the effect that projects it into
	 * design progress has committed. Otherwise a stale working stage can hide
	 * the generic terminal error for one render, or indefinitely if ownership
	 * changed before the effect ran. */
	if (status === "error") {
		return (
			view.active && (view.stage === "failed" || view.stage === "incomplete")
		);
	}
	return (
		view.active &&
		(view.stage !== "ready" || status === "submitted" || status === "streaming")
	);
}

/** A design-session id is permanent thread lineage, but its progress UI is
 * live only while the accepted build is unfinished. Pre-app scope is itself
 * proof of an active build; after materialization the Builder session's
 * durable unfinished latch is authoritative. */
export function designSessionScopeTracksProgress(
	scope: DesignSessionScope,
	buildUnfinished: boolean,
): boolean {
	return scope.materializedAppId === null || buildUnfinished;
}

/** A design-backed conversation locks authoring only while its app still owns
 * the unfinished initial-build latch. Historical lineage alone must not
 * disable an otherwise editable composer. */
export function designProgressLocksInitialBuild(
	_view: Pick<DesignProgressView, "active" | "stage">,
	buildUnfinished: boolean,
): boolean {
	return buildUnfinished;
}

/** A design lineage persists after materialization, including through later
 * ordinary edits. Only an unfinished design build owns build-progress failure
 * presentation; an edit on the completed app remains on the generic chat path. */
export function designProgressTracksBuildFailure(
	progress: Pick<
		DesignProgressState,
		"designSessionId" | "materializedAppId" | "activeSlice"
	>,
	buildUnfinished: boolean,
): boolean {
	return (
		progress.designSessionId !== null &&
		(progress.materializedAppId === null ||
			buildUnfinished ||
			progress.activeSlice !== null)
	);
}

/** A sealed recoverable build failure has no live stream marker to re-drive
 * automatically, while the ordinary composer must stay frozen so a message
 * cannot revise the accepted contract. Offer one explicit continuation that
 * resubmits the exact transcript with `redrive`, adding no user text. */
export function designBuildCanResume(
	progress: Pick<DesignProgressState, "failure" | "seededStage">,
	buildUnfinished: boolean,
	status: ChatStatus,
): boolean {
	return (
		buildUnfinished &&
		(progress.failure?.recoverable === true ||
			(progress.failure === null && progress.seededStage === "incomplete")) &&
		status !== "submitted" &&
		status !== "streaming"
	);
}

/** Remember only durable/recoverable resume eligibility while a conversation
 * is inactive. The progress store itself resets on every thread switch, but an
 * unfinished accepted build must regain its server-derived `incomplete` floor
 * when its original design thread becomes active again. Fatal failure and
 * completion evidence revoke an older recoverable marker. */
export function rememberDesignBuildResumeEligibility(
	designSessionIds: Set<string>,
	progress: Pick<
		DesignProgressState,
		"designSessionId" | "failure" | "seededStage" | "completion"
	>,
): void {
	const designSessionId = progress.designSessionId;
	if (designSessionId === null) return;
	if (
		progress.failure?.recoverable === true ||
		(progress.failure === null && progress.seededStage === "incomplete")
	) {
		designSessionIds.add(designSessionId);
		return;
	}
	if (
		progress.failure !== null ||
		progress.completion !== null ||
		progress.seededStage === "failed" ||
		progress.seededStage === "ready"
	) {
		designSessionIds.delete(designSessionId);
	}
}

export function threadActivationNeedsIncompleteSeed(args: {
	readonly designSessionId: string;
	readonly buildUnfinished: boolean;
	readonly resume: boolean;
	readonly redrive: boolean;
	readonly resumableDesignSessionIds: ReadonlySet<string>;
}): boolean {
	return (
		args.buildUnfinished &&
		!args.resume &&
		!args.redrive &&
		args.resumableDesignSessionIds.has(args.designSessionId)
	);
}

/** The request-level duplicate/clawback semantics for an interrupted turn.
 * Ordinary chat re-drives use the SDK's regenerate trigger; a design build
 * must preserve its accumulated answered-question message, so its explicit
 * retry send carries the same capability through the request options body. */
export function chatRequestIsRedrive(
	trigger: "submit-message" | "regenerate-message",
	body: Record<string, unknown> | undefined,
): boolean {
	return trigger === "regenerate-message" || body?.redrive === true;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** The one structural read of "the trailing assistant message's parts",
 *  shared by every trailing-shape decision below so the extraction cannot
 *  drift between them. Accepts both live `UIMessage[]` and the loose stored
 *  thread shape; null when the transcript doesn't end on an assistant
 *  message. */
function trailingAssistantParts(
	messages: readonly unknown[],
): readonly unknown[] | null {
	const last = messages[messages.length - 1] as
		| { role?: unknown; parts?: unknown }
		| undefined;
	if (last?.role !== "assistant" || !Array.isArray(last.parts)) return null;
	return last.parts;
}

/** The askQuestions wire vocabulary, spelled once for every scanner. */
const isAskPart = (p: unknown): boolean =>
	(p as { type?: unknown }).type === "tool-askQuestions";
const isAnsweredAskPart = (p: unknown): boolean =>
	(p as { state?: unknown }).state === "output-available";
const isCompletedWaitForInputPart = (p: unknown): boolean => {
	const part = p as { type?: unknown; state?: unknown; output?: unknown };
	if (part.type !== "tool-waitForInput" || part.state !== "output-available") {
		return false;
	}
	const output = part.output as
		| { ok?: unknown; awaitingInput?: unknown }
		| undefined;
	return output?.ok === true && output.awaitingInput === true;
};

/** The transcript's trailing askQuestions posture, read off the LAST step of
 *  a trailing assistant message: `answered` (every ask has its output, the
 *  auto-resend shape, whose answers live in that trailing message),
 *  `awaiting-input` (the interactive card is up, unanswered), or `none`. */
export function trailingAskPosture(
	messages: readonly unknown[],
): "answered" | "awaiting-input" | "none" {
	const parts = trailingAssistantParts(messages);
	if (!parts) return "none";
	let lastStepIdx = -1;
	parts.forEach((p, i) => {
		if ((p as { type?: unknown }).type === "step-start") lastStepIdx = i;
	});
	const askParts = parts.slice(lastStepIdx + 1).filter(isAskPart);
	if (askParts.length === 0) return "none";
	return askParts.every(isAnsweredAskPart) ? "answered" : "awaiting-input";
}

/** A completed server-side wait is intentionally not an interactive card.
 * Its durable tool part still tells the progress region that the closed stream
 * is waiting for the person's next message. */
export function trailingDesignWaitsForInput(
	messages: readonly unknown[],
): boolean {
	const parts = trailingAssistantParts(messages);
	if (!parts) return false;
	let lastStepIdx = -1;
	parts.forEach((p, i) => {
		if ((p as { type?: unknown }).type === "step-start") lastStepIdx = i;
	});
	return parts.slice(lastStepIdx + 1).some(isCompletedWaitForInputPart);
}

/** AI SDK keeps an optimistic user message when its request fails. If that
 * message immediately followed a completed design wait, the server still owns
 * the paused hold and the exact retained transcript is safe to submit again.
 * A second typed message is not equivalent, so callers expose an explicit
 * retry instead of reopening the ordinary composer. */
export function trailingTypedDesignWaitContinuation(
	messages: readonly unknown[],
): boolean {
	if (messages.length < 2) return false;
	const last = messages.at(-1) as { role?: unknown } | undefined;
	if (last?.role !== "user") return false;
	return trailingDesignWaitsForInput([messages.at(-2)]);
}

/** Claim the design-backed creation path synchronously. The blank-app action
 * stays visually enabled while it fades, so the shared ref is the authority
 * that prevents a click race before React commits the hidden state. */
export function claimDesignAgentPath(args: {
	readonly blankAppCreationInProgress: boolean;
	readonly agentEngaged: { current: boolean };
	readonly clearSendFailure: () => void;
}): boolean {
	if (args.blankAppCreationInProgress) return false;
	args.agentEngaged.current = true;
	args.clearSendFailure();
	return true;
}

/** Only auto-resend when the assistant's LAST step is askQuestions with all outputs available.
 *  If the SA continued past tool calls to ask a freeform text question, don't auto-resend:
 *  the user needs to reply manually first. */
export function shouldAutoResend({
	messages,
}: {
	messages: UIMessage[];
}): boolean {
	return trailingAskPosture(messages) === "answered";
}

/** Keep app-owned conversation text while retiring Project-owned asset
 * references and their source filenames/extract summaries. The destination
 * thread reload supplies S02c3's authoritatively remapped refs. */
export function retireProjectAttachmentRefs(
	messages: readonly NovaUIMessage[],
): NovaUIMessage[] {
	return messages.map((message) => {
		if (!message.metadata?.attachments?.length) return message;
		const { attachments: _retired, ...metadata } = message.metadata;
		return {
			...message,
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		};
	});
}

/** Reconcile a destination-owned thread with the only local state the server
 * may legitimately not know yet: an optimistic trailing user turn whose POST
 * was stopped at the Project boundary before the chat route persisted it.
 *
 * The authoritative transcript always wins for shared ids and ordering. Only
 * the local suffix after the last shared id is considered, and only fresh
 * user text objects are appended: no metadata, attachment references, tool
 * parts, or assistant output can cross the Project boundary through this
 * recovery seam. With no shared id, at most the final local message is eligible
 * (the new-thread-before-first-persist case). */
export function mergeRetainedUserTextSuffix(
	authoritative: readonly NovaUIMessage[],
	retainedLocal: readonly NovaUIMessage[],
): NovaUIMessage[] {
	const authoritativeIds = new Set(
		authoritative.map((message) => message.id).filter(Boolean),
	);
	let lastSharedIndex = -1;
	for (let index = retainedLocal.length - 1; index >= 0; index--) {
		const id = retainedLocal[index]?.id;
		if (id && authoritativeIds.has(id)) {
			lastSharedIndex = index;
			break;
		}
	}
	const suffix =
		lastSharedIndex >= 0
			? retainedLocal.slice(lastSharedIndex + 1)
			: retainedLocal.slice(-1);
	const recovered: NovaUIMessage[] = [];
	for (const message of suffix) {
		if (
			message.role !== "user" ||
			!message.id ||
			authoritativeIds.has(message.id)
		)
			continue;
		const textParts = message.parts.flatMap((part) =>
			part.type === "text" && part.text.length > 0
				? [{ type: "text" as const, text: part.text }]
				: [],
		);
		if (textParts.length === 0) continue;
		recovered.push({ id: message.id, role: "user", parts: textParts });
	}
	return [...authoritative, ...recovered];
}

/** Adopt a refetched authoritative transcript WITHOUT downgrading what the
 * live view already rendered: for a shared assistant message id, keep the
 * LOCAL copy when it holds MORE parts or a strict streamed text extension (the fold's
 * terminal write can fail after the resume delivered the full answer, leaving
 * the row at its last barrier; wholesale adoption would visibly truncate an
 * answer the user just watched finish, and the next send's history would
 * carry the truncation forward). Stored order and membership stay
 * authoritative; local-only messages are NOT appended (a clawed-back failed
 * turn's partial must stay gone), and user messages are untouched (their
 * stored attachment metadata is authoritative). */
export function adoptTranscriptKeepingRicherLocal(
	stored: NovaUIMessage[],
	local: readonly NovaUIMessage[],
): NovaUIMessage[] {
	const localById = new Map(local.map((message) => [message.id, message]));
	return stored.map((message) => {
		if (message.role !== "assistant") return message;
		const localCopy = localById.get(message.id);
		if (localCopy?.role !== "assistant") return message;
		if (localCopy.parts.length > message.parts.length) return localCopy;
		if (localCopy.parts.length !== message.parts.length) return message;
		let extendsText = false;
		const sameStream = message.parts.every((storedPart, index) => {
			const localPart = localCopy.parts[index];
			if (
				(storedPart.type === "text" || storedPart.type === "reasoning") &&
				localPart?.type === storedPart.type
			) {
				if (!localPart.text.startsWith(storedPart.text)) return false;
				if (localPart.text.length > storedPart.text.length) extendsText = true;
				// Streaming status changes as the same part finishes. All other
				// metadata must still agree before local text can extend storage.
				const {
					text: _storedText,
					state: _storedState,
					...storedRest
				} = storedPart;
				const {
					text: _localText,
					state: _localState,
					...localRest
				} = localPart;
				return JSON.stringify(storedRest) === JSON.stringify(localRest);
			}
			return JSON.stringify(storedPart) === JSON.stringify(localPart);
		});
		return sameStream && extendsText ? localCopy : message;
	});
}

export function chatGenerationCanWrite(
	session:
		| { accessPhase: string; projectCanEdit: boolean; scopeEpoch: number }
		| undefined,
	ownerScopeEpoch: number,
	threadHydrationState: "ready" | "pending" | "failed",
): boolean {
	return (
		chatCallbackCanPublish(session, ownerScopeEpoch, threadHydrationState) &&
		session?.projectCanEdit === true
	);
}

/** Shared continuation gate for callbacks that may publish after their Chat was
 * stopped. Reads do not require edit capability, but they must belong to the
 * current authorized Project generation and an authoritative transcript. */
export function chatCallbackCanPublish(
	session: { accessPhase: string; scopeEpoch: number } | undefined,
	ownerScopeEpoch: number,
	threadHydrationState: "ready" | "pending" | "failed",
): boolean {
	return (
		session !== undefined &&
		session.accessPhase === "authorized" &&
		session.scopeEpoch === ownerScopeEpoch &&
		threadHydrationState === "ready"
	);
}

/** A thread doc as the LOADERS return it: the stored shape plus two derived
 *  stamps. `resume_interrupted`: the row holds a live-stream marker whose app
 *  no live run holds (a run killed mid-turn); level-triggered server-side (it
 *  stands until a re-drive's run retires the marker), consumed once per
 *  activation here. `run_paused`: the app's current holder is this thread's
 *  run AND it is parked awaiting an askQuestions answer: the ACTUAL pause
 *  posture, which transcript shape alone cannot reveal. */
export type LoadedThreadDoc = ThreadDoc & {
	resume_interrupted?: boolean;
	run_paused?: boolean;
};

/** Whether a loaded thread's interrupted turn should auto-re-drive. Barrier
 *  persistence means a dead run's transcript can end on a PARTIAL assistant
 *  message, so the trigger is the server's interruption stamp, refined by the
 *  askQuestions parts of the WHOLE trailing assistant message (not just its
 *  last step: a died continuation can have completed steps AFTER the
 *  answered round, and slicing to the last step would misread that message
 *  as ask-free):
 *
 *   - ANY answered ask part blocks the auto-re-drive: `regenerate()` trims
 *     the entire trailing assistant message, and that message is where the
 *     user's answers live, so re-driving would destroy them and re-ask. The
 *     user recovers by sending a new message (matching what the old
 *     trailing-role guard did for this same death).
 *   - An UNANSWERED round blocks only while the run is GENUINELY paused
 *     (`run_paused`): a paused round resumes through the answer POST. A
 *     question round whose run died BEFORE it could pause shows the same
 *     card but is not paused, so re-driving it (and re-asking) is correct
 *     recovery.
 */
export function shouldAutoRedrive(
	thread: Pick<
		LoadedThreadDoc,
		"resume_interrupted" | "run_paused" | "messages"
	>,
): boolean {
	if (thread.resume_interrupted !== true) return false;
	const parts = trailingAssistantParts(thread.messages);
	if (!parts) return true;
	const askParts = parts.filter(isAskPart);
	if (askParts.some(isAnsweredAskPart)) return false;
	return !(askParts.length > 0 && thread.run_paused === true);
}

/** Authority carried by a server-loaded thread. Every activation must adopt
 * both values together; an omitted nonce is itself authoritative and clears a
 * capability retained from an older activation. `buildUnfinished` is the
 * session store's live latch (every caller passes `liveBuildUnfinished()`):
 * a resumed/re-driven run on an unfinished build must capture as a build. */
export function authoritativeThreadActivationOptions(
	thread: Pick<
		LoadedThreadDoc,
		| "run_id"
		| "holder_nonce"
		| "active_stream_id"
		| "resume_interrupted"
		| "run_paused"
		| "messages"
		| "design_session_id"
	>,
	buildUnfinished: boolean,
	options?: { allowRedrive?: boolean },
) {
	const resume = thread.active_stream_id != null;
	const redrive =
		!resume && options?.allowRedrive !== false && shouldAutoRedrive(thread);
	return {
		runId: thread.run_id,
		holderNonce: thread.holder_nonce,
		resume,
		redrive,
		buildResume: (resume || redrive) && buildUnfinished,
		buildUnfinished,
		/* The thread's design lineage rides every activation so the sends it
		 * feeds keep addressing the session scope. */
		designSessionId: thread.design_session_id ?? null,
	};
}

/** `/build/new` keeps the Project captured by its RSC render even if another
 * tab later changes the session's active Project cookie. Existing apps are
 * already scoped by app id and send no creation target. */
export function expectedProjectIdForChatRequest(session: {
	appId: string | undefined;
	projectId: string | undefined;
}): string | undefined {
	return session.appId === undefined ? session.projectId : undefined;
}

export type ThreadResumeHealTarget =
	| { readonly kind: "app"; readonly id: string }
	| { readonly kind: "design-session"; readonly id: string };

/** Resolve the authoritative transcript endpoint after a reconnect closes.
 * Pre-app design threads have no app id yet, but are no less durable: their
 * design-session identity is the read scope until materialization. */
export function threadResumeHealTarget(
	appId: string | undefined,
	designSessionId: string | undefined,
): ThreadResumeHealTarget | null {
	return appId
		? { kind: "app", id: appId }
		: designSessionId
			? { kind: "design-session", id: designSessionId }
			: null;
}

export function threadResumeHealPath(
	target: ThreadResumeHealTarget,
	threadId: string,
): string {
	const targetPath =
		target.kind === "app"
			? `/api/apps/${encodeURIComponent(target.id)}`
			: `/api/design-sessions/${encodeURIComponent(target.id)}`;
	return `${targetPath}/threads/${encodeURIComponent(threadId)}`;
}

export interface AppMaterializationActivation {
	readonly eventVersion: 1;
	readonly designSessionId: string | null;
	readonly appId: string;
	readonly projectId: string;
	readonly role: string;
	readonly canEdit: boolean;
	readonly seq: 1;
	readonly batchId: string;
	readonly changeSetId: string | null;
	readonly snapshotDigest: string;
	readonly blueprint: PersistableDoc;
	readonly starter: {
		readonly moduleUuid: string;
		readonly formUuid: string;
		readonly fieldUuid: string;
	} | null;
}

/** Strict boundary for the server's one-shot app-birth handoff — the
 * `data-app-materialized` frame (design-slice genesis) and the blank-app
 * action's return value share this exact shape. Never activate multiplayer
 * from a partial event: identity, Project capability, exact sequence-1
 * blueprint, and its canonical digest are one authority. `starter` is
 * non-null only on the explicit-blank path, where the blueprint must be
 * exactly the canonical Survey/Form/Question starter; a design-slice
 * blueprint is the first meaningful workflow and only its validity and
 * identity are asserted here (the digest pins the exact bytes). */
export function parseAppMaterializationReceipt(
	data: Record<string, unknown>,
): AppMaterializationActivation | null {
	if (
		Object.keys(data).sort().join(",") !==
		"appId,batchId,blueprint,canEdit,changeSetId,designSessionId,eventVersion,projectId,role,seq,snapshotDigest,starter"
	) {
		return null;
	}
	const {
		eventVersion,
		designSessionId,
		appId,
		projectId,
		role,
		canEdit,
		seq,
		batchId,
		changeSetId,
		snapshotDigest,
		starter,
	} = data;
	const parsedBlueprint = blueprintDocSchema.safeParse(data.blueprint);
	if (
		eventVersion !== 1 ||
		seq !== 1 ||
		typeof appId !== "string" ||
		appId.trim().length === 0 ||
		typeof projectId !== "string" ||
		projectId.trim().length === 0 ||
		typeof role !== "string" ||
		role.trim().length === 0 ||
		typeof canEdit !== "boolean" ||
		typeof batchId !== "string" ||
		batchId.trim().length === 0 ||
		!(
			designSessionId === null ||
			(typeof designSessionId === "string" && designSessionId.trim().length > 0)
		) ||
		!(
			changeSetId === null ||
			(typeof changeSetId === "string" && changeSetId.trim().length > 0)
		) ||
		typeof snapshotDigest !== "string" ||
		!/^[0-9a-f]{64}$/.test(snapshotDigest) ||
		!parsedBlueprint.success
	) {
		return null;
	}
	const blueprint = parsedBlueprint.data;
	if (
		blueprint.appId !== appId ||
		blueprint.appName.trim().length === 0 ||
		blueprint.moduleOrder.length === 0
	) {
		return null;
	}
	if (starter === null) {
		return {
			eventVersion: 1,
			designSessionId,
			appId,
			projectId,
			role,
			canEdit,
			seq: 1,
			batchId,
			changeSetId,
			snapshotDigest,
			blueprint,
			starter: null,
		};
	}
	if (
		typeof starter !== "object" ||
		Array.isArray(starter) ||
		Object.keys(starter as object)
			.sort()
			.join(",") !== "fieldUuid,formUuid,moduleUuid"
	) {
		return null;
	}
	const starterRecord = starter as Record<string, unknown>;
	const moduleUuid = uuidSchema.safeParse(starterRecord.moduleUuid);
	const formUuid = uuidSchema.safeParse(starterRecord.formUuid);
	const fieldUuid = uuidSchema.safeParse(starterRecord.fieldUuid);
	if (!moduleUuid.success || !formUuid.success || !fieldUuid.success) {
		return null;
	}
	if (
		blueprint.connectType !== null ||
		blueprint.caseTypes !== null ||
		blueprint.moduleOrder.length !== 1 ||
		Object.keys(blueprint.modules).length !== 1 ||
		Object.keys(blueprint.forms).length !== 1 ||
		Object.keys(blueprint.fields).length !== 1 ||
		blueprint.moduleOrder[0] !== moduleUuid.data ||
		blueprint.formOrder[moduleUuid.data]?.[0] !== formUuid.data ||
		blueprint.fieldOrder[formUuid.data]?.[0] !== fieldUuid.data ||
		blueprint.modules[moduleUuid.data] === undefined ||
		blueprint.forms[formUuid.data]?.type !== "survey" ||
		blueprint.fields[fieldUuid.data]?.kind !== "text"
	) {
		return null;
	}
	return {
		eventVersion: 1,
		designSessionId,
		appId,
		projectId,
		role,
		canEdit,
		seq: 1,
		batchId,
		changeSetId,
		snapshotDigest,
		blueprint,
		starter: {
			moduleUuid: moduleUuid.data,
			formUuid: formUuid.data,
			fieldUuid: fieldUuid.data,
		},
	};
}
