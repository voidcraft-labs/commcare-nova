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
 * Replay messages are read from the store (written by ReplayController).
 * Server-rendered thread history is passed through as children.
 */
"use client";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { Logo } from "@/components/ui/Logo";
import { useBuilderEngine, useBuilderStore } from "@/hooks/useBuilder";
import { parseApiErrorMessage } from "@/lib/apiError";
import { extractThread } from "@/lib/chat/threadUtils";
import { saveThread } from "@/lib/db/threads";
import { toBlueprint } from "@/lib/doc/converter";
import { applyDataPart, BuilderPhase } from "@/lib/services/builder";
import type { BuilderEngine } from "@/lib/services/builderEngine";
import {
	selectInReplayMode,
	selectIsReady,
} from "@/lib/services/builderSelectors";
import { showToast } from "@/lib/services/toastStore";

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
 *  builder and runId — safe across re-renders within the same app session. */
function createChatInstance(
	builderRef: { current: BuilderEngine },
	runIdRef: { current: string | undefined },
	lastResponseAtRef: { current: string | undefined },
): Chat<UIMessage> {
	return new Chat<UIMessage>({
		transport: new DefaultChatTransport({
			api: "/api/chat",
			body: () => {
				const s = builderRef.current.store.getState();
				const doc = builderRef.current.docStore?.getState();
				const hasBlueprint = (doc?.moduleOrder.length ?? 0) > 0;
				return {
					blueprint: doc && hasBlueprint ? toBlueprint(doc) : undefined,
					runId: runIdRef.current,
					appId: s.appId,
					lastResponseAt: lastResponseAtRef.current,
					appReady: selectIsReady(s),
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

			/* After first save, update the URL from /build/new → /build/{id} without
			 * triggering a navigation or remount. applyDataPart stores the ID on the builder. */
			if (type === "data-app-saved") {
				const appId = data.appId as string;
				applyDataPart(builderRef.current, type, data);
				window.history.replaceState({}, "", `/build/${appId}`);
				return;
			}

			applyDataPart(builderRef.current, type, data);
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
	const builder = useBuilderEngine();
	const inReplayMode = useBuilderStore(selectInReplayMode);
	/** Replay messages — written by ReplayController, read here. Both
	 *  communicate through the store, not through a shared parent. */
	const replayMessages = useBuilderStore((s) => s.replayMessages);

	// ── Stable ref for builder so Chat callbacks always read the latest ────
	const builderRef = useRef(builder);
	builderRef.current = builder;
	const runIdRef = useRef<string | undefined>(undefined);
	/** ISO timestamp of the SA's last response — used to determine if the
	 *  Anthropic prompt cache is still warm on subsequent requests. */
	const lastResponseAtRef = useRef<string | undefined>(undefined);

	// ── Chat instance — recreated when builder changes (new app) ─────────
	const prevBuilderRef = useRef(builder);
	const [chat, setChat] = useState(() =>
		createChatInstance(builderRef, runIdRef, lastResponseAtRef),
	);

	/* Detect builder identity change (new app via BuilderProvider). Clear
	 * stale local state from the previous app: run ID and the Chat instance. */
	if (builder !== prevBuilderRef.current) {
		prevBuilderRef.current = builder;
		runIdRef.current = undefined;
		lastResponseAtRef.current = undefined;
		setChat(createChatInstance(builderRef, runIdRef, lastResponseAtRef));
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

	/* Sync chat transport status → builder agent state (drives builder.isThinking).
	 * Also stamps lastResponseAtRef when the SA finishes so the route can
	 * determine if the Anthropic prompt cache is still warm on the next request. */
	useEffect(() => {
		const active = status === "submitted" || status === "streaming";
		const wasActive = builder.store.getState().agentActive;
		builder.setAgentActive(active);
		if (status === "ready" && wasActive) {
			lastResponseAtRef.current = new Date().toISOString();
		}
	}, [status, builder]);

	/* Surface stream-level errors from useChat (network, API key, server crash, spend cap).
	 * Only set generation error during Generating phase — Idle errors get a toast only.
	 * Reads phase and generationError from the store imperatively — they're not deps,
	 * just point-in-time checks when chatError fires. */
	useEffect(() => {
		if (!chatError) return;
		const message = parseApiErrorMessage(chatError.message);
		const s = builder.store.getState();
		if (s.phase === BuilderPhase.Generating && !s.generationError) {
			s.setGenerationError(message, "failed");
		}
		showToast("error", "Generation failed", message);
	}, [chatError, builder]);

	/* Persist the active conversation thread on each status=ready transition.
	 * Fire-and-forget via server action — a Firestore outage never blocks the UI. */
	const threadStartRef = useRef<string | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: builder read at fire time for appId
	useEffect(() => {
		if (status !== "ready" || messages.length === 0) return;
		const appId = builder.store.getState().appId;
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
