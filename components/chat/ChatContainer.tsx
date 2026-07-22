/**
 * ChatContainer — owns all chat lifecycle state (useChat, Chat instance,
 * stream effects) so that chat message changes ONLY re-render this subtree,
 * never BuilderLayout or the preview/structure panels.
 *
 * This is the key architectural boundary: useChat produces React state
 * (messages, status) that changes on every streamed token. By isolating
 * useChat here instead of in BuilderLayout, those per-token re-renders
 * are scoped to ChatSidebar — the only component that needs messages.
 *
 * THREADS. A conversation is a durable thread (`threads` row, server-written
 * by the chat route). This component owns which thread is open:
 *
 *  - The page loads with the most recently active thread hydrated
 *    (`initialThread`) — a refresh always lands back in the conversation the
 *    user was in, with its full transcript in `useChat`.
 *  - The Chat instance's id IS the thread id, and a thread that has a run in
 *    flight (`active_stream_id`) is resumed on mount via `resumeStream()`:
 *    the transport reconnects by thread id and replays the live stream, so a
 *    refresh mid-run looks like nothing happened.
 *  - A thread whose run DIED mid-flight (instance kill — the loader detected
 *    a dead live-stream marker and stamped `resume_interrupted`) is
 *    RE-DRIVEN on open: `regenerate()` re-runs the unanswered turn through
 *    the normal POST/claim/charge machinery, so from the user's side the
 *    response simply arrives. The stamp is LEVEL-TRIGGERED — the loaders
 *    never clear the marker, so the signal stands across loads until a
 *    re-drive's own run retires it (a re-drive that dies is detected again;
 *    one that loses the race bails clean and attaches to the winner).
 *  - Switching threads (or "New chat") swaps the Chat instance; sending in
 *    any thread just continues it — the full history rides every POST.
 */
"use client";
import { Chat, useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import type { UIMessage } from "ai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createBlankApp } from "@/app/(app)/build/actions";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { StartBlankApp } from "@/components/chat/StartBlankApp";
import { Logo } from "@/components/ui/Logo";
import { parseApiErrorMessage } from "@/lib/apiError";
import {
	type AttachmentRef,
	messageMetadataSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import type { ReconcilerContextValue } from "@/lib/collab/context";
import { useReconcilerContext } from "@/lib/collab/context";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import type { ThreadDoc, ThreadMeta } from "@/lib/db/types";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	derivePhase,
	useAccessPhase,
	useCanEdit,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { BuilderSessionContext } from "@/lib/session/provider";
import type { ToastOptions, ToastSeverity } from "@/lib/ui/toastStore";

type ProjectToastEmitter = (
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: ToastOptions,
) => string;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Only auto-resend when the assistant's LAST step is askQuestions with all outputs available.
 *  If the SA continued past tool calls to ask a freeform text question, don't auto-resend —
 *  the user needs to reply manually first. */
function shouldAutoResend({ messages }: { messages: UIMessage[] }): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return false;

	type Part = UIMessage["parts"][number];
	const lastStepIdx = last.parts.reduce(
		(idx: number, p: Part, i: number) => (p.type === "step-start" ? i : idx),
		-1,
	);
	const lastStepParts = last.parts.slice(lastStepIdx + 1);

	const askParts = lastStepParts.filter(
		(p: Part) => p.type === "tool-askQuestions",
	);
	return (
		askParts.length > 0 &&
		askParts.every((p) => "state" in p && p.state === "output-available")
	);
}

/** The active thread as the Chat instance sees it — the id doubles as the
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

/** A thread doc as the LOADERS return it: the stored shape plus the derived
 *  `resume_interrupted` stamp — set whenever the row holds a live-stream
 *  marker whose app no live run holds (a run killed before finalize). The
 *  auto-re-drive trigger: level-triggered server-side (it stands until a
 *  re-drive's run retires the marker), consumed once per activation here. */
type LoadedThreadDoc = ThreadDoc & { resume_interrupted?: boolean };

/** Create a Chat instance with transport, data handling, and auto-resend config.
 *  Closures capture refs (not direct values) so they always read the latest
 *  store references — safe across re-renders within the same app session. */
function createChatInstance(
	init: ActiveThreadInit,
	docStoreRef: { current: BlueprintDocStore | null },
	sessionStoreRef: { current: BuilderSessionStoreApi | null },
	runIdRef: { current: string | undefined },
	holderNonceRef: { current: string | undefined },
	reconcilerCtxRef: { current: ReconcilerContextValue | null },
	ownUserIdRef: { current: string | undefined },
	appGeneratingRef: { current: boolean },
	threadHydrationStateRef: {
		current: "ready" | "pending" | "failed";
	},
	projectToast: ProjectToastEmitter,
	ownerScopeEpoch: number,
): Chat<NovaUIMessage> {
	/* The per-send request fields (beyond `messages`). The blueprint is NEVER
	 * sent — the route loads the persisted doc server-side off the
	 * authorization read. We send only the `appId`; `hasData` still feeds the
	 * `appReady` phase derivation below.
	 *
	 * `appReady` gates whether the server strips generation tools (editing
	 * mode) vs exposes them (build mode). We use the derived phase as the
	 * single source of truth — Ready or Completed both imply "app is usable,
	 * this is an edit-mode request." Generating / Idle / Loading all mean
	 * "don't strip tools." This handles the askQuestions-auto-resend during an
	 * initial build correctly: the buffer still carries the build's
	 * stage-tagged events and the run opened on an empty doc, so phase stays
	 * Generating → appReady=false → the planning tools remain available. */
	const requestFields = () => {
		const doc = docStoreRef.current?.getState();
		const session = sessionStoreRef.current;
		if (!session) return {};
		const sessionState = session.getState();
		const hasData = (doc?.moduleOrder.length ?? 0) > 0;
		const phase = derivePhase(
			{
				loading: sessionState.loading,
				runCompletedAt: sessionState.runCompletedAt,
				events: sessionState.events,
				runStartedWithData: sessionState.runStartedWithData,
			},
			hasData,
		);
		/* An UNFINISHED build owns the mode regardless of what the phase
		 * derivation reads off a fresh session: the page loaded a `generating`
		 * app (or an interrupted build being re-driven), its committed modules
		 * make `hasData` true and the event buffer is empty, so the derived
		 * phase would read Ready and flip this send to edit mode. Until a run
		 * COMPLETES in this session, sends against such an app are build-mode
		 * sends — the paused-round answer after a mid-build refresh and the
		 * instance-death re-drive both depend on it.
		 *
		 * Completion is a one-way LATCH on the ref (flipped by the `data-done`
		 * handler below), not a live read of `runCompletedAt`: the session
		 * store clears `runCompletedAt` ~3.5s after the celebration
		 * (`acknowledgeCompletion`), and a guard re-armed by that clear would
		 * send every later message in this tab as a BUILD — charged at build
		 * rates, claiming in build mode (flipping the complete app back to
		 * `generating`), and breaking edit-run answer resends against the
		 * edit's `run_lock`. The `runCompletedAt` term only covers the render
		 * gap between `data-done` arriving and this closure observing it. */
		const unfinishedBuild =
			appGeneratingRef.current && sessionState.runCompletedAt == null;
		const appReady =
			!unfinishedBuild &&
			(phase === BuilderPhase.Ready || phase === BuilderPhase.Completed);
		return {
			threadId: init.threadId,
			runId: runIdRef.current,
			holderNonce: holderNonceRef.current,
			appId: sessionState.appId,
			appReady,
		};
	};

	const instance = new Chat<NovaUIMessage>({
		/* The thread id IS the chat id: the transport's cold reconnect
		 * (`resumeStream` → `reconnectToStream({chatId})`) hits
		 * `/api/chat/{chatId}/stream`, and the endpoint resolves a thread id
		 * to its live stream — so a page refresh resumes with zero extra
		 * wiring. */
		id: init.threadId,
		/* The hydrated transcript — history renders through the same
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
		/* WorkflowChatTransport (from @ai-sdk/workflow) instead of
		 * DefaultChatTransport: when the POST's SSE ends WITHOUT a `finish`
		 * chunk — a network blip, a mid-run deploy hiccup, Cloud Run's
		 * 60-minute request cap — it reconnects to
		 * `/api/chat/{x-workflow-run-id}/stream?startIndex=<chunks received>`
		 * and resumes from the durable chunk log, instead of surfacing
		 * "Generation failed" while the run keeps going server-side. Only the
		 * transport is from the workflow package — the server side is Nova's
		 * own Postgres-backed endpoint, no workflow runtime involved. */
		transport: new WorkflowChatTransport<NovaUIMessage>({
			api: "/api/chat",
			maxConsecutiveErrors: 5,
			/* Unlike DefaultChatTransport there is no `body` option — the
			 * request is assembled here. The returned body REPLACES the default
			 * wholesale, so `messages` must be included explicitly — and so do
			 * the headers: the transport sends exactly what this returns, and a
			 * JSON POST without an explicit content-type goes out as
			 * `text/plain` (fetch's default for a string body). */
			prepareSendMessagesRequest: ({ api, messages, trigger }) => ({
				api,
				headers: { "content-type": "application/json" },
				body: {
					messages,
					...requestFields(),
					/* `regenerate()` fires in exactly one place — the instance-death
					 * re-drive — so the trigger doubles as the wire flag. The route
					 * treats a re-drive's claim conflict as "someone else already
					 * re-drove this" and closes clean instead of queueing a
					 * duplicate run. */
					...(trigger === "regenerate-message" ? { redrive: true } : {}),
				},
			}),
		}),
		sendAutomaticallyWhen: (args) => {
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
				 * member's run, refund chunk included — "you weren't charged" must
				 * only reach the actor who was. `userId` names the charged actor;
				 * a chunk without one (logged before the field existed) shows. */
				const refundedUser = data.userId as string | undefined;
				if (refundedUser && ownUserIdRef.current !== refundedUser) return;
				const amount = data.amount as number;
				// Reassurance, not an error — the failure itself is surfaced separately as
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

			/* `data-app-id` is the one-shot identity announcement the server
			 * emits only on the request that actually minted the app (see
			 * the `appCreated` gate in app/api/chat/route.ts). Receiving it
			 * is unambiguous proof that this is the /build/new → /build/{id}
			 * transition, so we can stamp the session store and rewrite the
			 * URL without any further checks. Edit requests never emit this
			 * event, so the handler never runs for them. (A RESUMED build
			 * replays it: the session setAppId and the URL rewrite are
			 * idempotent there, and the reconciler provider's `activate`
			 * no-ops once active.) */
			/* The build finished — sends from this tab are edit-mode from here
			 * on. One-way latch: without it the `unfinishedBuild` guard in
			 * `requestFields` re-arms once `acknowledgeCompletion` clears
			 * `runCompletedAt` (~3.5s after the celebration), and every later
			 * send would claim + charge as a BUILD. Falls through — the
			 * dispatcher consumes `data-done` too. */
			if (type === "data-done") {
				appGeneratingRef.current = false;
			}

			if (type === "data-app-id") {
				const newAppId = data.appId as string;
				sessionApi.getState().setAppId(newAppId);
				pushBuilderHistory(`/build/${newAppId}`, true);
				/* Activate the dormant new-build reconciler: seed it at
				 * `{ appId, baseSeq: 0, baseDoc: current doc }` and open the stream
				 * at cursor 0, so subsequent chat batches + human edits reconcile. */
				reconcilerCtxRef.current?.activate(newAppId);
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
	chatOwnerEpochs.set(instance, ownerScopeEpoch);
	return instance;
}

// ── Component ────────────────────────────────────────────────────────────

interface ChatContainerProps {
	/** Whether the layout is in centered mode (Idle phase — chat is the main content). */
	centered: boolean;
	/** Whether the app was loaded from Postgres (not a new build).
	 *  Drives the empty-state prompt text. */
	isExistingApp: boolean;
	/** Thread-list projection, most recently active first — loaded by the RSC
	 *  page; refreshed client-side after each run. */
	threads?: ThreadMeta[];
	/** The most recently active thread, transcript included — what this
	 *  session opens into. Null/absent on a brand-new build. May carry the
	 *  loader's derived `resume_interrupted` stamp (an instance-killed run
	 *  detected on this load), which triggers the auto-re-drive. */
	initialThread?: LoadedThreadDoc | null;
	/** True when the page loaded an app whose BUILD is unfinished — a
	 *  `generating` app, or an interrupted build admitted for re-drive. It's
	 *  the build-run signal for a live-thread resume/re-drive (an edit run
	 *  never flips a complete app's status) and keeps sends in build mode
	 *  until a run completes. `thread_type` can't drive this (it freezes at
	 *  thread creation, so the app's first conversation reads "build"
	 *  forever). */
	appGenerating?: boolean;
	/** The signed-in user — a replayed run's credit-refund notice is shown
	 *  only to the actor who was actually charged. */
	currentUserId?: string;
}

export function ChatContainer({
	centered,
	isExistingApp,
	threads,
	initialThread,
	appGenerating,
	currentUserId,
}: ChatContainerProps) {
	const docStore = useContext(BlueprintDocContext);
	const sessionApi = useContext(BuilderSessionContext);
	const reconcilerCtx = useReconcilerContext();
	const projectToast = useProjectToast();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	/* Viewers (view-only Project members) get a read-only conversation — the
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
	/** The page-load "this app's build is unfinished" signal (a `generating`
	 *  app, or an interrupted build admitted for re-drive) — read by
	 *  `requestFields` to keep sends in build mode until a run completes. */
	const appGeneratingRef = useRef(!!appGenerating);
	appGeneratingRef.current = !!appGenerating;
	const runIdRef = useRef<string | undefined>(initialThread?.run_id);
	const holderNonceRef = useRef<string | undefined>(
		initialThread?.holder_nonce,
	);
	/** Whether the SSE transport was open on the previous render — used
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

	/** The thread list — seeded by the RSC page, refreshed after each run. */
	const [threadMetas, setThreadMetas] = useState<ThreadMeta[]>(threads ?? []);
	/** The open thread's chat id awaiting a `resumeStream()` — set when a
	 *  hydrated thread has a run in flight, consumed once by the resume
	 *  effect below. */
	const pendingResumeRef = useRef<string | null>(
		initialThread?.active_stream_id ? initialThread.thread_id : null,
	);
	/** One-shot: the next `beginRun` belongs to a reconnected (live resume) or
	 *  RE-DRIVEN (instance death) BUILD run, so its build-vs-edit capture must
	 *  read "started empty" even though the build's committed modules are
	 *  already in the loaded doc — mirrors openThread's
	 *  `(live || redrive) && appGenerating`. Without the redrive arm, a
	 *  re-driven build would capture `runStartedWithData: true` off the
	 *  committed doc and render edit-mode chrome for the whole run. */
	const pendingBuildResumeRef = useRef(
		(initialThread?.active_stream_id != null ||
			initialThread?.resume_interrupted === true) &&
			!!appGenerating,
	);
	/** Set to the resuming Chat's id when `resumeStream()` fires; consumed on
	 *  stream close to heal the refresh-races-finalize gap (see the status
	 *  effect below). */
	const resumeHealRef = useRef<string | null>(null);
	/** The open thread's chat id awaiting an instance-death RE-DRIVE — set
	 *  when a loader detected the thread's dead stream marker
	 *  (`resume_interrupted`), consumed once per activation by the re-drive
	 *  effect below. Mutually exclusive with a pending resume (a dead
	 *  marker's projection strips `active_stream_id`). */
	const pendingRedriveRef = useRef<string | null>(
		initialThread?.resume_interrupted ? initialThread.thread_id : null,
	);
	/** One-shot per activation: healAfterResume may itself detect the dead
	 *  marker (its refetch runs after a resume/re-drive closed unanswered) and
	 *  trigger ONE more re-drive — this latch keeps a re-drive that keeps
	 *  failing pre-stream from ping-ponging with the heal into a retry loop.
	 *  The level-triggered server signal already retries on the NEXT load. */
	const healRedroveRef = useRef<string | null>(null);

	// ── Blank-app escape hatch (new builds only) ─────────────────────────

	/* The two ways out of `/build/new` are mutually exclusive, and whichever
	 * the user picks first wins — latched synchronously, in the handler that
	 * starts it. Refs, not state: `StartBlankApp` stays clickable all the way
	 * through its collapse (deliberately — it must not flash disabled mid-fade),
	 * so a click landing in that window has to meet a latch that was already set
	 * when the message was sent, rather than wait on a re-render. */
	const { replace } = useExternalNavigate();
	const [creatingBlankApp, setCreatingBlankApp] = useState(false);
	const agentEngagedRef = useRef(false);
	const creatingBlankAppRef = useRef(false);
	/** Set when a send failed before any app was minted — see the `chatError`
	 *  effect. Un-collapses the starter so the user isn't left with neither path. */
	const [sendFailedBeforeApp, setSendFailedBeforeApp] = useState(false);
	/** `createBlankApp` resolves against an app-wide router and a global toast
	 *  store, neither of which unmounts with us. Without this, abandoning a slow
	 *  create (Back, or the header logo) yanks the user into the new app seconds
	 *  later, or toasts a create failure onto a page that never had the button.
	 *  Re-armed in the effect body, not just the cleanup, so a StrictMode
	 *  mount→unmount→mount doesn't leave it stuck false. */
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// ── Chat instance — recreated on session change or thread switch ──────

	/** The ONE thread-activation path: stamp the per-thread refs (run id for
	 *  free-continuation resumes, the pending resume + build-capture
	 *  one-shots) and build the Chat instance those refs feed. Every way a
	 *  conversation becomes active — mount, session change, thread switch,
	 *  New chat — goes through here so the refs can't drift out of step. */
	const activateThread = useCallback(
		(
			init: ActiveThreadInit,
			opts?: {
				runId?: string;
				holderNonce?: string;
				resume?: boolean;
				buildResume?: boolean;
				redrive?: boolean;
			},
		): Chat<NovaUIMessage> => {
			runIdRef.current = opts?.runId;
			holderNonceRef.current = opts?.holderNonce;
			pendingResumeRef.current = opts?.resume ? init.threadId : null;
			pendingRedriveRef.current = opts?.redrive ? init.threadId : null;
			pendingBuildResumeRef.current = !!opts?.buildResume;
			return createChatInstance(
				init,
				docStoreRef,
				sessionStoreRef,
				runIdRef,
				holderNonceRef,
				reconcilerCtxRef,
				ownUserIdRef,
				appGeneratingRef,
				threadHydrationStateRef,
				projectToast,
				scopeEpoch,
			);
		},
		[projectToast, scopeEpoch],
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
			reconcilerCtxRef,
			ownUserIdRef,
			appGeneratingRef,
			threadHydrationStateRef,
			projectToast,
			scopeEpoch,
		),
	);

	if (sessionApi !== prevSessionRef.current) {
		prevSessionRef.current = sessionApi;
		setChat(activateThread({ threadId: crypto.randomUUID(), messages: [] }));
	}

	// ── Chat hook — the core reason this component exists ─────────────────
	// useChat produces React state (messages, status) that changes on every
	// streamed token. By calling it HERE instead of in BuilderLayout, those
	// per-token re-renders only affect ChatSidebar — not the entire app.
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
				const live = thread.active_stream_id != null;
				const redrive = !live && thread.resume_interrupted === true;
				setChat(
					activateThread(
						{
							threadId: thread.thread_id,
							messages: mergeRetainedUserTextSuffix(
								thread.messages as NovaUIMessage[],
								pending.retainedMessages,
							),
						},
						{
							runId: thread.run_id,
							resume: live,
							redrive,
							buildResume: (live || redrive) && appGeneratingRef.current,
						},
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
	}, [accessPhase, scopeEpoch, activateThread, projectToast]);

	// ── Live-run resume ───────────────────────────────────────────────────
	/* A hydrated thread with a run in flight reconnects HERE: `resumeStream`
	 * asks the transport to `reconnectToStream({chatId})` — the thread id —
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
	 * stream marker proved a run claimed the turn and died before answering
	 * (a deploy kill, an OOM — the reaper already refunded it). Re-run the
	 * turn through the normal POST/claim/charge machinery so, from the user's
	 * side, the response simply arrives: `regenerate()` re-sends the current
	 * transcript (its trailing message is the unanswered user turn — a thread
	 * paused on askQuestions ends on `assistant` and never re-drives). The
	 * one-shot ref can't loop — a re-driven run that fails again finalizes
	 * cleanly, so no future load sees another heal. The heal ref covers the
	 * lost-race close (another session's re-drive won the claim): this send
	 * bails clean, the refetch attaches to the winner. */
	useEffect(() => {
		if (pendingRedriveRef.current !== chat.id) return;
		pendingRedriveRef.current = null;
		if (chat.lastMessage?.role !== "user") return;
		resumeHealRef.current = chat.id;
		void regenerate();
	}, [chat, regenerate]);

	/* The refresh-races-finalize heal. A resume can legitimately deliver
	 * NOTHING: the page's RSC read saw the run live (transcript without the
	 * response, marker set), the run finalized during load, and the reconnect
	 * then answers a bare finish — leaving the user's message visibly
	 * unanswered even though the response is persisted. When a resume closes
	 * with the transcript still ending on a user turn, re-fetch the thread
	 * once and adopt its messages (a no-op when nothing newer exists, e.g. a
	 * failed run's dangling user turn). */
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
			 * right now — the shape a lost re-drive race leaves behind (this
			 * send bailed clean while the winner streams). Attach to it: swap in
			 * the fetched transcript and resume the winner's stream by thread
			 * id, exactly as a page load over a live run would. */
			if (thread.active_stream_id != null) {
				setChat(
					activateThread(
						{
							threadId: thread.thread_id,
							messages: thread.messages as NovaUIMessage[],
						},
						{
							runId: thread.run_id,
							holderNonce: thread.holder_nonce,
							resume: true,
							buildResume: appGeneratingRef.current,
						},
					),
				);
				return;
			}
			/* The refetch DETECTED a dead marker: the run this heal followed
			 * died without answering (the resume attached to a stream that was
			 * never finalized, or the re-drive itself was killed). Re-drive it
			 * exactly as openThread would — once per activation
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
						{
							runId: thread.run_id,
							holderNonce: thread.holder_nonce,
							redrive: true,
							buildResume: appGeneratingRef.current,
						},
					),
				);
				return;
			}
			if (thread.messages.length > 0) {
				setMessages(thread.messages as NovaUIMessage[]);
			}
		} catch {
			/* Best-effort — the conversation still works; the response shows on
			 * the next open. */
		} finally {
			activeThreadReadsRef.current.delete(controller);
		}
	}, [chat, setMessages, activateThread]);

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
			/* Abort the current thread's client-side stream read (the run — if
			 * any — continues server-side and stays resumable from its row). */
			stopRef.current?.();
			const live = thread.active_stream_id != null;
			/* This fetch just HEALED a dead marker on the opened thread — the
			 * same instance-death signal the page load acts on. Re-drive it. */
			const redrive = !live && thread.resume_interrupted === true;
			setChat(
				activateThread(
					{
						threadId: thread.thread_id,
						messages: thread.messages as NovaUIMessage[],
					},
					{
						runId: thread.run_id,
						holderNonce: thread.holder_nonce,
						resume: live,
						redrive,
						/* `appGenerating` (not thread_type, which freezes at
						 * creation) is the build-run signal — an edit run resumed
						 * in the app's original build-typed thread must keep the
						 * edit-mode capture. */
						buildResume: (live || redrive) && !!appGenerating,
					},
				),
			);
			return true;
		},
		[chat, appGenerating, activateThread, projectToast],
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
	 * Transition detection uses a local ref — the session store has no
	 * `agentActive` field to read from. The buffer is the "a run is in
	 * progress" signal (non-empty between beginRun and endRun); we just
	 * need to know WHEN to flip it, which is the status edge.
	 *
	 * `endRun` is a pure stream-close — whether the run was "completed"
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
			 * modules as pre-existing data — consume the one-shot override. */
			const startedWithData = pendingBuildResumeRef.current ? false : undefined;
			pendingBuildResumeRef.current = false;
			sessionApi
				.getState()
				.beginRun(
					startedWithData === undefined ? undefined : { startedWithData },
				);
		} else if (!streamOpen && wasOpen) {
			sessionApi.getState().endRun();
			/* The run is over — clear the reconciler's active run id. Every batch
			 * the run committed is registered (`batchId ∈ awaitingEcho` covers its
			 * late echoes), so the runId fallback is no longer needed — and leaving
			 * it set would misclassify a LATER same-user frame that carries the
			 * same run id (MCP's deriveRunId continues the app's stored run_id
			 * inside a sliding window) as a self-echo, skipping its apply/rebase. */
			reconcilerCtxRef.current?.reconciler.setSelfActiveRunId(undefined);
			// A fresh build mounts with undo paused (it generates first). When the
			// run ends the app is live/editable, so release the store's one-time
			// birth pause — this is what makes undo work after a build without a
			// page reload. Idempotent: a no-op once tracking is already live, so
			// calling it on every run-end is safe.
			docStoreRef.current?.getState().startTracking();
			/* A closed RESUME that delivered no response (transcript still ends
			 * on the user's turn) raced finalize — adopt the persisted thread. */
			if (resumeHealRef.current === chat.id) {
				resumeHealRef.current = null;
				if (chat.lastMessage?.role === "user") void healAfterResume();
			}
		}
	}, [status, sessionApi, chat, healAfterResume, scopeEpoch]);

	/* Surface stream-level failures (network drops, spend cap, auth,
	 * server crashes) that never got a chance to produce a
	 * server-side conversation error event. Synthesize one client-side
	 * and push it onto the buffer — the lifecycle derivation then picks
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
			 * chat call), so `source: "chat"` is correct. Not persisted —
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
		 * user on `/build/new` with nothing. Re-arm the blank-app path they were
		 * offered a moment ago — the send had latched it shut, and without this
		 * the only ways out are a reload or navigating away. A failure that got
		 * far enough to mint an app already announced it via `data-app-id`, so
		 * `appId` is set and the escape hatch correctly stays closed. */
		if (!session.appId) {
			agentEngagedRef.current = false;
			setSendFailedBeforeApp(true);
		}
	}, [chat, chatError, projectToast, scopeEpoch, sessionApi]);

	/* Refresh the thread list after each run settles. The server is the
	 * writer (the route persists the turn at claim and the response at
	 * finalize), so a re-read is the one honest way to reflect it — it also
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
			if (creatingBlankAppRef.current) return;
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
			addToolOutput(params);
		},
		[addToolOutput, scopeEpoch],
	);

	const handleCreateBlankApp = useCallback(() => {
		if (agentEngagedRef.current || creatingBlankAppRef.current) return;
		creatingBlankAppRef.current = true;
		setCreatingBlankApp(true);
		createBlankApp().then(
			(result) => {
				/* The app was created either way; we just no longer own the screen. */
				if (!mountedRef.current) return;
				if (!result.success) {
					creatingBlankAppRef.current = false;
					setCreatingBlankApp(false);
					projectToast("error", "Couldn't create the app", result.error);
					return;
				}
				/* `replace`, not `push` — the app exists now, so `/build/new` is not
				 * a place to go back to. Leave the latches set: the RSC navigation
				 * unmounts this tree, and nothing should send in the meantime. */
				replace(`/build/${result.appId}`);
			},
			/* The action itself never rejects — it returns its failures. Landing
			 * here means the Server Action CALL didn't complete (offline, a deploy
			 * mid-flight), so there's nothing to unwrap — and, since the write may
			 * well have landed before the response was lost, no way to know whether
			 * an app exists. `createApp` takes no idempotency key, so a blind retry
			 * can mint a second one; say so rather than inviting it. */
			() => {
				if (!mountedRef.current) return;
				creatingBlankAppRef.current = false;
				setCreatingBlankApp(false);
				projectToast(
					"error",
					"Couldn't confirm the app was created",
					"Check your connection, then look in your app list before trying again. The app may already be there.",
				);
			},
		);
	}, [projectToast, replace]);

	// ── Derived values ───────────────────────────────────────────────────

	/* Viewers (view-only Project members) get a read-only conversation — the
	 * composer hides. */
	const readOnly = !canEdit;

	/* The SA is in play the moment a message exists — `useChat` appends the
	 * user's turn optimistically, so this flips on the same tick as the send.
	 * Staging or extracting a document does NOT flip it: extraction lives on
	 * the composer (`onReadingChange`), never on `messages`. A send that never
	 * reached a run gives the escape hatch back. */
	const agentEngaged = messages.length > 0 && !sendFailedBeforeApp;

	/* Only on a brand-new build, and only where the composer itself is offered
	 * — a surface that can't send can't create either. Note this does NOT gate
	 * out a view-only member: `canEdit` defaults to `true` on `/build/new`
	 * (BuilderProvider has no role to consult before an app exists), so they see
	 * this exactly as they see the composer, and `createBlankApp` refuses them
	 * server-side exactly as `/api/chat` does. That Project `edit` check is the
	 * gate; this is only about which surfaces make sense to show. */
	const showBlankAppStarter = centered && !isExistingApp && !readOnly;

	return (
		<ChatSidebar
			key="chat"
			centered={centered}
			heroLogo={centered ? <Logo size="hero" /> : undefined}
			startBlankApp={
				showBlankAppStarter ? (
					<StartBlankApp
						agentEngaged={agentEngaged}
						creating={creatingBlankApp}
						onCreate={handleCreateBlankApp}
					/>
				) : undefined
			}
			composerBusy={creatingBlankApp || threadScopeReloading}
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
					? "You have view-only access to this app. Ask a Project admin for edit access to make changes."
					: undefined
			}
			isExistingApp={isExistingApp}
			threads={threadMetas}
			activeThreadId={chat.id}
			onSelectThread={openThread}
			onNewChat={startNewChat}
		/>
	);
}
