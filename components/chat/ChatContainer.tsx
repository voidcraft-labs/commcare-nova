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
 *  - A thread whose run DIED mid-flight (instance kill — the loader healed
 *    its dead marker and stamped `resume_interrupted`) is RE-DRIVEN on open:
 *    `regenerate()` re-runs the unanswered turn through the normal
 *    POST/claim/charge machinery, so from the user's side the response
 *    simply arrives. One-shot by construction; a lost race against another
 *    session's re-drive bails clean and attaches to the winner's stream.
 *  - Switching threads (or "New chat") swaps the Chat instance; sending in
 *    any thread just continues it — the full history rides every POST.
 */
"use client";
import { Chat, useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import type { UIMessage } from "ai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
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
import type { ThreadDoc, ThreadMeta } from "@/lib/db/types";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { derivePhase, useCanEdit } from "@/lib/session/hooks";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { BuilderSessionContext } from "@/lib/session/provider";
import { showToast } from "@/lib/ui/toastStore";

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

/** A thread doc as the LOADERS return it: the stored shape plus the
 *  transient `resume_interrupted` stamp — set only on the load that healed a
 *  dead live-stream marker (a run killed before finalize). That one-shot is
 *  the auto-re-drive trigger; it never persists, so a re-drive can't loop. */
type LoadedThreadDoc = ThreadDoc & { resume_interrupted?: boolean };

/** Create a Chat instance with transport, data handling, and auto-resend config.
 *  Closures capture refs (not direct values) so they always read the latest
 *  store references — safe across re-renders within the same app session. */
function createChatInstance(
	init: ActiveThreadInit,
	docStoreRef: { current: BlueprintDocStore | null },
	sessionStoreRef: { current: BuilderSessionStoreApi | null },
	runIdRef: { current: string | undefined },
	reconcilerCtxRef: { current: ReconcilerContextValue | null },
	ownUserIdRef: { current: string | undefined },
	appGeneratingRef: { current: boolean },
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
		 * COMPLETES in this session (`runCompletedAt`), sends against such an
		 * app are build-mode sends — the paused-round answer after a mid-build
		 * refresh and the instance-death re-drive both depend on it. */
		const unfinishedBuild =
			appGeneratingRef.current && sessionState.runCompletedAt == null;
		const appReady =
			!unfinishedBuild &&
			(phase === BuilderPhase.Ready || phase === BuilderPhase.Completed);
		return {
			threadId: init.threadId,
			runId: runIdRef.current,
			appId: sessionState.appId,
			appReady,
		};
	};

	return new Chat<NovaUIMessage>({
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
		// attachment metadata rides `sendMessage` regardless; this guards the
		// (currently unused) inbound path where the server sets message metadata.
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
		sendAutomaticallyWhen: shouldAutoResend,
		onData: (part) => {
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
				showToast(
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
			if (type === "data-app-id") {
				const newAppId = data.appId as string;
				sessionApi.getState().setAppId(newAppId);
				window.history.replaceState({}, "", `/build/${newAppId}`);
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
			);
		},
	});
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
	 *  loader's transient `resume_interrupted` stamp (an instance-killed run
	 *  healed on this load), which triggers the auto-re-drive. */
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
	/** Whether the SSE transport was open on the previous render — used
	 *  to detect `ready`→`streaming` and `streaming`→`ready` transitions
	 *  for the `beginRun` / `endRun` handoff. Local to this component so
	 *  the session store never has to mirror the transport status as a
	 *  shadow field. Initial false matches the SDK's initial `status:
	 *  "ready"` so the very first render is a no-op. */
	const prevStreamOpenRef = useRef(false);

	// ── Threads ──────────────────────────────────────────────────────────

	/** The thread list — seeded by the RSC page, refreshed after each run. */
	const [threadMetas, setThreadMetas] = useState<ThreadMeta[]>(threads ?? []);
	/** The open thread's chat id awaiting a `resumeStream()` — set when a
	 *  hydrated thread has a run in flight, consumed once by the resume
	 *  effect below. */
	const pendingResumeRef = useRef<string | null>(
		initialThread?.active_stream_id ? initialThread.thread_id : null,
	);
	/** One-shot: the next `beginRun` belongs to a reconnected BUILD run
	 *  (page loaded a `generating` app), so its build-vs-edit capture must
	 *  read "started empty" even though the build's committed modules are
	 *  already in the loaded doc. */
	const pendingBuildResumeRef = useRef(
		initialThread?.active_stream_id != null && !!appGenerating,
	);
	/** Set to the resuming Chat's id when `resumeStream()` fires; consumed on
	 *  stream close to heal the refresh-races-finalize gap (see the status
	 *  effect below). */
	const resumeHealRef = useRef<string | null>(null);
	/** The open thread's chat id awaiting an instance-death RE-DRIVE — set
	 *  when a loader healed the thread's dead stream marker
	 *  (`resume_interrupted`), consumed once by the re-drive effect below.
	 *  Mutually exclusive with a pending resume (a healed marker is null). */
	const pendingRedriveRef = useRef<string | null>(
		initialThread?.resume_interrupted ? initialThread.thread_id : null,
	);

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
				resume?: boolean;
				buildResume?: boolean;
				redrive?: boolean;
			},
		): Chat<NovaUIMessage> => {
			runIdRef.current = opts?.runId;
			pendingResumeRef.current = opts?.resume ? init.threadId : null;
			pendingRedriveRef.current = opts?.redrive ? init.threadId : null;
			pendingBuildResumeRef.current = !!opts?.buildResume;
			return createChatInstance(
				init,
				docStoreRef,
				sessionStoreRef,
				runIdRef,
				reconcilerCtxRef,
				ownUserIdRef,
				appGeneratingRef,
			);
		},
		[],
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
			reconcilerCtxRef,
			ownUserIdRef,
			appGeneratingRef,
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
		const appId = sessionStoreRef.current?.getState().appId;
		if (!appId) return;
		try {
			const res = await fetch(
				`/api/apps/${appId}/threads/${encodeURIComponent(chat.id)}`,
			);
			if (!res.ok) return;
			const { thread } = (await res.json()) as { thread: LoadedThreadDoc };
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
							resume: true,
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
		}
	}, [chat, setMessages, activateThread]);

	// ── Thread switching ──────────────────────────────────────────────────

	const openThread = useCallback(
		async (threadId: string) => {
			if (threadId === chat.id) return;
			const appId = sessionStoreRef.current?.getState().appId;
			if (!appId) return;
			let thread: LoadedThreadDoc;
			try {
				const res = await fetch(
					`/api/apps/${appId}/threads/${encodeURIComponent(threadId)}`,
				);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				({ thread } = (await res.json()) as { thread: LoadedThreadDoc });
			} catch {
				showToast(
					"error",
					"Couldn't open the conversation",
					"Check your connection and try again.",
				);
				return;
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
		},
		[chat, appGenerating, activateThread],
	);

	const startNewChat = useCallback(() => {
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
	useEffect(() => {
		if (!sessionApi) return;
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
	}, [status, sessionApi, chat, healAfterResume]);

	/* Surface stream-level failures (network drops, spend cap, auth,
	 * server crashes) that never got a chance to produce a
	 * server-side conversation error event. Synthesize one client-side
	 * and push it onto the buffer — the lifecycle derivation then picks
	 * it up identically to a server-emitted error. Toast is fired here
	 * because the synthetic event doesn't flow through the dispatcher's
	 * conversation-event handler. */
	useEffect(() => {
		if (!chatError || !sessionApi) return;
		const message = parseApiErrorMessage(chatError.message);
		const session = sessionApi.getState();
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
		showToast("error", "Generation failed", message);

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
	}, [chatError, sessionApi]);

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
		let cancelled = false;
		fetch(`/api/apps/${appId}/threads`)
			.then(async (res) => {
				if (!res.ok || cancelled) return;
				const { threads: fresh } = (await res.json()) as {
					threads: ThreadMeta[];
				};
				if (!cancelled) setThreadMetas(fresh);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
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
		[sendMessage],
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
					showToast("error", "Couldn't create the app", result.error);
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
				showToast(
					"error",
					"Couldn't confirm the app was created",
					"Check your connection, then look in your app list before trying again — one may already be there.",
				);
			},
		);
	}, [replace]);

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
			composerBusy={creatingBlankApp}
			messages={messages}
			status={status}
			onSend={handleSend}
			addToolOutput={addToolOutput}
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
