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
 * Server-rendered thread history is passed through as children.
 */
"use client";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
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
import { extractThread } from "@/lib/chat/threadUtils";
import type { ReconcilerContextValue } from "@/lib/collab/context";
import { useReconcilerContext } from "@/lib/collab/context";
import { saveThread } from "@/lib/db/threads";
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

/** Create a Chat instance with transport, data handling, and auto-resend config.
 *  Closures capture refs (not direct values) so they always read the latest
 *  store references — safe across re-renders within the same app session. */
function createChatInstance(
	docStoreRef: { current: BlueprintDocStore | null },
	sessionStoreRef: { current: BuilderSessionStoreApi | null },
	runIdRef: { current: string | undefined },
	lastResponseAtRef: { current: string | undefined },
	reconcilerCtxRef: { current: ReconcilerContextValue | null },
): Chat<NovaUIMessage> {
	return new Chat<NovaUIMessage>({
		// Validates any message metadata the SDK parses on the client. Outbound
		// attachment metadata rides `sendMessage` regardless; this guards the
		// (currently unused) inbound path where the server sets message metadata.
		messageMetadataSchema,
		transport: new DefaultChatTransport({
			api: "/api/chat",
			body: () => {
				const doc = docStoreRef.current?.getState();
				const session = sessionStoreRef.current;
				if (!session) return {};
				const sessionState = session.getState();
				const hasData = (doc?.moduleOrder.length ?? 0) > 0;
				/* The blueprint is NEVER sent — the route loads the persisted doc
				 * server-side off the authorization read. We send only the `appId`;
				 * `hasData` still feeds the `appReady` phase derivation below. */
				/* `appReady` gates whether the server strips generation tools
				 * (editing mode) vs exposes them (build mode). We use the
				 * derived phase as the single source of truth — Ready or
				 * Completed both imply "app is usable, this is an edit-mode
				 * request." Generating / Idle / Loading all mean "don't strip
				 * tools." This handles the askQuestions-auto-resend during an
				 * initial build correctly: the buffer still carries the
				 * build's stage-tagged events and the run opened on an empty
				 * doc, so phase stays Generating → appReady=false → the
				 * planning tools remain available. */
				const phase = derivePhase(
					{
						loading: sessionState.loading,
						runCompletedAt: sessionState.runCompletedAt,
						events: sessionState.events,
						runStartedWithData: sessionState.runStartedWithData,
					},
					hasData,
				);
				const appReady =
					phase === BuilderPhase.Ready || phase === BuilderPhase.Completed;
				return {
					runId: runIdRef.current,
					appId: sessionState.appId,
					lastResponseAt: lastResponseAtRef.current,
					appReady,
				};
			},
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
			 * event, so the handler never runs for them. */
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
	/** Whether the app was loaded from Firestore (not a new build).
	 *  Drives thread type classification (build vs edit). */
	isExistingApp: boolean;
	/** Server-rendered thread history — pre-rendered by the RSC page
	 *  inside a Suspense boundary, passed through the client boundary. */
	children?: React.ReactNode;
}

export function ChatContainer({
	centered,
	isExistingApp,
	children,
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
	const runIdRef = useRef<string | undefined>(undefined);
	/** Whether the SSE transport was open on the previous render — used
	 *  to detect `ready`→`streaming` and `streaming`→`ready` transitions
	 *  for the `beginRun` / `endRun` handoff. Local to this component so
	 *  the session store never has to mirror the transport status as a
	 *  shadow field. Initial false matches the SDK's initial `status:
	 *  "ready"` so the very first render is a no-op. */
	const prevStreamOpenRef = useRef(false);
	/** ISO timestamp of the SA's last response — used to determine if the
	 *  Anthropic prompt cache is still warm on subsequent requests. */
	const lastResponseAtRef = useRef<string | undefined>(undefined);

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

	// ── Chat instance — recreated when the session store identity changes ──
	/* The session store is recreated inside `BuilderSessionProvider` on every
	 * buildId change (the parent `BuilderProvider` keys on buildId, unmounting
	 * and remounting all children). Its reference is the canonical per-app
	 * identity. Clear stale local state from the previous app: run ID and
	 * the Chat instance. */
	const prevSessionRef = useRef(sessionApi);
	const [chat, setChat] = useState(() =>
		createChatInstance(
			docStoreRef,
			sessionStoreRef,
			runIdRef,
			lastResponseAtRef,
			reconcilerCtxRef,
		),
	);

	if (sessionApi !== prevSessionRef.current) {
		prevSessionRef.current = sessionApi;
		runIdRef.current = undefined;
		lastResponseAtRef.current = undefined;
		setChat(
			createChatInstance(
				docStoreRef,
				sessionStoreRef,
				runIdRef,
				lastResponseAtRef,
				reconcilerCtxRef,
			),
		);
	}

	// ── Chat hook — the core reason this component exists ─────────────────
	// useChat produces React state (messages, status) that changes on every
	// streamed token. By calling it HERE instead of in BuilderLayout, those
	// per-token re-renders only affect ChatSidebar — not the entire app.
	const {
		messages,
		sendMessage,
		addToolOutput,
		status,
		error: chatError,
	} = useChat({ chat });

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
	 * without any animation. Stamps `lastResponseAtRef` on the ready
	 * transition for the next request's Anthropic-cache warmth check. */
	useEffect(() => {
		if (!sessionApi) return;
		const streamOpen = status === "submitted" || status === "streaming";
		const wasOpen = prevStreamOpenRef.current;
		prevStreamOpenRef.current = streamOpen;
		if (streamOpen && !wasOpen) {
			sessionApi.getState().beginRun();
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
			if (status === "ready") {
				lastResponseAtRef.current = new Date().toISOString();
			}
		}
	}, [status, sessionApi]);

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

	/* Persist the active conversation thread on each status=ready transition.
	 * Fire-and-forget via server action — a Firestore outage never blocks the UI. */
	const threadStartRef = useRef<string | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionApi is stable; snapshot read at fire time for appId
	useEffect(() => {
		if (status !== "ready" || messages.length === 0 || !sessionApi) return;
		const appId = sessionApi.getState().appId;
		const runId = runIdRef.current;
		if (!appId || !runId) return;

		if (!threadStartRef.current) {
			threadStartRef.current = new Date().toISOString();
		}
		const thread = extractThread(
			messages,
			runId,
			isExistingApp,
			threadStartRef.current,
		);
		saveThread(appId, thread);
	}, [status, messages, isExistingApp]);

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
		>
			{children}
		</ChatSidebar>
	);
}
