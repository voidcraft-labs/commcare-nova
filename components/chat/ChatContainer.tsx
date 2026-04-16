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
import { toBlueprint } from "@/lib/doc/converter";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { showToast } from "@/lib/services/toastStore";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import {
	BuilderSessionContext,
	useBuilderSession,
} from "@/lib/session/provider";

/** Reference-stable empty array for replay messages when not in replay mode.
 *  Avoids creating a new `[]` on every render, which would cause unnecessary
 *  re-renders in shallow-equality consumers. */
const EMPTY_MESSAGES: UIMessage[] = [];

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
				const docHasData = (doc?.moduleOrder.length ?? 0) > 0;
				return {
					blueprint: doc && docHasData ? toBlueprint(doc) : undefined,
					runId: runIdRef.current,
					appId: sessionState.appId,
					lastResponseAt: lastResponseAtRef.current,
					/* appReady must be false during initial generation even after
					 * scaffold creates modules — generation tools must not be
					 * stripped mid-build. The Generating check mirrors the old
					 * selectIsReady which excluded phase === Generating. */
					appReady:
						docHasData &&
						!sessionState.loading &&
						!(sessionState.agentActive && !sessionState.postBuildEdit),
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

			/* After first save, update the URL from /build/new → /build/{id} without
			 * triggering a navigation or remount. The stream dispatcher stores the
			 * ID on the session store. */
			if (type === "data-app-saved") {
				applyStreamEvent(type, data, docApi, sessionApi);
				window.history.replaceState({}, "", `/build/${data.appId as string}`);
				return;
			}

			applyStreamEvent(type, data, docApi, sessionApi);
			if (type === "data-error") {
				showToast(
					data.fatal ? "error" : "warning",
					"Generation error",
					data.message as string,
				);
			}
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
	/** Replay messages — written by ReplayController, read here. Both
	 *  communicate through the session store, not through a shared parent. */
	const replayMessages = useBuilderSession(
		(s) => s.replay?.messages ?? EMPTY_MESSAGES,
	);

	// ── Stable refs so Chat callbacks always read the latest stores ──────
	const docStoreRef = useRef(docStore);
	docStoreRef.current = docStore;
	const sessionStoreRef = useRef(sessionApi);
	sessionStoreRef.current = sessionApi;
	const runIdRef = useRef<string | undefined>(undefined);
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

	/* Sync chat transport status → agent state on the session store (drives
	 * the signal grid's "thinking" badge). Also stamps `lastResponseAtRef`
	 * when the SA finishes so the next request can decide whether the
	 * Anthropic prompt cache is still warm. */
	useEffect(() => {
		if (!sessionApi) return;
		const active = status === "submitted" || status === "streaming";
		const session = sessionApi.getState();
		const wasActive = session.agentActive;
		session.setAgentActive(active);
		if (status === "ready" && wasActive) {
			lastResponseAtRef.current = new Date().toISOString();
		}
	}, [status, sessionApi]);

	/* Surface stream-level errors from useChat (network, API key, server crash, spend cap).
	 * Only record the error when the agent is actively generating (not during post-build
	 * edits) — idle errors get a toast only. Reads session state imperatively — they're
	 * not deps, just point-in-time checks when chatError fires. */
	useEffect(() => {
		if (!chatError || !sessionApi) return;
		const message = parseApiErrorMessage(chatError.message);
		const session = sessionApi.getState();
		const isGenerating = session.agentActive && !session.postBuildEdit;
		if (isGenerating && !session.agentError) {
			session.failAgentWrite(message, "failed");
		}
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
