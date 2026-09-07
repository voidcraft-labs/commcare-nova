"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

interface AskQuestionsInput {
	header: string;
	questions: {
		question: string;
		options: { label: string; description?: string }[];
	}[];
}

interface AskQuestionsCardProps {
	toolCallId: string;
	input: AskQuestionsInput;
	state: string;
	output?: Record<string, string>;
	addToolOutput: (params: {
		tool: string;
		toolCallId: string;
		output: unknown;
	}) => void;
	pendingAnswerRef?: React.MutableRefObject<((text: string) => void) | null>;
	disabled?: boolean;
}

export function AskQuestionsCard({
	toolCallId,
	input,
	state,
	output,
	addToolOutput,
	pendingAnswerRef,
	disabled = false,
}: AskQuestionsCardProps) {
	const [currentIndex, setCurrentIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<string, string>>({});

	// Refs for stable closure in the pending answer handler
	const stateRef = useRef({ currentIndex, answers });
	stateRef.current = { currentIndex, answers };

	const questions = input?.questions ?? [];
	const answeredLocally =
		questions.length > 0 && currentIndex >= questions.length;
	const isWaiting = state === "input-available" && !answeredLocally;
	const isComplete = state === "output-available" || answeredLocally;
	/* A round whose turn failed before it was answered: the claw-back keeps
	 * the failed turn's partial in the transcript and closes its dangling
	 * tool calls as `output-error`, so this card renders as an ended round,
	 * never as a skeleton forever loading. */
	const isInterrupted = state === "output-error";
	const displayAnswers = state === "output-available" ? output || {} : answers;
	const isLoading = !isWaiting && !isComplete && !isInterrupted;

	/**
	 * Stable ID map for questions within this tool call. Questions arrive from
	 * the SA without intrinsic IDs: the `toolCallId` is globally unique, and
	 * questions within a tool call are immutable (never reordered/removed).
	 * IDs are assigned once on first observation and stored in this ref.
	 */
	const questionIds = useRef<string[]>([]);
	while (questionIds.current.length < questions.length) {
		questionIds.current.push(crypto.randomUUID());
	}

	/** Apply an answer keyed by the current question index. Questions are
	 * immutable after the SA emits them: index is a stable identity key. */
	const applyAnswer = useCallback(
		(answerText: string) => {
			const { answers: ans, currentIndex: ci } = stateRef.current;
			if (disabled || state !== "input-available" || ci >= questions.length)
				return;
			const newAnswers = { ...ans, [String(ci)]: answerText };
			const nextIdx = ci + 1;
			// Retire this question synchronously before publishing. A second activation
			// may arrive before React commits the completed card.
			stateRef.current = { answers: newAnswers, currentIndex: nextIdx };
			setAnswers(newAnswers);
			setCurrentIndex(nextIdx);
			if (nextIdx === questions.length) {
				addToolOutput({ tool: "askQuestions", toolCallId, output: newAnswers });
			}
		},
		[addToolOutput, disabled, questions.length, state, toolCallId],
	);

	// Only the committed, active card owns the composer's typed-answer route.
	useLayoutEffect(() => {
		if (!pendingAnswerRef || !isWaiting || disabled) return;
		const handler = (text: string) => applyAnswer(`User Responded: ${text}`);
		pendingAnswerRef.current = handler;
		return () => {
			if (pendingAnswerRef.current === handler) pendingAnswerRef.current = null;
		};
	}, [applyAnswer, disabled, isWaiting, pendingAnswerRef]);

	return (
		<div
			data-question-card={
				isWaiting
					? "waiting"
					: isComplete
						? "done"
						: isInterrupted
							? "interrupted"
							: "loading"
			}
		>
			<div className="rounded-xl border border-nova-violet/20 bg-nova-violet/5 overflow-hidden">
				{/* Header */}
				<div className="px-3.5 py-2.5 border-b border-nova-violet/10">
					{isLoading ? (
						<span className="text-xs font-medium text-nova-violet-bright">
							Loading questions…
						</span>
					) : (
						isWaiting && (
							<span className="text-xs font-medium text-nova-violet-bright">
								Question {currentIndex + 1} of {questions.length}
							</span>
						)
					)}
					<p className="text-sm font-medium text-nova-text-secondary mt-0.5">
						{input?.header || "A few questions"}
					</p>
				</div>

				{/* Questions */}
				<div className="px-3.5 py-3 space-y-3">
					{isLoading && (
						<div className="space-y-2.5 animate-pulse">
							{/* Question text skeleton */}
							<div className="h-4 w-3/4 rounded-sm bg-nova-violet/10" />
							{/* Option skeletons */}
							<div className="space-y-1.5">
								<div className="h-10 w-full rounded-lg border border-nova-border bg-nova-surface/50" />
								<div className="h-10 w-full rounded-lg border border-nova-border bg-nova-surface/50" />
								<div className="h-10 w-full rounded-lg border border-nova-border bg-nova-surface/50" />
							</div>
						</div>
					)}
					{isInterrupted && (
						<div className="space-y-2">
							{questions.map((q, i) => (
								<p
									key={questionIds.current[i]}
									className="text-sm text-nova-text-muted"
								>
									{q.question}
								</p>
							))}
						</div>
					)}
					{questions.map((q, i) => {
						const answer = displayAnswers[String(i)];
						const isCurrent = isWaiting && i === currentIndex;
						const isPast = i < currentIndex;
						const isFuture = isWaiting && i > currentIndex;

						if (isFuture) return null;

						return (
							<div key={questionIds.current[i]}>
								{/* Answered question */}
								{(isComplete || isPast) && answer && (
									<div className="flex items-start gap-2 text-xs">
										<Icon
											icon={tablerCheck}
											width="14"
											height="14"
											className="mt-0.5 shrink-0"
											style={{ color: "var(--nova-emerald)" }}
										/>
										<div>
											<span className="text-nova-text-muted">{q.question}</span>
											<span className="ml-1.5 text-nova-text">{answer}</span>
										</div>
									</div>
								)}

								{/* Active question with options */}
								{isCurrent && (
									<AnimatePresence mode="wait">
										<motion.div
											key={questionIds.current[i]}
											initial={{ opacity: 0, y: 8 }}
											animate={{ opacity: 1, y: 0 }}
											exit={{ opacity: 0, y: -8 }}
											transition={{ duration: 0.2 }}
										>
											<p className="text-sm text-nova-text mb-2.5">
												{q.question}
											</p>
											<div className="space-y-1.5">
												{q.options.map((opt) => (
													<motion.button
														key={opt.label}
														whileHover={{ scale: 1.01 }}
														whileTap={{ scale: 0.99 }}
														onClick={() => {
															if (stateRef.current.currentIndex === i)
																applyAnswer(opt.label);
														}}
														disabled={disabled}
														className="w-full text-left px-3 py-2 rounded-lg border border-nova-border bg-nova-surface not-disabled:hover:border-nova-violet/40 not-disabled:hover:bg-nova-violet/5 transition-colors not-disabled:cursor-pointer disabled:opacity-60"
													>
														<div className="text-sm text-nova-text">
															{opt.label}
														</div>
														{opt.description && (
															<div className="text-xs text-nova-text-muted mt-0.5">
																{opt.description}
															</div>
														)}
													</motion.button>
												))}
											</div>
										</motion.div>
									</AnimatePresence>
								)}
							</div>
						);
					})}
				</div>

				{/* Footer */}
				{isWaiting && (
					<div className="px-3.5 py-2 border-t border-nova-violet/10">
						<span className="text-xs text-nova-text-muted">
							{(questions[currentIndex]?.options.length ?? 0) > 0
								? "or type your answer below"
								: "Type your answer below"}
						</span>
					</div>
				)}
				{isInterrupted && (
					<div className="px-3.5 py-2 border-t border-nova-violet/10">
						<span className="text-xs text-nova-text-muted">
							This question round ended before it was answered
						</span>
					</div>
				)}
			</div>
		</div>
	);
}
