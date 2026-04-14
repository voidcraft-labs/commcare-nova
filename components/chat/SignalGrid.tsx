"use client";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef } from "react";
import { useBuilderEngine } from "@/hooks/useBuilder";
import type { EditScope } from "@/lib/services/builder";
import { assembleQuestions as assembleQuestionsForGrid } from "@/lib/services/normalizedState";
import { type QuestionPath, qpathId } from "@/lib/services/questionPath";
import { flatIndexById } from "@/lib/services/questionTree";
import { signalGrid } from "@/lib/signalGrid/store";
import type { SignalGridController } from "@/lib/signalGridController";

interface SignalGridProps {
	/** Controller instance — created and owned by the parent (ChatSidebar). */
	controller: SignalGridController;
	messages: UIMessage[];
}

export function SignalGrid({ controller, messages }: SignalGridProps) {
	const builder = useBuilderEngine();
	const builderRef = useRef(builder);
	builderRef.current = builder;
	/** Null on mount — the first effect records the baseline content length
	 *  without injecting energy, preventing a massive brightness spike from
	 *  all existing message content being treated as a delta on remount. */
	const prevContentLenRef = useRef<number | null>(null);

	const gridCallbackRef = useCallback(
		(el: HTMLDivElement | null) => {
			if (!el) return;
			controller.attach(el);
			controller.powerOn();

			const ro = new ResizeObserver(() => controller.resize());
			ro.observe(el);

			return () => {
				ro.disconnect();
				controller.detach();
			};
		},
		[controller],
	);

	useEffect(() => {
		const lastAssistant = findLastAssistant(messages);
		if (!lastAssistant) {
			prevContentLenRef.current = 0;
			return;
		}

		let contentLen = 0;
		let latestToolScope: EditScope | null = null;

		for (const part of lastAssistant.parts) {
			if ((part.type === "text" || part.type === "reasoning") && part.text) {
				contentLen += part.text.length;
			}
			if (
				part.type?.startsWith("tool-") &&
				"input" in part &&
				part.input != null
			) {
				contentLen += JSON.stringify(part.input).length;

				const input = part.input as Record<string, unknown>;
				if (typeof input.moduleIndex === "number") {
					latestToolScope = { moduleIndex: input.moduleIndex };
					if (typeof input.formIndex === "number") {
						latestToolScope.formIndex = input.formIndex;

						const rawRef = input.questionPath ?? input.questionId ?? input.path;
						const qRef = typeof rawRef === "string" ? rawRef : undefined;
						if (typeof qRef === "string" && qRef) {
							const s = builderRef.current.store.getState();
							const moduleId = s.moduleOrder[input.moduleIndex as number];
							const formId = moduleId
								? s.formOrder[moduleId]?.[input.formIndex as number]
								: undefined;
							if (formId) {
								const questions = assembleQuestionsForGrid(
									s.questions,
									s.questionOrder,
									formId,
								);
								if (questions.length > 0) {
									const bareId = qpathId(qRef as QuestionPath);
									const flatIdx = flatIndexById(questions, bareId);
									if (flatIdx >= 0) latestToolScope.questionIndex = flatIdx;
								}
							}
						}
					}
				}
			}
		}

		// On first run (mount/remount), record baseline without injecting energy.
		// Content generated while unmounted doesn't need a brightness burst -- the
		// headless tick was already advancing state from burst energy data parts.
		if (prevContentLenRef.current !== null) {
			const delta = contentLen - prevContentLenRef.current;
			if (delta > 0) {
				signalGrid.injectThinkEnergy(delta * 2);
			}
		}
		prevContentLenRef.current = contentLen;

		const { postBuildEdit, agentActive } = builder.store.getState();
		if (postBuildEdit && agentActive) {
			builder.setEditScope(latestToolScope);
			controller.setEditFocus(builder.computeEditFocus());
		}
	}, [messages, builder, controller]);

	return <div ref={gridCallbackRef} className="signal-grid" />;
}

function findLastAssistant(messages: UIMessage[]): UIMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
}
