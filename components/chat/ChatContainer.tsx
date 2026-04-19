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
 * Replay messages are read from the session store (written by ReplayController).
 * Server-rendered thread history is passed through as children.
 */
"use client";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { Logo } from "@/components/ui/Logo";
import { parseApiErrorMessage } from "@/lib/apiError";
import { extractThread } from "@/lib/chat/threadUtils";
import { saveThread } from "@/lib/db/threads";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { BuilderPhase } from "@/lib/services/builder";
import { showToast } from "@/lib/services/toastStore";
import { derivePhase, useReplayMessages } from "@/lib/session/hooks";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import {
	BuilderSessionContext,
	useBuilderSession,
} from "@/lib/session/provider";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Only auto-resend when the assistant's LAST step is askQuestions with all outputs available.
 *  If the SA continued past tool calls to ask a freeform text question, don't auto-resend —
 *  the user needs to reply manually first. */
function shouldAutoResend({ messages }: { messages: UIMessage[] }): boolean {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return false;

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
): Chat<UIMessage> {
	return new Chat<UIMessage>({
		transport: new DefaultChatTransport({
			api: "/api/chat",
			body: () => {
				const doc = docStoreRef.current?.getState();
				const session = sessionStoreRef.current;
				if (!session) return {};
				const sessionState = session.getState();
				const hasData = (doc?.moduleOrder.length ?? 0) > 0;
				/* Send the normalized doc directly — the route converts to the
				 * SA's wire format server-side. `fieldParent` is a derived,
				 * non-persisted field, so we omit it from the wire payload
				 * (matches Firestore's persistence contract). */
				const wireDoc =
					doc && hasData
						? (() => {
								const { fieldParent: _fp, ...persistable } = doc;
								return persistable;
							})()
						: undefined;
				/* `appReady` gates whether the server strips generation tools
				 * (editing mode) vs exposes them (build mode). We use the
				 * derived phase as the single source of truth — Ready or
				 * Completed both imply "app is usable, this is an edit-mode
				 * request." Generating / Idle / Loading all mean "don't strip
				 * tools." This handles the askQuestions-auto-resend during an
				 * initial build correctly: the buffer still contains the
				 * build's schema/scaffold events, so phase stays Generating
				 * → appReady=false → gen tools remain available. */
				const phase = derivePhase(
					{
						loading: sessionState.loading,
						runCompletedAt: sessionState.runCompletedAt,
						events: sessionState.events,
					},
					hasData,
				);
				const appReady =
					phase === BuilderPhase.Ready || phase === BuilderPhase.Completed;
				return {
					doc: wireDoc,
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
				return;
			}

			const docApi = docStoreRef.current;
			const sessionApi = sessionStoreRef.current;
			if (!docApi || !sessionApi) return;

			/* After first save, update the URL from /build/new → /build/{id}
			 * without triggering a navigation or remount. The appId lives on
			 * the session store; no dispatcher pass-through needed for this
			 * purely-UI signal. */
			if (type === "data-app-saved") {
				sessionApi.getState().setAppId(data.appId as string);
				window.history.replaceState({}, "", `/build/${data.appId as string}`);
				return;
			}

			applyStreamEvent(type, data, docApi, sessionApi);
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
	const inReplayMode = useBuilderSession((s) => s.replay !== undefined);
	/** Replay messages — derived on read from the session store's event
	 *  log + cursor. ReplayController writes the cursor; this hook
	 *  projects the events into `UIMessage[]`. */
	const replayMessages = useReplayMessages();

	// ── Stable refs so Chat callbacks always read the latest stores ──────
	const docStoreRef = useRef(docStore);
	docStoreRef.current = docStore;
	const sessionStoreRef = useRef(sessionApi);
	sessionStoreRef.current = sessionApi;
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
		const existingSeq = session.events.length;
		session.pushEvent({
			kind: "conversation",
			runId,
			ts: Date.now(),
			seq: existingSeq,
			payload: {
				type: "error",
				error: { type: "network", message, fatal: true },
			},
		});
		showToast("error", "Generation failed", message);
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

	// ── Derived values ───────────────────────────────────────────────────

	const handleSend = useCallback(
		(text: string) => {
			if (!text.trim()) return;
			sendMessage({ text });
		},
		[sendMessage],
	);

	return (
		<ChatSidebar
			key="chat"
			centered={centered}
			heroLogo={centered ? <Logo size="hero" /> : undefined}
			messages={inReplayMode ? replayMessages : messages}
			status={inReplayMode ? "ready" : status}
			onSend={handleSend}
			addToolOutput={addToolOutput}
			readOnly={inReplayMode}
			isExistingApp={isExistingApp}
		>
			{!inReplayMode && children}
		</ChatSidebar>
	);
}
