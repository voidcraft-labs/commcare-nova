/**
 * ChatContainer: owns all chat lifecycle state (useChat, Chat instance,
 * stream effects) so that chat message changes ONLY re-render this subtree,
 * never BuilderLayout or the preview/structure panels.
 *
 * This is the key architectural boundary: useChat produces React state
 * (messages, status) that changes on every streamed token. By isolating
 * useChat here instead of in BuilderLayout, those per-token re-renders
 * are scoped to ChatSidebar: the only component that needs messages.
 *
 * THREADS. A conversation is a durable thread (`threads` row, server-written
 * by the chat route). This component owns which thread is open:
 *
 *  - The page loads with the most recently active thread hydrated
 *    (`initialThread`): a refresh always lands back in the conversation the
 *    user was in, with its full transcript in `useChat`.
 *  - The Chat instance's id IS the thread id, and a thread that has a run in
 *    flight (`active_stream_id`) is resumed on mount via `resumeStream()`:
 *    the transport reconnects by thread id and replays the live stream, so a
 *    refresh mid-run looks like nothing happened.
 *  - A thread whose run DIED mid-flight (instance kill: the loader detected
 *    a dead live-stream marker and stamped `resume_interrupted`) is
 *    RE-DRIVEN on open: `regenerate()` re-runs the unanswered turn through
 *    the normal POST/claim/charge machinery, so from the user's side the
 *    response simply arrives. The stamp is LEVEL-TRIGGERED: the loaders
 *    never clear the marker, so the signal stands across loads until a
 *    re-drive's own run retires it (a re-drive that dies is detected again;
 *    one that loses the race bails clean and attaches to the winner).
 *  - Switching threads (or "New chat") swaps the Chat instance; sending in
 *    any thread just continues it: the full history rides every POST.
 */
"use client";
import { Chat, useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createStarterApp } from "@/app/(app)/build/actions";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import {
	DesignProgressDetails,
	DesignProgressStatus,
} from "@/components/chat/DesignProgressPanel";
import { StartFromScratch } from "@/components/chat/StartFromScratch";
import { parseApiErrorMessage } from "@/lib/apiError";
import {
	type AttachmentRef,
	messageMetadataSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import { NovaChatTransport } from "@/lib/chat/novaChatTransport";
import type { ReconcilerContextValue } from "@/lib/collab/context";
import { useReconcilerContext } from "@/lib/collab/context";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import type { ThreadDoc, ThreadMeta } from "@/lib/db/types";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import {
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain/blueprint";
import { uuidSchema } from "@/lib/domain/uuid";
import {
	type DesignSessionSeed,
	parseDesignSessionScope,
} from "@/lib/generation/designProgressWire";
import {
	applyStreamEvent,
	conversationEventError,
} from "@/lib/generation/streamDispatcher";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import {
	createDesignProgressStore,
	type DesignProgressStoreApi,
	useDesignProgressView,
} from "@/lib/session/designProgressStore";
import {
	deriveChatAppReady,
	useAccessPhase,
	useCanEdit,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { BuilderSessionContext } from "@/lib/session/provider";
import { markAppListStale } from "@/lib/ui/appListFreshness";
import type { ToastOptions, ToastSeverity } from "@/lib/ui/toastStore";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

type ProjectToastEmitter = (
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: ToastOptions,
) => string;

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

/** The transcript's trailing askQuestions posture, read off the LAST step of
 *  a trailing assistant message: `answered` (every ask has its output, the
 *  auto-resend shape, whose answers live in that trailing message),
 *  `awaiting-input` (the interactive card is up, unanswered), or `none`. */
function trailingAskPosture(
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

/** Only auto-resend when the assistant's LAST step is askQuestions with all outputs available.
 *  If the SA continued past tool calls to ask a freeform text question, don't auto-resend:
 *  the user needs to reply manually first. */
function shouldAutoResend({ messages }: { messages: UIMessage[] }): boolean {
	return trailingAskPosture(messages) === "answered";
}

/** The active thread as the Chat instance sees it: the id doubles as the
 *  transport's reconnect handle. */
interface ActiveThreadInit {
	threadId: string;
	messages: NovaUIMessage[];
}

const chatOwnerEpochs = new WeakMap<Chat<NovaUIMessage>, number>();

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
 * LOCAL copy when it holds MORE parts than the stored one (the fold's
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
		return localCopy &&
			localCopy.role === "assistant" &&
			localCopy.parts.length > message.parts.length
			? localCopy
			: message;
	});
}

export function chatGenerationCanWrite(
	session:
		| { accessPhase: string; canEdit: boolean; scopeEpoch: number }
		| undefined,
	ownerScopeEpoch: number,
	threadHydrationState: "ready" | "pending" | "failed",
): boolean {
	return (
		chatCallbackCanPublish(session, ownerScopeEpoch, threadHydrationState) &&
		session?.canEdit === true
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
type LoadedThreadDoc = ThreadDoc & {
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

/** Digest-verify an admitted receipt in the background: SHA-256 over the
 * shared canonical JSON text, compared to the server's `snapshotDigest`. The
 * install itself is synchronous (later frames in the same stream must land
 * on the installed doc), so a mismatch — a should-never corruption signal —
 * surfaces as the reload toast rather than blocking activation. Skipped
 * where WebCrypto is unavailable. */
function verifyActivationDigest(
	activation: AppMaterializationActivation,
	projectToast: ProjectToastEmitter,
): void {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) return;
	void subtle
		.digest(
			"SHA-256",
			new TextEncoder().encode(canonicalJsonText(activation.blueprint)),
		)
		.then((bytes) => {
			const hex = Array.from(new Uint8Array(bytes))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			if (hex !== activation.snapshotDigest) {
				projectToast(
					"error",
					"Reload to finish opening this app",
					"The app Nova sent this tab didn't verify against its receipt. Reload to fetch it fresh.",
					{
						persistent: true,
						action: {
							label: "Reload page",
							onPress: () => window.location.reload(),
						},
					},
				);
			}
		})
		.catch(() => {});
}

/**
 * Land a validated creation receipt. Nova has two ways an app is born, the
 * design build's `data-app-materialized` frame and the blank-app action's
 * return value, and both arrive here, so a new app cannot land two different
 * ways.
 *
 * The order is the contract. Identity and capability first, then the exact
 * sequence-1 blueprint under a remote-apply bracket (which is what keeps this
 * authoritative hydration out of undo and away from auto-save), then the URL
 * promotion from `/build/new`, and only then multiplayer, seeded at the same
 * cursor the document it just installed came from.
 *
 * The URL moves through `pushBuilderHistory`, the builder's own History-API
 * write path, NOT the Next router: a route change would swap
 * `BuilderProvider`'s `key={buildId}` and remount every store under it,
 * discarding the document this function just installed and severing a live run
 * to fetch state the client already holds.
 *
 * The last line is the app list. Installing in place means the history entry
 * behind this one is the list as it stood before the app existed, and
 * back/forward is served from the client Router Cache regardless of how fresh
 * the route itself is — so a user pressing Back would not see the app they just
 * made. `lib/ui/appListFreshness` records that; the list refreshes itself when
 * it is next shown, which is the one cure that touches neither the URL nor the
 * history stack.
 */
function installCreatedApp(
	activation: AppMaterializationActivation,
	docApi: BlueprintDocStore,
	sessionApi: BuilderSessionStoreApi,
	reconcilerCtx: ReconcilerContextValue | null,
): void {
	sessionApi.getState().activateCreatedApp(activation.appId, {
		projectId: activation.projectId,
		role: activation.role,
		canEdit: activation.canEdit,
	});
	const store = docApi.getState();
	store.beginRemoteApply();
	try {
		store.commitDoc(hydratePersistedBlueprint(activation.blueprint));
	} finally {
		store.endRemoteApply();
	}
	pushBuilderHistory(`/build/${activation.appId}`, true);
	reconcilerCtx?.activate(activation.appId, activation.seq);
	markAppListStale();
}

/** Create a Chat instance with transport, data handling, and auto-resend config.
 *  Closures capture refs (not direct values) so they always read the latest
 *  store references: safe across re-renders within the same app session. */
/** Consecutive fatal-error strikes at which the answered-askQuestions
 *  auto-resend stops retrying. Two, not one: the first strike may be a
 *  transient infrastructure fault whose single automatic retry succeeds
 *  unnoticed; a second consecutive fatal error means the rejection is real
 *  and retrying unattended only re-runs it. */
const AUTO_RESEND_FATAL_HALT_STRIKES = 2;

function createChatInstance(
	init: ActiveThreadInit,
	docStoreRef: { current: BlueprintDocStore | null },
	sessionStoreRef: { current: BuilderSessionStoreApi | null },
	runIdRef: { current: string | undefined },
	holderNonceRef: { current: string | undefined },
	designSessionIdRef: { current: string | undefined },
	designProgressStore: DesignProgressStoreApi,
	reconcilerCtxRef: { current: ReconcilerContextValue | null },
	ownUserIdRef: { current: string | undefined },
	autoResendFatalStrikesRef: { current: number },
	threadHydrationStateRef: {
		current: "ready" | "pending" | "failed";
	},
	projectToast: ProjectToastEmitter,
	ownerScopeEpoch: number,
): Chat<NovaUIMessage> {
	/* A fresh Chat instance starts with a clean slate: the strike count
	 * guards runs of THIS instance, not whatever a previously open thread
	 * ended on. */
	autoResendFatalStrikesRef.current = 0;
	/* The per-send request fields (beyond `messages`). The blueprint is NEVER
	 * sent: the route loads the persisted doc server-side off the
	 * authorization read. We send only the `appId`.
	 *
	 * `appReady` here is ADVISORY: the route derives the authoritative
	 * build-vs-edit mode (charge, claim, resume, prompt) from the app row's
	 * own status and only compares this field against it for telemetry. It is
	 * still computed honestly, through the SAME `deriveChatAppReady` the cost
	 * chip renders (the session store's `buildUnfinished` latch is what keeps
	 * a mid-build send reading as build-mode after an askQuestions pause has
	 * cleared the events buffer), so a disagreement warn server-side means a
	 * real drift, not a known one. */
	const requestFields = () => {
		const doc = docStoreRef.current?.getState();
		const session = sessionStoreRef.current;
		if (!session) return {};
		const sessionState = session.getState();
		const hasData = (doc?.moduleOrder.length ?? 0) > 0;
		return {
			threadId: init.threadId,
			runId: runIdRef.current,
			holderNonce: holderNonceRef.current,
			appId: sessionState.appId,
			/* The thread's design lineage, when it has one: a build thread is
			 * session-targeted for its whole life, so the route needs the id on
			 * every send — the session resolves its own bound app. Learned from
			 * the thread's own row on activation or from the stream's
			 * `data-design-session` frame. */
			designSessionId: designSessionIdRef.current,
			expectedProjectId: expectedProjectIdForChatRequest(sessionState),
			appReady: deriveChatAppReady(sessionState, hasData),
		};
	};

	/* The filter's step count must be the Chat's LIVE state at each reconnect
	 * (a heal can re-activate with fresher hydration than `init.messages`),
	 * but the transport is constructed before the Chat exists, so it reads
	 * through this box, re-pointed at the instance below. */
	let hydratedMessages: () => readonly unknown[] = () => init.messages;
	const transport = new NovaChatTransport<NovaUIMessage>(
		{
			api: "/api/chat",
			maxConsecutiveErrors: 5,
			/* Unlike DefaultChatTransport there is no `body` option: the
			 * request is assembled here. The returned body REPLACES the default
			 * wholesale, so `messages` must be included explicitly, and so do
			 * the headers: the transport sends exactly what this returns, and a
			 * JSON POST without an explicit content-type goes out as
			 * `text/plain` (fetch's default for a string body). */
			prepareSendMessagesRequest: ({ api, messages, trigger }) => {
				/* Deliberately NO strike reset here: this callback fires for the
				 * automatic resends too, and a reset per outbound attempt would
				 * unbound the very loop the strike cap exists to stop. The resets
				 * live on the USER actions (`handleSubmit`, `handleToolOutput`)
				 * and on a fresh Chat instance. */
				return {
					api,
					headers: { "content-type": "application/json" },
					body: {
						messages,
						...requestFields(),
						/* `regenerate()` fires in exactly one place: the instance-death
						 * re-drive, so the trigger doubles as the wire flag. The route
						 * treats a re-drive's claim conflict as "someone else already
						 * re-drove this" and closes clean instead of queueing a
						 * duplicate run. */
						...(trigger === "regenerate-message" ? { redrive: true } : {}),
					},
				};
			},
		},
		() => hydratedMessages(),
	);

	const instance = new Chat<NovaUIMessage>({
		/* The thread id IS the chat id: the transport's cold reconnect
		 * (`resumeStream` → `reconnectToStream({chatId})`) hits
		 * `/api/chat/{chatId}/stream`, and the endpoint resolves a thread id
		 * to its live stream, so a page refresh resumes with zero extra
		 * wiring. */
		id: init.threadId,
		/* The hydrated transcript: history renders through the same
		 * ChatMessage path as live turns, and every send carries the whole
		 * conversation to the SA. */
		messages: init.messages,
		// Validates any message metadata the SDK parses on the client. Outbound
		// attachment metadata rides `sendMessage`; INBOUND, the server stamps
		// `{ model }` on every assistant message's start chunk, and that stamp is
		// load-bearing: it round-trips through this transcript back to the route,
		// where `sanitizeHistoricalReasoningParts` reads it to decide whether a
		// paused round's model-bound encrypted reasoning is still replayable.
		messageMetadataSchema,
		/* NovaChatTransport (WorkflowChatTransport under the hood) instead of
		 * DefaultChatTransport: when the POST's SSE ends WITHOUT a `finish`
		 * chunk: a network blip, a mid-run deploy hiccup, Cloud Run's
		 * 60-minute request cap: it reconnects to
		 * `/api/chat/{x-workflow-run-id}/stream?startIndex=<chunks received>`
		 * and resumes from the durable chunk log, instead of surfacing
		 * "Generation failed" while the run keeps going server-side. Only the
		 * transport is from the workflow package: the server side is Nova's
		 * own Postgres-backed endpoint, no workflow runtime involved.
		 *
		 * The Nova subclass covers barrier persistence's one wrinkle: a COLD
		 * resume (page refresh onto a live run) hydrated the completed steps
		 * from the thread row, so its full replay is windowed CLIENT-side
		 * against this Chat's own copy of the message the replay's `start`
		 * chunk names (`lib/chat/hydratedStepFilter`): no duplicated parts, no
		 * server-guessed boundary to race the hydration, and every transient
		 * `data-*` chunk (events, receipts) still replays. The send path's own
		 * broken-POST recovery is deliberately untouched: that client built
		 * its message from the wire and needs exact-index replay. */
		transport,
		sendAutomaticallyWhen: (args) => {
			/* Consecutive FATAL generation errors halt the answered-askQuestions
			 * auto-resend until the user acts (answers again, sends a message,
			 * or reloads). The route's graceful bails (superseded / released
			 * resumes and their kin) stream that error and close CLEAN, so
			 * without this cap the SDK's post-request evaluation still sees an
			 * answered round as the last message and immediately re-sends: one
			 * rejection became an unattended ~1/s retry loop measured at 6,369
			 * POSTs before the tab closed. The cap is 2 rather than 1 so a
			 * one-off transient fault (an infra blip the route streams as
			 * fatal) still self-heals on the single automatic retry the old
			 * unconditional resend provided. */
			if (autoResendFatalStrikesRef.current >= AUTO_RESEND_FATAL_HALT_STRIKES)
				return false;
			const owner = sessionStoreRef.current?.getState();
			return (
				chatGenerationCanWrite(
					owner,
					ownerScopeEpoch,
					threadHydrationStateRef.current,
				) && shouldAutoResend(args)
			);
		},
		onData: (part) => {
			const ownerSession = sessionStoreRef.current?.getState();
			/* A Chat transport can deliver a buffered chunk after its Project was
			 * reset. Its callbacks close over the generation that created it; never
			 * reinterpret source chunks under the destination session. */
			if (
				!chatCallbackCanPublish(
					ownerSession,
					ownerScopeEpoch,
					threadHydrationStateRef.current,
				)
			)
				return;
			const { type, data } = part as {
				type: string;
				data: Record<string, unknown>;
			};
			/* Count the fatal strike the moment a run reports a FATAL error
			 * (the same envelope the dispatcher toasts, read through the same
			 * typed reader). It must be read off the stream here, not inferred
			 * later: the bail stream closes cleanly, so by the time the SDK
			 * evaluates `sendAutomaticallyWhen` the failed response has left no
			 * message behind to tell this round apart from one that was never
			 * tried. */
			if (type === "data-conversation-event") {
				const error = conversationEventError(data);
				if (error?.fatal === true) {
					autoResendFatalStrikesRef.current += 1;
					/* A design build's progress region has to say the run stopped:
					 * the transcript's error toast is the only other signal, and a
					 * stage line still reading "Building your app" over a dead run
					 * is the exact dishonesty §15.12 forbids. */
					designProgressStore
						.getState()
						.markFailed(error.message, { recoverable: false });
				} else if (error !== null) {
					/* A RECOVERABLE error stops the run just as dead — the server
					 * settled and refunded; only a fresh send restarts it. Marking
					 * only fatal errors left the stage line spinning "Designing
					 * your app" over a toast that said retry (observed live). The
					 * pre-materialization guard keeps an edit turn's transient
					 * model error from halting a collapsed post-app region. */
					const progress = designProgressStore.getState();
					if (
						progress.designSessionId !== null &&
						progress.materializedAppId === null
					) {
						progress.markFailed(error.message, { recoverable: true });
					}
				}
			}
			if (type === "data-run-id") {
				runIdRef.current = data.runId as string;
				/* Set the reconciler's active run id BEFORE any frame can arrive,
				 * so a chat frame carrying this user's actorId + this runId is
				 * classified as a self-echo (and a runId-less peer-tab frame stays
				 * remote). */
				reconcilerCtxRef.current?.reconciler.setSelfActiveRunId(
					data.runId as string,
				);
				return;
			}
			if (type === "data-holder-nonce") {
				holderNonceRef.current = data.holderNonce as string;
				return;
			}
			if (type === "data-credit-refund") {
				/* Owner check: a shared thread's refresh-resume replays another
				 * member's run, refund chunk included: "you weren't charged" must
				 * only reach the actor who was. `userId` names the charged actor;
				 * a chunk without one (logged before the field existed) shows. */
				const refundedUser = data.userId as string | undefined;
				if (refundedUser && ownUserIdRef.current !== refundedUser) return;
				const amount = data.amount as number;
				// Reassurance, not an error: the failure itself is surfaced separately as
				// the generation-error toast (a data-conversation-event with an error
				// payload). Use "info" (neutral, auto-dismissing); the error toast is the
				// one that persists. The refund is server-authoritative and once-latched,
				// so this only fires once per failed run.
				projectToast(
					"info",
					"You weren't charged",
					`This run hit an error, so your ${amount} credits were refunded.`,
				);
				return;
			}

			const docApi = docStoreRef.current;
			const sessionApi = sessionStoreRef.current;
			if (!docApi || !sessionApi) return;

			/* The turn's design-session scope: the id this thread echoes on
			 * every later send (the route continues the session's build, or the
			 * edit of its materialized app), and — while `materializedAppId` is
			 * null — the signal that a BUILD is in flight with no app yet, which
			 * latches the store's unfinished-build read. A replay is
			 * idempotent. */
			if (type === "data-design-session") {
				const scope = parseDesignSessionScope(data);
				if (scope !== null) {
					designSessionIdRef.current = scope.designSessionId;
					designProgressStore.getState().beginSession(scope);
					if (scope.materializedAppId === null) {
						sessionStoreRef.current?.getState().markBuildUnfinished();
						if (window.location.pathname === "/build/new") {
							pushBuilderHistory(
								`/build/new?design=${encodeURIComponent(scope.designSessionId)}`,
								true,
							);
						}
					} else if (
						sessionStoreRef.current?.getState().appId !==
						scope.materializedAppId
					) {
						/* The session says genesis committed but this tab missed the
						 * activation receipt. Reload the authoritative app instead of
						 * leaving `/build/new` able to start a duplicate design. */
						window.location.replace(`/build/${scope.materializedAppId}`);
					}
				}
				return;
			}

			/* The durable progress projections (§15.4). Each is validated
			 * against this conversation's design session inside the store and
			 * dropped when it doesn't match, so an out-of-scope or
			 * unknown-version frame renders nothing rather than half a card. */
			if (designProgressStore.getState().applyProgressFrame(type, data)) {
				return;
			}
			/* The build finished: release the store's unfinished-build latch so
			 * `deriveChatAppReady` reads edit-mode from here on. Without the
			 * release, its `buildUnfinished && runCompletedAt === undefined`
			 * term re-arms once `acknowledgeCompletion` clears `runCompletedAt`
			 * (~3.5s after the celebration), and every later send would claim +
			 * charge as a BUILD. Falls through: the dispatcher consumes
			 * `data-done` too. */
			if (type === "data-done") {
				sessionApi.getState().markBuildFinished();
			}
			/* The doc-less sibling of `data-done`'s release: a purely
			 * conversational build turn still flips the app to `complete`
			 * server-side but has nothing to celebrate or reconcile, so the
			 * route emits this marker instead. Only the latch reacts; the
			 * dispatcher has no doc work to do for it. */
			if (type === "data-build-complete") {
				sessionApi.getState().markBuildFinished();
				return;
			}

			/* `data-app-materialized` is the one-shot authoritative birth
			 * handoff: the first meaningful workflow committed, and this frame
			 * carries identity, Project capability, the exact sequence-1
			 * blueprint, and its canonical digest together. A replay is
			 * idempotent, while a partial or cross-scope frame must not
			 * activate the dormant reconciler. */
			if (type === "data-app-materialized") {
				const activation = parseAppMaterializationReceipt(data);
				const current = sessionApi.getState();
				if (activation === null || current.projectId !== activation.projectId) {
					projectToast(
						"error",
						"Reload to finish opening this app",
						"Nova kept your work in this tab, but couldn't verify the new app's Project scope.",
						{
							persistent: true,
							action: {
								label: "Reload page",
								onPress: () => window.location.reload(),
							},
						},
					);
					return;
				}
				/* Fold the genesis slice into the progress count before the early
				 * return below: the first workflow's commit IS this receipt, and
				 * it emits no `slice-committed` frame of its own. Idempotent. */
				designProgressStore.getState().markMaterialized(activation.appId);
				if (current.appId === activation.appId) return; // replayed frame
				/* This tab now owns an UNFINISHED build. The RSC page only seeds
				 * the latch for tabs that LOADED a generating app; a `/build/new`
				 * tab must carry it from materialization or its later sends read
				 * as edit-mode the moment the phase derivation loses the run (an
				 * askQuestions pause clears the events buffer, and the committed
				 * modules make the doc read Ready). `data-done` above is the
				 * matching release. */
				sessionApi.getState().markBuildUnfinished();
				installCreatedApp(
					activation,
					docApi,
					sessionApi,
					reconcilerCtxRef.current,
				);
				verifyActivationDigest(activation, projectToast);
				return;
			}

			applyStreamEvent(
				type,
				data,
				docApi,
				sessionApi,
				reconcilerCtxRef.current?.reconciler ?? null,
				runIdRef.current,
				projectToast,
			);
		},
	});
	hydratedMessages = () => instance.messages;
	chatOwnerEpochs.set(instance, ownerScopeEpoch);
	return instance;
}

// ── Component ────────────────────────────────────────────────────────────

interface ChatContainerProps {
	/** Whether the layout is in centered mode (Idle phase: chat is the main content). */
	centered: boolean;
	/** Whether the app was loaded from Postgres (not a new build).
	 *  Drives the empty-state prompt text. */
	isExistingApp: boolean;
	/** Thread-list projection, most recently active first: loaded by the RSC
	 *  page; refreshed client-side after each run. */
	threads?: ThreadMeta[];
	/** The most recently active thread, transcript included: what this
	 *  session opens into. Null/absent on a brand-new build. May carry the
	 *  loader's derived `resume_interrupted` stamp (an instance-killed run
	 *  detected on this load), which triggers the auto-re-drive. */
	initialThread?: LoadedThreadDoc | null;
	/** True when the page loaded an app whose BUILD is unfinished, a
	 *  `generating` app, or an interrupted build admitted for re-drive.
	 *  MOUNT-TIME only: it seeds the initial resume/re-drive capture below;
	 *  every later decision reads the session store's `buildUnfinished`
	 *  latch, which the page seeds with this same value
	 *  (`BuilderProvider.initialBuildUnfinished`) and which then tracks the
	 *  in-tab creation handoff and `data-done`. `thread_type` can't drive
	 *  either (it freezes at thread creation, so the app's first
	 *  conversation reads "build" forever). */
	appGenerating?: boolean;
	/** The signed-in user: a replayed run's credit-refund notice is shown
	 *  only to the actor who was actually charged. */
	currentUserId?: string;
	/** A cold load of an existing design session (`/build/new?design=<id>`).
	 *  The stage is the SERVER's derivation over the durable session plus its
	 *  orchestration head, so a resumed design says where it stopped instead
	 *  of showing nothing until the next turn streams a frame. The outline and
	 *  plan are not seeded: they exist only in the frames a run streams, and
	 *  inventing them would be the fake-progress §15.1 rules out. */
	initialDesignSession?: DesignSessionSeed | null;
}

export function ChatContainer({
	centered,
	isExistingApp,
	threads,
	initialThread,
	appGenerating,
	currentUserId,
	initialDesignSession,
}: ChatContainerProps) {
	const docStore = useContext(BlueprintDocContext);
	const sessionApi = useContext(BuilderSessionContext);
	const reconcilerCtx = useReconcilerContext();
	const projectToast = useProjectToast();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	/* Viewers (view-only Project members) get a read-only conversation, the
	 * SA is the edit mechanism, so the composer hides. The write paths reject
	 * their edits server-side regardless. */
	const canEdit = useCanEdit();

	// ── Stable refs so Chat callbacks always read the latest stores ──────
	const docStoreRef = useRef(docStore);
	docStoreRef.current = docStore;
	const sessionStoreRef = useRef(sessionApi);
	sessionStoreRef.current = sessionApi;
	/* The reconciler context (reconciler + activation), read through a ref so
	 * the Chat callbacks always see the latest without recreating the Chat
	 * instance. */
	const reconcilerCtxRef = useRef(reconcilerCtx);
	reconcilerCtxRef.current = reconcilerCtx;
	const ownUserIdRef = useRef(currentUserId);
	ownUserIdRef.current = currentUserId;
	/** The LIVE unfinished-build signal, read at decision time. It lives in
	 *  the session store: seeded by the page's `initialBuildUnfinished`,
	 *  latched by a pre-app `data-design-session` frame, released by `data-done` /
	 *  `data-build-complete` or by a remote `app-status: complete` frame. A
	 *  component ref synced from the `appGenerating` prop cannot carry it:
	 *  the prop is frozen at page load (`/build/new` promotes via the History
	 *  API, no RSC re-render) and a per-render sync would clobber every
	 *  latch. */
	const liveBuildUnfinished = useCallback(
		() => sessionStoreRef.current?.getState().buildUnfinished ?? false,
		[],
	);
	/** Consecutive FATAL-error count for the current answered-askQuestions
	 *  round: incremented by the Chat instance's stream handler on every fatal
	 *  conversation-event error, reset to zero by a fresh user action (a new
	 *  answer via `handleToolOutput`, a typed message via `handleSubmit`) or a
	 *  new Chat instance. The auto-resend halts at
	 *  `AUTO_RESEND_FATAL_HALT_STRIKES`, so a TRANSIENT fault (an infra blip,
	 *  a claim-write hiccup) still self-heals on one automatic retry while a
	 *  PERSISTENT rejection stops after two POSTs instead of the unattended
	 *  ~1/s loop the boolean latch was built against. Lives on the component
	 *  so the user-action paths can reset what the factory's closures armed. */
	const autoResendFatalStrikesRef = useRef(0);
	const runIdRef = useRef<string | undefined>(initialThread?.run_id);
	const holderNonceRef = useRef<string | undefined>(
		initialThread?.holder_nonce,
	);
	/** The active thread's design lineage: seeded from the loaded thread row,
	 *  re-stamped on every thread activation, and updated by the stream's
	 *  `data-design-session` frame. Undefined for app-born edit threads and
	 *  for a fresh `/build/new` conversation until its first turn's frame
	 *  arrives. A RESUMED design also seeds it from the page's own session, so
	 *  a send continues that design even if its transcript came back empty
	 *  rather than quietly starting a second one. */
	const designSessionIdRef = useRef<string | undefined>(
		initialThread?.design_session_id ??
			initialDesignSession?.designSessionId ??
			undefined,
	);
	/** This conversation's design-build progress: the stage, the reviewed
	 *  design outline, and which planned workflows have committed. One store
	 *  per mounted conversation, fed only by the durable frames the run
	 *  streams (plus the page-load seed below), reset on every thread swap. */
	const [designProgressStore] = useState(() => {
		const store = createDesignProgressStore();
		if (initialDesignSession)
			store.getState().seedSession(initialDesignSession);
		return store;
	});
	const designProgress = useDesignProgressView(designProgressStore);
	/** Whether the SSE transport was open on the previous render, used
	 *  to detect `ready`→`streaming` and `streaming`→`ready` transitions
	 *  for the `beginRun` / `endRun` handoff. Local to this component so
	 *  the session store never has to mirror the transport status as a
	 *  shadow field. Initial false matches the SDK's initial `status:
	 *  "ready"` so the very first render is a no-op. */
	const prevStreamOpenRef = useRef(false);
	const threadHydrationStateRef = useRef<"ready" | "pending" | "failed">(
		"ready",
	);

	// ── Threads ──────────────────────────────────────────────────────────

	/** The thread list: seeded by the RSC page, refreshed after each run. */
	const [threadMetas, setThreadMetas] = useState<ThreadMeta[]>(threads ?? []);
	/** The open thread's chat id awaiting a `resumeStream()`: set when a
	 *  hydrated thread has a run in flight, consumed once by the resume
	 *  effect below. */
	const pendingResumeRef = useRef<string | null>(
		initialThread?.active_stream_id ? initialThread.thread_id : null,
	);
	/** One-shot: the next `beginRun` belongs to a reconnected (live resume) or
	 *  RE-DRIVEN (instance death) BUILD run, so its build-vs-edit capture must
	 *  preserve "started as a build" even though canonical genesis means
	 *  committed modules are already in the loaded doc. Without the redrive
	 *  arm, a re-driven build would capture `runStartedWithData: true` off the
	 *  committed doc and render edit-mode chrome for the whole run. This
	 *  mount-time seed computes `(live || redrive) && unfinished-build` from
	 *  the page-frozen `appGenerating` prop, which equals the session store's
	 *  latch seed and is safe exactly here: no run can have moved the latch
	 *  before first render. Every later re-seed instead adopts
	 *  `opts.buildResume` inside `activateThread` (below), which callers
	 *  build via `authoritativeThreadActivationOptions` on the LIVE latch. */
	const pendingBuildResumeRef = useRef(
		(initialThread?.active_stream_id != null ||
			initialThread?.resume_interrupted === true) &&
			!!appGenerating,
	);
	/** Set to the resuming Chat's id when `resumeStream()` fires; consumed on
	 *  stream close to heal the refresh-races-finalize gap (see the status
	 *  effect below). */
	const resumeHealRef = useRef<string | null>(null);
	/** The open thread's chat id awaiting an instance-death RE-DRIVE, set
	 *  when a loader detected the thread's dead stream marker
	 *  (`resume_interrupted`) and the transcript's ask posture allows an
	 *  automatic re-run (`shouldAutoRedrive`), consumed once per activation
	 *  by the re-drive effect below. Mutually exclusive with a pending
	 *  resume (a dead marker's projection strips `active_stream_id`). */
	const pendingRedriveRef = useRef<string | null>(
		initialThread && shouldAutoRedrive(initialThread)
			? initialThread.thread_id
			: null,
	);
	/** One-shot per activation: healAfterResume may itself detect the dead
	 *  marker (its refetch runs after a resume/re-drive closed unanswered) and
	 *  trigger ONE more re-drive: this latch keeps a re-drive that keeps
	 *  failing pre-stream from ping-ponging with the heal into a retry loop.
	 *  The level-triggered server signal already retries on the NEXT load. */
	const healRedroveRef = useRef<string | null>(null);

	// ── From-scratch escape hatch (new builds only) ──────────────────────

	/* The two ways out of `/build/new` are mutually exclusive, and whichever
	 * the user picks first wins: latched synchronously, in the handler that
	 * starts it. Refs, not state: `StartFromScratch` stays clickable all the way
	 * through its collapse (deliberately: it must not flash disabled mid-fade),
	 * so a click landing in that window has to meet a latch that was already set
	 * when the message was sent, rather than wait on a re-render. */
	const [creatingStarterApp, setCreatingStarterApp] = useState(false);
	const agentEngagedRef = useRef(false);
	const creatingStarterAppRef = useRef(false);
	/** Set when a send failed before any app was minted: see the `chatError`
	 *  effect. Un-collapses the starter so the user isn't left with neither path. */
	const [sendFailedBeforeApp, setSendFailedBeforeApp] = useState(false);
	/** `createStarterApp` resolves against stores and a global toast that don't
	 *  unmount with us. Without this, abandoning a slow create (Back, or the
	 *  header logo) installs the new app into a screen the user has left, or
	 *  toasts a create failure onto a page that never had the button.
	 *  Re-armed in the effect body, not just the cleanup, so a StrictMode
	 *  mount→unmount→mount doesn't leave it stuck false. */
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// ── Chat instance: recreated on session change or thread switch ──────

	/** The ONE thread-activation path: stamp the per-thread refs (run id for
	 *  free-continuation resumes, the pending resume + build-capture
	 *  one-shots) and build the Chat instance those refs feed. Every way a
	 *  conversation becomes active: mount, session change, thread switch,
	 *  New chat: goes through here so the refs can't drift out of step. */
	const activateThread = useCallback(
		(
			init: ActiveThreadInit,
			opts?: {
				runId?: string;
				holderNonce?: string;
				resume?: boolean;
				buildResume?: boolean;
				redrive?: boolean;
				designSessionId?: string | null;
			},
		): Chat<NovaUIMessage> => {
			runIdRef.current = opts?.runId;
			holderNonceRef.current = opts?.holderNonce;
			designSessionIdRef.current = opts?.designSessionId ?? undefined;
			pendingResumeRef.current = opts?.resume ? init.threadId : null;
			pendingRedriveRef.current = opts?.redrive ? init.threadId : null;
			pendingBuildResumeRef.current = !!opts?.buildResume;
			/* A different conversation is a different design: its stage, outline,
			 * and slice progress belong to the run that streamed them. The next
			 * turn's `data-design-session` frame re-opens the scope. */
			designProgressStore.getState().reset();
			return createChatInstance(
				init,
				docStoreRef,
				sessionStoreRef,
				runIdRef,
				holderNonceRef,
				designSessionIdRef,
				designProgressStore,
				reconcilerCtxRef,
				ownUserIdRef,
				autoResendFatalStrikesRef,
				threadHydrationStateRef,
				projectToast,
				scopeEpoch,
			);
		},
		[designProgressStore, projectToast, scopeEpoch],
	);

	/* The session store is recreated inside `BuilderSessionProvider` on every
	 * buildId change (the parent `BuilderProvider` keys on buildId, unmounting
	 * and remounting all children). Its reference is the canonical per-app
	 * identity. Clear stale local state from the previous app: run ID and
	 * the Chat instance. (The mount initializer reads the refs the component
	 * seeded above rather than restamping them.) */
	const prevSessionRef = useRef(sessionApi);
	const [chat, setChat] = useState(() =>
		createChatInstance(
			{
				threadId: initialThread?.thread_id ?? crypto.randomUUID(),
				messages: (initialThread?.messages ?? []) as NovaUIMessage[],
			},
			docStoreRef,
			sessionStoreRef,
			runIdRef,
			holderNonceRef,
			designSessionIdRef,
			designProgressStore,
			reconcilerCtxRef,
			ownUserIdRef,
			autoResendFatalStrikesRef,
			threadHydrationStateRef,
			projectToast,
			scopeEpoch,
		),
	);

	if (sessionApi !== prevSessionRef.current) {
		prevSessionRef.current = sessionApi;
		setChat(activateThread({ threadId: crypto.randomUUID(), messages: [] }));
	}

	// ── Chat hook: the core reason this component exists ─────────────────
	// useChat produces React state (messages, status) that changes on every
	// streamed token. By calling it HERE instead of in BuilderLayout, those
	// per-token re-renders only affect ChatSidebar, not the entire app.
	const {
		messages,
		sendMessage,
		addToolOutput,
		setMessages,
		status,
		error: chatError,
		stop,
		resumeStream,
		regenerate,
	} = useChat({ chat });
	const stopRef = useRef(stop);
	stopRef.current = stop;
	const messagesRef = useRef(messages);
	messagesRef.current = messages;

	/* A blocking question round parks the run (§15.8), and the transcript is
	 * the only place that pause is visible from here: the stream closes and an
	 * unanswered card is left standing. Report it so the progress region stops
	 * claiming work is moving while it waits on a person. */
	useEffect(() => {
		const streamOpen = status === "submitted" || status === "streaming";
		const store = designProgressStore.getState();
		if (streamOpen) store.noteTurnOpened();
		store.setAwaitingInput(
			!streamOpen && trailingAskPosture(messages) === "awaiting-input",
		);
	}, [designProgressStore, messages, status]);
	const chatRef = useRef(chat);
	chatRef.current = chat;
	const activeThreadReadsRef = useRef(new Set<AbortController>());
	const pendingProjectThreadReloadRef = useRef<{
		epoch: number;
		threadId: string;
		retainedMessages: NovaUIMessage[];
	} | null>(null);
	const [threadScopeReloading, setThreadScopeReloading] = useState(false);
	const [threadScopeHydrationFailed, setThreadScopeHydrationFailed] =
		useState(false);
	useEffect(
		() => () => {
			for (const controller of activeThreadReadsRef.current) controller.abort();
			activeThreadReadsRef.current.clear();
		},
		[],
	);

	/* A same-app Project move keeps this component mounted. Retire attachment
	 * refs (ids + filenames + extracts) and every in-flight transcript read in
	 * the synchronous reset stack; app-owned text may remain as a masked bridge
	 * until the destination-authorized thread reload lands. */
	useEffect(() => {
		if (!reconcilerCtx) return;
		return reconcilerCtx.subscribeProjectScopeReset((nextEpoch) => {
			for (const controller of activeThreadReadsRef.current) controller.abort();
			activeThreadReadsRef.current.clear();
			const retired = retireProjectAttachmentRefs(messagesRef.current);
			void stopRef.current?.();
			if (prevStreamOpenRef.current) {
				/* `resetProjectScope` already removed the source event payload. Pair
				 * the transport's open run bracket before suppressing the later status
				 * edge, so destination edits do not remain undo-paused. */
				sessionStoreRef.current?.getState().endRun();
			}
			prevStreamOpenRef.current = false;
			pendingResumeRef.current = null;
			pendingRedriveRef.current = null;
			resumeHealRef.current = null;
			pendingProjectThreadReloadRef.current = {
				epoch: nextEpoch,
				threadId: chatRef.current.id,
				retainedMessages: retired,
			};
			threadHydrationStateRef.current = "pending";
			/* `useChat` owns both the rendered projection and Chat's retained send
			 * history. Flush the stripped projection before the reset returns so an
			 * exit frame cannot retain a source asset id or filename. */
			flushSync(() => {
				setMessages(retired);
				setThreadScopeHydrationFailed(false);
				setThreadScopeReloading(true);
			});
		});
	}, [reconcilerCtx, setMessages]);

	/* Once destination view authority is established, replace the masked bridge
	 * with the authoritative stored thread. S02c3 remaps any attachment ids in
	 * that server row as part of the Project move; this client never guesses. An
	 * optimistic trailing user-text suffix absent from that read is the sole
	 * exception: preserve its app-owned text without any source metadata. */
	useEffect(() => {
		const pending = pendingProjectThreadReloadRef.current;
		if (
			accessPhase !== "authorized" ||
			!pending ||
			pending.epoch !== scopeEpoch
		)
			return;
		const session = sessionStoreRef.current?.getState();
		if (
			session?.accessPhase !== "authorized" ||
			session.scopeEpoch !== pending.epoch
		)
			return;
		const appId = session.appId;
		if (!appId) {
			pendingProjectThreadReloadRef.current = null;
			setChat(
				activateThread({
					threadId: pending.threadId,
					messages: pending.retainedMessages,
				}),
			);
			setThreadScopeReloading(false);
			setThreadScopeHydrationFailed(false);
			threadHydrationStateRef.current = "ready";
			return;
		}
		/* Re-own the safe bridge before authorized controls can dispatch. Keep the
		 * composer/tool answers disabled until the authoritative fetch settles so
		 * it cannot overwrite a turn sent into this temporary instance. */
		setChat(
			activateThread({
				threadId: pending.threadId,
				messages: pending.retainedMessages,
			}),
		);
		const controller = new AbortController();
		activeThreadReadsRef.current.add(controller);
		const ownsRead = () => {
			const current = sessionStoreRef.current?.getState();
			return (
				!controller.signal.aborted &&
				current?.accessPhase === "authorized" &&
				current.scopeEpoch === pending.epoch &&
				current.appId === appId
			);
		};
		void fetch(
			`/api/apps/${appId}/threads/${encodeURIComponent(pending.threadId)}`,
			{ cache: "no-store", signal: controller.signal },
		)
			.then(async (res) => {
				if (!ownsRead()) return;
				if (res.status === 404) {
					pendingProjectThreadReloadRef.current = null;
					setChat(
						activateThread({
							threadId: pending.threadId,
							messages: pending.retainedMessages,
						}),
					);
					setThreadScopeReloading(false);
					setThreadScopeHydrationFailed(false);
					threadHydrationStateRef.current = "ready";
					return;
				}
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const { thread } = (await res.json()) as { thread: LoadedThreadDoc };
				if (!ownsRead()) return;
				pendingProjectThreadReloadRef.current = null;
				setChat(
					activateThread(
						{
							threadId: thread.thread_id,
							messages: mergeRetainedUserTextSuffix(
								thread.messages as NovaUIMessage[],
								pending.retainedMessages,
							),
						},
						authoritativeThreadActivationOptions(thread, liveBuildUnfinished()),
					),
				);
				setThreadScopeReloading(false);
				setThreadScopeHydrationFailed(false);
				threadHydrationStateRef.current = "ready";
			})
			.catch(() => {
				if (!ownsRead()) return;
				/* Do not leave the old-epoch Chat active behind an authorized UI when
				 * the destination read itself failed. Re-own the attachment-free bridge
				 * for rendering under this epoch while its callbacks remain blocked; a
				 * page reload (or a later Project-scope refresh) retries the authoritative
				 * transcript. */
				pendingProjectThreadReloadRef.current = null;
				setChat(
					activateThread({
						threadId: pending.threadId,
						messages: pending.retainedMessages,
					}),
				);
				/* A same-id bridge is safe to display, but never safe to submit: the
				 * server's equal-part-count merge can prefer this stripped message and
				 * permanently erase S02c3's remapped attachment metadata. Stay blocked
				 * until a full page reload can hydrate the authoritative transcript. */
				threadHydrationStateRef.current = "failed";
				setThreadScopeHydrationFailed(true);
				projectToast(
					"warning",
					"Reload to restore this conversation",
					"Nova couldn't verify this conversation's files, so sending stays paused to protect them.",
					{
						persistent: true,
						action: {
							label: "Reload page",
							onPress: () => window.location.reload(),
						},
					},
				);
			})
			.finally(() => activeThreadReadsRef.current.delete(controller));
		return () => {
			controller.abort();
			activeThreadReadsRef.current.delete(controller);
		};
	}, [
		accessPhase,
		scopeEpoch,
		activateThread,
		projectToast,
		liveBuildUnfinished,
	]);

	// ── Live-run resume ───────────────────────────────────────────────────
	/* A hydrated thread with a run in flight reconnects HERE: `resumeStream`
	 * asks the transport to `reconnectToStream({chatId})`: the thread id:
	 * and the endpoint replays the live stream from its first chunk, then
	 * tails it. From the user's side a refresh mid-run changes nothing: the
	 * response keeps streaming. A thread whose run finished between the page
	 * load and this effect answers a bare `finish` (a clean no-op). */
	useEffect(() => {
		if (pendingResumeRef.current !== chat.id) return;
		pendingResumeRef.current = null;
		resumeHealRef.current = chat.id;
		resumeStream();
	}, [chat, resumeStream]);

	/* The instance-death RE-DRIVE. A loader that healed this thread's dead
	 * stream marker proved a run claimed the turn and died mid-answer (a
	 * deploy kill, an OOM: the reaper already refunded it). Re-run the turn
	 * through the normal POST/claim/charge machinery so, from the user's
	 * side, the response simply arrives. `regenerate()` trims a trailing
	 * assistant message from the SENT history. Under barrier persistence
	 * that is the dead run's PARTIAL, which the re-drive's claim also removes
	 * from the stored record (a partial is never the turn's answer; the
	 * fresh run's response is). The shapes that must NOT be trimmed never
	 * arm this ref: `shouldAutoRedrive` excludes an answered ask round
	 * (whose trailing message holds the user's answers) and a genuinely
	 * paused one. The one-shot ref can't loop: a re-driven run that fails
	 * again finalizes cleanly, so no future load sees another heal. The heal
	 * ref covers the lost-race close (another session's re-drive won the
	 * claim): this send bails clean, the refetch attaches to the winner. */
	useEffect(() => {
		if (pendingRedriveRef.current !== chat.id) return;
		pendingRedriveRef.current = null;
		resumeHealRef.current = chat.id;
		void regenerate();
	}, [chat, regenerate]);

	/* The post-resume heal: ONE authoritative refetch per activation, fired
	 * whenever a resume or re-drive closes. Under barrier persistence the
	 * transcript's shape can't decide whether healing is needed (every
	 * persisted part is in a closed state, so a dead run's partial answer is
	 * indistinguishable from a finished one by looking), so the close itself
	 * is the trigger and the refetched server stamps
	 * (`resume_interrupted` / `run_paused` / a live marker) drive what
	 * happens next. This is also the bound on a barrier write that lagged or
	 * failed behind the chunk log: the refetch adopts whatever the thread
	 * row now holds. */
	const healAfterResume = useCallback(async () => {
		const start = sessionStoreRef.current?.getState();
		if (!start?.appId || start.accessPhase !== "authorized") return;
		const appId = start.appId;
		const readEpoch = start.scopeEpoch;
		const controller = new AbortController();
		activeThreadReadsRef.current.add(controller);
		const ownsRead = () => {
			const current = sessionStoreRef.current?.getState();
			return (
				!controller.signal.aborted &&
				current?.accessPhase === "authorized" &&
				current.scopeEpoch === readEpoch &&
				current.appId === appId
			);
		};
		try {
			const res = await fetch(
				`/api/apps/${appId}/threads/${encodeURIComponent(chat.id)}`,
				{ cache: "no-store", signal: controller.signal },
			);
			if (!res.ok || !ownsRead()) return;
			const { thread } = (await res.json()) as { thread: LoadedThreadDoc };
			if (!ownsRead()) return;
			/* A LIVE marker here means another session's run owns this thread
			 * right now: the shape a lost re-drive race leaves behind (this
			 * send bailed clean while the winner streams). Attach to it: swap in
			 * the fetched transcript and resume the winner's stream by thread
			 * id, exactly as a page load over a live run would. Adoption keeps a
			 * richer LOCAL assistant copy here too: the stored row can lag an
			 * answer this client already rendered in full (a lost terminal
			 * write), and the winner's stream replays its own turn, never the
			 * older one's missing tail. */
			if (thread.active_stream_id != null) {
				setChat(
					activateThread(
						{
							threadId: thread.thread_id,
							messages: adoptTranscriptKeepingRicherLocal(
								thread.messages as NovaUIMessage[],
								messagesRef.current,
							),
						},
						authoritativeThreadActivationOptions(thread, liveBuildUnfinished()),
					),
				);
				return;
			}
			/* The refetch DETECTED a dead marker: the run this heal followed
			 * died without answering (the resume attached to a stream that was
			 * never finalized, or the re-drive itself was killed). Re-drive it
			 * exactly as openThread would: once per activation
			 * (`healRedroveRef`); if that re-drive dies too, the next page load
			 * sees the level-triggered signal and tries again. */
			if (
				thread.resume_interrupted === true &&
				healRedroveRef.current !== chat.id
			) {
				healRedroveRef.current = chat.id;
				setChat(
					activateThread(
						{
							threadId: thread.thread_id,
							messages: thread.messages as NovaUIMessage[],
						},
						authoritativeThreadActivationOptions(thread, liveBuildUnfinished()),
					),
				);
				return;
			}
			/* Even a terminal/empty projection authoritatively clears run-holder
			 * capability. Keep a local optimistic transcript when the server has no
			 * messages, but re-own it through the same activation seam. With no
			 * live stream left to re-deliver anything, adoption must not
			 * DOWNGRADE the view: a shared assistant message keeps the richer
			 * local copy (`adoptTranscriptKeepingRicherLocal`) when the stored
			 * row lags what this client already rendered. */
			setChat(
				activateThread(
					{
						threadId: thread.thread_id,
						messages:
							thread.messages.length > 0
								? adoptTranscriptKeepingRicherLocal(
										thread.messages as NovaUIMessage[],
										messagesRef.current,
									)
								: messagesRef.current,
					},
					authoritativeThreadActivationOptions(thread, liveBuildUnfinished(), {
						allowRedrive: false,
					}),
				),
			);
		} catch {
			/* Best-effort: the conversation still works; the response shows on
			 * the next open. */
		} finally {
			activeThreadReadsRef.current.delete(controller);
		}
	}, [chat, activateThread, liveBuildUnfinished]);

	// ── Thread switching ──────────────────────────────────────────────────

	const openThread = useCallback(
		async (threadId: string): Promise<boolean> => {
			if (threadHydrationStateRef.current !== "ready") return false;
			if (threadId === chat.id) return true;
			const start = sessionStoreRef.current?.getState();
			if (!start?.appId || start.accessPhase !== "authorized") return false;
			const appId = start.appId;
			const readEpoch = start.scopeEpoch;
			const controller = new AbortController();
			activeThreadReadsRef.current.add(controller);
			const ownsRead = () => {
				const current = sessionStoreRef.current?.getState();
				return (
					!controller.signal.aborted &&
					current?.accessPhase === "authorized" &&
					current.scopeEpoch === readEpoch &&
					current.appId === appId
				);
			};
			let thread: LoadedThreadDoc;
			try {
				const res = await fetch(
					`/api/apps/${appId}/threads/${encodeURIComponent(threadId)}`,
					{ cache: "no-store", signal: controller.signal },
				);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				({ thread } = (await res.json()) as { thread: LoadedThreadDoc });
				if (!ownsRead()) return false;
			} catch {
				if (!ownsRead()) return false;
				projectToast(
					"error",
					"Couldn't open the conversation",
					"Check your connection and try again.",
				);
				return false;
			} finally {
				activeThreadReadsRef.current.delete(controller);
			}
			/* Abort the current thread's client-side stream read (the run, if
			 * any: continues server-side and stays resumable from its row). */
			stopRef.current?.();
			setChat(
				activateThread(
					{
						threadId: thread.thread_id,
						messages: thread.messages as NovaUIMessage[],
					},
					authoritativeThreadActivationOptions(
						thread,
						/* The live unfinished-build signal (not thread_type, which
						 * freezes at creation): an edit run resumed in the app's
						 * original build-typed thread must keep the edit-mode
						 * capture. */
						liveBuildUnfinished(),
					),
				),
			);
			return true;
		},
		[chat, activateThread, projectToast, liveBuildUnfinished],
	);

	const startNewChat = useCallback(() => {
		if (threadHydrationStateRef.current !== "ready") return;
		if (messages.length === 0) return; // already a fresh conversation
		stopRef.current?.();
		setChat(activateThread({ threadId: crypto.randomUUID(), messages: [] }));
	}, [messages.length, activateThread]);

	// ── Chat effects ─────────────────────────────────────────────────────

	/* Drive run boundaries from chat-transport status. `submitted` +
	 * `streaming` mean the SSE stream is open. On the first transition
	 * into either, `beginRun` clears the events buffer + runCompletedAt
	 * and pauses doc undo. On the transition back to `ready`, `endRun`
	 * clears the events buffer and resumes doc undo.
	 *
	 * Transition detection uses a local ref: the session store has no
	 * `agentActive` field to read from. The buffer is the "a run is in
	 * progress" signal (non-empty between beginRun and endRun); we just
	 * need to know WHEN to flip it, which is the status edge.
	 *
	 * `endRun` is a pure stream-close: whether the run was "completed"
	 * in the celebration sense is decided by the dispatcher's
	 * `data-done` handler via `markRunCompleted()`. So askQuestions
	 * runs, clarifying text, and edit-tool responses close silently
	 * without any animation. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeEpoch intentionally re-runs the owner gate at the synchronous Project boundary
	useEffect(() => {
		if (!sessionApi) return;
		if (
			!chatCallbackCanPublish(
				sessionApi.getState(),
				chatOwnerEpochs.get(chat) ?? -1,
				threadHydrationStateRef.current,
			)
		)
			return;
		const streamOpen = status === "submitted" || status === "streaming";
		const wasOpen = prevStreamOpenRef.current;
		prevStreamOpenRef.current = streamOpen;
		if (streamOpen && !wasOpen) {
			/* A reconnected BUILD run must not read the already-committed
			 * modules as pre-existing data: consume the one-shot override. */
			const startedWithData = pendingBuildResumeRef.current ? false : undefined;
			pendingBuildResumeRef.current = false;
			sessionApi
				.getState()
				.beginRun(
					startedWithData === undefined ? undefined : { startedWithData },
				);
		} else if (!streamOpen && wasOpen) {
			sessionApi.getState().endRun();
			/* The run is over: clear the reconciler's active run id. Every batch
			 * the run committed is registered (`batchId ∈ awaitingEcho` covers its
			 * late echoes), so the runId fallback is no longer needed, and leaving
			 * it set would misclassify a LATER same-user frame that carries the
			 * same run id (MCP's deriveRunId continues the app's stored run_id
			 * inside a sliding window) as a self-echo, skipping its apply/rebase. */
			reconcilerCtxRef.current?.reconciler.setSelfActiveRunId(undefined);
			// A fresh build mounts with undo paused (it generates first). When the
			// run ends the app is live/editable, so release the store's one-time
			// birth pause: this is what makes undo work after a build without a
			// page reload. Idempotent: a no-op once tracking is already live, so
			// calling it on every run-end is safe.
			docStoreRef.current?.getState().startTracking();
			/* A closed resume/re-drive always refetches the thread once: the
			 * transcript's shape can't say whether this close delivered
			 * everything (see `healAfterResume`), so the server's stamps
			 * decide. */
			if (resumeHealRef.current === chat.id) {
				resumeHealRef.current = null;
				void healAfterResume();
			}
		}
	}, [status, sessionApi, chat, healAfterResume, scopeEpoch]);

	/* Surface stream-level failures (network drops, spend cap, auth,
	 * server crashes) that never got a chance to produce a
	 * server-side conversation error event. Synthesize one client-side
	 * and push it onto the buffer: the lifecycle derivation then picks
	 * it up identically to a server-emitted error. Toast is fired here
	 * because the synthetic event doesn't flow through the dispatcher's
	 * conversation-event handler. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeEpoch intentionally re-runs the owner gate at the synchronous Project boundary
	useEffect(() => {
		if (!chatError || !sessionApi) return;
		const message = parseApiErrorMessage(chatError.message);
		const session = sessionApi.getState();
		if (
			!chatCallbackCanPublish(
				session,
				chatOwnerEpochs.get(chat) ?? -1,
				threadHydrationStateRef.current,
			)
		)
			return;
		const runId = runIdRef.current ?? "client-error";
		session.pushEvent({
			kind: "conversation",
			runId,
			ts: Date.now(),
			/* Synthetic client-side events use `Number.MAX_SAFE_INTEGER`
			 * as a sentinel `seq` so they can't collide with server-
			 * issued seq numbers (which are monotonic from 0). This
			 * event is client-only and never persisted to the log; the
			 * sentinel makes "injected, not from the wire" obvious to
			 * any future log-ordering code. */
			seq: Number.MAX_SAFE_INTEGER,
			/* The chat route is the only surface that can produce this
			 * synthetic event (client-side network-failure fallback on a
			 * chat call), so `source: "chat"` is correct. Not persisted:
			 * the schema just requires the field be present. */
			source: "chat",
			payload: {
				type: "error",
				error: { type: "network", message, fatal: true },
			},
		});
		projectToast("error", "Generation failed", message);

		/* A pre-stream rejection (out of credits, a build already running in
		 * another tab, a 5xx) fails before the route mints an app, leaving the
		 * user on `/build/new` with nothing. Re-arm the from-scratch path they were
		 * offered a moment ago: the send had latched it shut, and without this
		 * the only ways out are a reload or navigating away. A failure that got
		 * far enough to materialize an app already announced it via
		 * `data-app-materialized`, so `appId` is set and the escape hatch
		 * correctly stays closed. */
		if (!session.appId) {
			agentEngagedRef.current = false;
			setSendFailedBeforeApp(true);
		}
	}, [chat, chatError, projectToast, scopeEpoch, sessionApi]);

	/* Refresh the thread list after each run settles. The server is the
	 * writer (the route persists the turn at claim and the response at
	 * finalize), so a re-read is the one honest way to reflect it, it also
	 * picks up threads co-editors created since the page loaded. Best-effort:
	 * a failed read keeps the current list. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is a fire-time guard, not a trigger; sessionApi read at fire time
	useEffect(() => {
		if (status !== "ready" || messages.length === 0) return;
		const appId = sessionStoreRef.current?.getState().appId;
		if (!appId) return;
		const start = sessionStoreRef.current?.getState();
		if (start?.accessPhase !== "authorized") return;
		const readEpoch = start.scopeEpoch;
		const controller = new AbortController();
		activeThreadReadsRef.current.add(controller);
		const ownsRead = () => {
			const current = sessionStoreRef.current?.getState();
			return (
				!controller.signal.aborted &&
				current?.accessPhase === "authorized" &&
				current.scopeEpoch === readEpoch &&
				current.appId === appId
			);
		};
		fetch(`/api/apps/${appId}/threads`, {
			cache: "no-store",
			signal: controller.signal,
		})
			.then(async (res) => {
				if (!res.ok || !ownsRead()) return;
				const { threads: fresh } = (await res.json()) as {
					threads: ThreadMeta[];
				};
				if (ownsRead()) setThreadMetas(fresh);
			})
			.catch(() => {})
			.finally(() => activeThreadReadsRef.current.delete(controller));
		return () => {
			controller.abort();
			activeThreadReadsRef.current.delete(controller);
		};
	}, [status]);

	const handleSend = useCallback(
		({
			text,
			attachments,
		}: {
			text: string;
			attachments?: AttachmentRef[];
		}) => {
			if (creatingStarterAppRef.current) return;
			if (threadHydrationStateRef.current !== "ready") return;
			const session = sessionStoreRef.current?.getState();
			if (
				session?.accessPhase !== "authorized" ||
				!session.canEdit ||
				session.scopeEpoch !== scopeEpoch
			)
				return;
			if (!text.trim() && !attachments?.length) return;
			agentEngagedRef.current = true;
			setSendFailedBeforeApp(false);
			/* A typed message is an explicit fresh attempt: clear the fatal
			 * strikes so an earlier halted round can't bleed into this one. */
			autoResendFatalStrikesRef.current = 0;
			// Attachments ride as asset-id refs in message METADATA, not file parts.
			// The route's resolveAttachments expands each ref into the stored extract
			// (documents) or image bytes (vision) before the SA. A turn with no
			// attachments sends plain text, with no metadata, exactly as before.
			sendMessage({
				text,
				metadata: attachments?.length ? { attachments } : undefined,
			});
		},
		[scopeEpoch, sendMessage],
	);

	const handleToolOutput = useCallback(
		(params: { tool: string; toolCallId: string; output: unknown }) => {
			if (threadHydrationStateRef.current !== "ready") return;
			const session = sessionStoreRef.current?.getState();
			if (
				session?.accessPhase !== "authorized" ||
				!session.canEdit ||
				session.scopeEpoch !== scopeEpoch
			)
				return;
			/* A fresh answer is the user asking to try again: clear the fatal
			 * strikes BEFORE the SDK's post-output auto-resend evaluation runs,
			 * so re-answering a failed round works without a reload while the
			 * strike cap still stops unattended loops. */
			autoResendFatalStrikesRef.current = 0;
			addToolOutput(params);
		},
		[addToolOutput, scopeEpoch],
	);

	const handleCreateStarterApp = useCallback(() => {
		if (agentEngagedRef.current || creatingStarterAppRef.current) return;
		const session = sessionStoreRef.current?.getState();
		if (
			session?.accessPhase !== "authorized" ||
			!session.canEdit ||
			!session.projectId ||
			session.scopeEpoch !== scopeEpoch
		)
			return;
		const expectedProjectId = session.projectId;
		creatingStarterAppRef.current = true;
		setCreatingStarterApp(true);
		createStarterApp(expectedProjectId).then(
			(result) => {
				/* The app was created either way; we just no longer own the screen. */
				if (!mountedRef.current) return;
				const release = () => {
					creatingStarterAppRef.current = false;
					setCreatingStarterApp(false);
				};
				if (!result.success) {
					release();
					projectToast("error", "Couldn't create the app", result.error);
					return;
				}
				/* Same strict boundary the SA's creation frame passes through, for
				 * the same reason: identity, capability, blueprint, and cursor are
				 * one authority, and multiplayer must never be activated from a
				 * partial one. */
				const activation = parseAppMaterializationReceipt(
					result.receipt as unknown as Record<string, unknown>,
				);
				const docApi = docStoreRef.current;
				const sessionApi = sessionStoreRef.current;
				const current = sessionApi?.getState();
				if (
					activation === null ||
					!docApi ||
					!sessionApi ||
					current === undefined ||
					current.scopeEpoch !== scopeEpoch ||
					current.projectId !== activation.projectId
				) {
					release();
					projectToast(
						"error",
						"Reload to finish opening this app",
						"Nova created your app, but couldn't verify its Project scope in this tab. It's waiting in your app list.",
						{
							persistent: true,
							action: {
								label: "Reload page",
								onPress: () => window.location.reload(),
							},
						},
					);
					return;
				}
				/* No navigation: this installs the app the client was just handed,
				 * in the tree that is already mounted. The blueprint arriving is
				 * what carries the builder out of its centered new-build state, so
				 * release the latches only after it lands. */
				installCreatedApp(
					activation,
					docApi,
					sessionApi,
					reconcilerCtxRef.current,
				);
				verifyActivationDigest(activation, projectToast);
				release();
			},
			/* The action itself never rejects: it returns its failures. Landing
			 * here means the Server Action CALL didn't complete (offline, a deploy
			 * mid-flight), so there's nothing to unwrap, and, since the write may
			 * well have landed before the response was lost, no way to know whether
			 * an app exists. `createApp` takes no idempotency key, so a blind retry
			 * can mint a second one; say so rather than inviting it. */
			() => {
				if (!mountedRef.current) return;
				creatingStarterAppRef.current = false;
				setCreatingStarterApp(false);
				projectToast(
					"error",
					"Couldn't confirm the app was created",
					"Check your connection, then look in your app list before trying again. The app may already be there.",
				);
			},
		);
	}, [projectToast, scopeEpoch]);

	// ── Derived values ───────────────────────────────────────────────────

	/* Viewers (view-only Project members) get a read-only conversation, the
	 * composer hides. */
	const readOnly = !canEdit;

	/* The SA is in play the moment a message exists: `useChat` appends the
	 * user's turn optimistically, so this flips on the same tick as the send.
	 * Staging or extracting a document does NOT flip it: extraction lives on
	 * the composer (`onReadingChange`), never on `messages`. A send that never
	 * reached a run gives the escape hatch back. */
	const agentEngaged = messages.length > 0 && !sendFailedBeforeApp;

	/* Only on a brand-new build, and only where the composer itself is offered:
	 * a surface that can't send can't create either. `/build/new` is seeded
	 * from the active Project's server-resolved role, so a viewer never sees this
	 * authoring action; the create route remains the enforcement authority. */
	const showFromScratch = centered && !isExistingApp && !readOnly;

	return (
		<ChatSidebar
			key="chat"
			centered={centered}
			startFromScratch={
				showFromScratch ? (
					<StartFromScratch
						agentEngaged={agentEngaged}
						creating={creatingStarterApp}
						onCreate={handleCreateStarterApp}
					/>
				) : undefined
			}
			composerBusy={creatingStarterApp || threadScopeReloading}
			interactionBlocked={threadScopeReloading}
			interactionBlockedRecovery={
				threadScopeHydrationFailed
					? {
							title: "Conversation paused",
							message:
								"Reload Nova to verify this conversation's files before sending.",
							actionLabel: "Reload page",
							onAction: () => window.location.reload(),
						}
					: undefined
			}
			messages={messages}
			status={status}
			onSend={handleSend}
			addToolOutput={handleToolOutput}
			readOnly={readOnly}
			readOnlyNotice={
				!canEdit
					? isExistingApp
						? "You have view-only access to this app. Ask a Project admin for edit access to make changes."
						: "You have view-only access to this Project. Ask a Project admin for edit access to create an app."
					: undefined
			}
			threads={threadMetas}
			activeThreadId={chat.id}
			onSelectThread={openThread}
			onNewChat={startNewChat}
			designProgressDetails={
				designProgress.active ? (
					<DesignProgressDetails view={designProgress} />
				) : undefined
			}
			designProgressStatus={
				designProgress.active && !designProgress.materialized ? (
					<DesignProgressStatus view={designProgress} />
				) : undefined
			}
			/* Only while the app does not exist yet: from materialization on,
			 * the builder's own activity row describes the run and this region
			 * is one quiet sentence per committed workflow. */
			activityStatusHidden={
				designProgress.active && !designProgress.materialized
			}
		/>
	);
}
