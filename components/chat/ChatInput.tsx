"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerCoinFilled from "@iconify-icons/tabler/coin-filled";
import { useCallback, useRef, useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useCreditBalance } from "@/lib/credits/useCreditBalance";
// `chargeAmount` is the single source of truth for what an action costs — the
// same pure rule the server credit gate charges — so the chip can never display
// a figure that disagrees with the real debit. Client-safe: every import in
// `creditPolicy` is type-only, so it pulls no Firestore into the bundle.
import { chargeAmount } from "@/lib/db/creditPolicy";
import { useBuilderIsReady } from "@/lib/session/hooks";

interface ChatInputProps {
	onSend: (message: string) => void;
	disabled?: boolean;
	centered?: boolean;
}

export function ChatInput({ onSend, disabled, centered }: ChatInputProps) {
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	/* The displayed cost mirrors the actual charge. `useBuilderIsReady` is the
	 * exact `appReady` flag `ChatContainer` already puts on the /api/chat request
	 * body (true once the blueprint is Ready/Completed → an edit; false during a
	 * fresh build), so deriving the chip from the same predicate guarantees the
	 * number the user sees before sending equals what the server debits. We never
	 * hardcode 100/5 here — `chargeAmount` owns those amounts. */
	const appReady = useBuilderIsReady();
	const cost = chargeAmount(appReady);

	/* Best-effort balance for the tooltip's "credits left this month" line; a
	 * null summary simply omits that line. Default-enabled — the builder always
	 * renders behind auth, so the fetch can't race sign-in here. */
	const { summary } = useCreditBalance();

	const handleSubmit = useCallback(() => {
		if (!value.trim() || disabled) return;
		onSend(value.trim());
		setValue("");
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
	}, [value, disabled, onSend]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	const handleInput = () => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
		}
	};

	return (
		<div className="border-t border-nova-border p-3">
			<div
				className={`flex items-center bg-nova-surface border border-nova-border rounded-lg transition-shadow ${centered ? "ring-1 ring-nova-violet/20 focus-within:ring-nova-violet/40" : "focus-within:border-nova-violet"}`}
			>
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						handleInput();
					}}
					onKeyDown={handleKeyDown}
					placeholder={
						centered
							? "Tell me about the app you want to build..."
							: "Ask for changes..."
					}
					disabled={disabled}
					rows={1}
					autoComplete="off"
					data-1p-ignore
					className={`flex-1 resize-none bg-transparent border-none text-sm text-nova-text placeholder:text-nova-text-muted focus:outline-none disabled:opacity-50 ${centered ? "px-4 py-3" : "px-3 py-2"}`}
				/>
				{/* Cost chip — a calm, informational hint of what this action will
				 * spend, shown before the user commits. Deliberately muted (not a
				 * semantic warning color): it informs, it doesn't alarm. The number
				 * is `chargeAmount(appReady)`, so it tracks the real charge exactly. */}
				<Tooltip
					content={
						<div className="space-y-0.5">
							<p>
								{appReady
									? `Edits use ${cost} credits — clarifying questions are free.`
									: `This build will use ${cost} credits.`}
							</p>
							{summary && (
								<p className="text-nova-text-muted">
									You have {summary.balance.toLocaleString()} credits left this
									month.
								</p>
							)}
						</div>
					}
				>
					<span className="shrink-0 flex items-center gap-1 pl-1 text-[11px] tabular-nums text-nova-text-muted select-none">
						<Icon icon={tablerCoinFilled} width={13} height={13} />
						{cost}
					</span>
				</Tooltip>
				<button
					type="button"
					onClick={handleSubmit}
					disabled={!value.trim() || disabled}
					className="shrink-0 p-2 mr-1 text-nova-violet-bright hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
				>
					<Icon icon={tablerArrowRight} width="16" height="16" />
				</button>
			</div>
		</div>
	);
}
