"use client";
import { Icon } from "@iconify/react/offline";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	type PromptInputMessage,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
	AssetPreviewDialog,
	type AssetPreviewTarget,
} from "@/components/builder/media/AssetPreviewDialog";
import { MediaPickerDialog } from "@/components/builder/media/MediaPickerDialog";
import type {
	ExtractMeta,
	MediaAssetView,
} from "@/components/builder/media/mediaClient";
import { CharCounter } from "@/components/chat/CharCounter";
import { ChatAttachmentBar } from "@/components/chat/ChatAttachmentBar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import { CreditAmount } from "@/components/ui/CreditAmount";
import {
	type AttachmentRef,
	CHAT_ATTACHMENT_KINDS,
} from "@/lib/chat/attachmentRefs";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/chat/limits";
import { useCreditBalance } from "@/lib/credits/useCreditBalance";
// `chargeAmount` is the single source of truth for what an action costs — the
// same pure rule the server credit gate charges — so the chip can never display
// a figure that disagrees with the real debit. Client-safe: every import in
// `creditPolicy` is type-only, so it pulls no Firestore into the bundle.
import { chargeAmount } from "@/lib/db/creditPolicy";
import { isDocumentKind } from "@/lib/domain/multimedia";
import { useBuilderIsReady } from "@/lib/session/hooks";
import { showToast } from "@/lib/ui/toastStore";
import { cn } from "@/lib/utils";

/** Map a picked library asset to the wire ref the chat sends. The bytes never
 *  ride the request — only this id-keyed pointer, which the server resolves to
 *  the stored extract (documents) or image bytes (vision). */
function toAttachmentRef(asset: MediaAssetView): AttachmentRef {
	return {
		assetId: asset.id,
		kind: asset.kind,
		filename: asset.displayName ?? asset.originalFilename,
		mimeType: asset.mimeType,
		// Snapshot the extract's header metadata so the transcript chip's preview
		// has it in-band (no fetch). Absent when the doc wasn't extracted yet.
		...(asset.extract?.title && { title: asset.extract.title }),
		...(asset.extract?.summary && { summary: asset.extract.summary }),
	};
}

interface ChatInputProps {
	/** Send a turn. `attachments` are asset-id refs to files the user picked from
	 *  the file manager; the server resolves each to its extract or image bytes. */
	onSend: (message: { text: string; attachments?: AttachmentRef[] }) => void;
	disabled?: boolean;
	/** True while an AskQuestionsCard is waiting for a reply: a composer send
	 *  routes to that card as a text-only answer, so attachments can't go with it.
	 *  Disables the attach button and preserves any staged files for the next
	 *  normal turn rather than dropping them. */
	answerPending?: boolean;
	/** Centered (Idle) card layout vs docked sidebar — drives the input chrome
	 *  (the docked variant gets a top divider). */
	centered?: boolean;
	/** True only for the opening prompt of a brand-new build (centered + nothing
	 *  sent yet). Drives the placeholder: the "tell me about the app" framing
	 *  fits only before the first send — the instant the user sends, it flips to
	 *  the "ask for changes" copy, well before the layout finishes docking. */
	openingPrompt?: boolean;
	/** Reports whether a staged DOCUMENT is still being read (extracted). The
	 *  sidebar lifts this into the signal panel so the (up to ~1 min) pre-send wait
	 *  shows the same "Reading your documents" status as the post-send resolve,
	 *  instead of leaving the user staring at a lone "Reading…" chip. */
	onReadingChange?: (reading: boolean) => void;
	/** Build-scoped abort signal for staged docs' extraction reads. Owning the
	 *  read at the build level (not the chip) keeps it streaming into the grid after
	 *  the chip unmounts on send — so the read never goes dark mid-extraction —
	 *  while still aborting when the build is torn down. */
	extractionAbortSignal?: AbortSignal;
}

/**
 * The chat composer, built on AI Elements `PromptInput`. PromptInput owns its own
 * text state and resets on submit; THIS component owns the staged attachments —
 * assets the user picks from the media library (file manager), not files staged
 * in the browser. The "+" opens the picker; picked assets show as chips above the
 * textarea and ride the next send as id refs. There is no raw-file path: every
 * attachment is a stored asset Nova reads via its extract (or, for images, its
 * bytes).
 */
export function ChatInput({
	onSend,
	disabled,
	answerPending,
	centered,
	openingPrompt,
	onReadingChange,
	extractionAbortSignal,
}: ChatInputProps) {
	/** Assets staged for the next send (picked from the file manager). */
	const [picked, setPicked] = useState<MediaAssetView[]>([]);
	/** File-manager dialog open state. */
	const [pickerOpen, setPickerOpen] = useState(false);
	/** Asset currently shown in the preview dialog (`null` = closed). */
	const [previewTarget, setPreviewTarget] = useState<AssetPreviewTarget | null>(
		null,
	);
	/** Live shadow of the typed text — PromptInput owns the textarea value; we
	 *  mirror only what the footer needs: its length (counter + over-limit gate)
	 *  and whether it holds any non-whitespace (`hasText`, the require-text send
	 *  gate — so a staged attachment alone can't send an empty turn). */
	const [textLength, setTextLength] = useState(0);
	const [hasText, setHasText] = useState(false);
	const overLimit = textLength > MAX_CHAT_MESSAGE_CHARS;

	/* Cost-chip data — mirror the server's charge exactly. `useBuilderIsReady` is
	 * the same `appReady` flag `ChatContainer` puts on the /api/chat request body
	 * (true once the blueprint is Ready/Completed → an edit; false during a fresh
	 * build), so the number shown before sending equals what the server debits.
	 * `chargeAmount` owns the amounts — never hardcode 100/5 here. */
	const appReady = useBuilderIsReady();
	const cost = chargeAmount(appReady);
	/* Best-effort balance for the tooltip's "credits left this month" line; a null
	 * summary simply omits that line. Default-enabled — the builder always renders
	 * behind auth, so the fetch can't race sign-in here. */
	const { summary } = useCreditBalance();

	const addPicked = (asset: MediaAssetView) =>
		setPicked((cur) =>
			cur.some((a) => a.id === asset.id) ? cur : [...cur, asset],
		);
	const removePicked = (assetId: string) =>
		setPicked((cur) => cur.filter((a) => a.id !== assetId));
	// Eager extraction finishes AFTER a document is staged, so the snapshot picked
	// here has no title/summary yet. When the chip's badge reports completion, fold
	// the fresh extract back in — so the chip preview shows the title/summary right
	// away (not only after a library re-fetch) and the ref sent on submit carries
	// them too (`toAttachmentRef` reads `asset.extract`).
	const reconcileExtract = (assetId: string, extract: ExtractMeta) =>
		setPicked((cur) =>
			cur.map((a) => (a.id === assetId ? { ...a, extract } : a)),
		);

	// A staged document is "reading" until its extract settles. Derived from
	// `picked` (not the chip badges): a freshly staged doc has no extract yet, and
	// the badge's `onExtracted` folds a ready OR failed terminal status back in via
	// `reconcileExtract` — so once every staged doc is ready/failed, this clears.
	// Reported up so the sidebar can show the "Reading your documents" signal.
	const reading = picked.some(
		(a) =>
			isDocumentKind(a.kind) &&
			a.extract?.status !== "ready" &&
			a.extract?.status !== "failed",
	);
	const onReadingChangeRef = useRef(onReadingChange);
	onReadingChangeRef.current = onReadingChange;
	useEffect(() => {
		onReadingChangeRef.current?.(reading);
	}, [reading]);
	// Reset the signal on unmount (e.g. switching to read-only) so it can't stick on.
	useEffect(() => () => onReadingChangeRef.current?.(false), []);

	// Block the Enter-to-send when over the limit BEFORE PromptInput's submit
	// runs (it resets the textarea immediately) — otherwise the over-limit paste
	// the user needs to trim would be wiped, the exact UX we're avoiding. The
	// disabled submit button covers the click path; this covers the keyboard one.
	// Shift+Enter (newline) and IME composition are never blocked.
	const handleTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			e.key === "Enter" &&
			!e.shiftKey &&
			!e.nativeEvent.isComposing &&
			overLimit
		) {
			e.preventDefault();
			showToast(
				"warning",
				"Message too long",
				`Trim to ${MAX_CHAT_MESSAGE_CHARS.toLocaleString()} characters to send.`,
			);
		}
	};

	const handleSubmit = (message: PromptInputMessage) => {
		// PromptInput resets the textarea on every submit it processes; mirror that
		// in the text shadow (form.reset() doesn't fire onChange). (Over-limit
		// submits never reach here — they're blocked at the keydown + the disabled
		// button, so their text isn't reset.)
		setTextLength(0);
		setHasText(false);
		const text = (message.text ?? "").trim();
		// Require typed text to send — a staged attachment alone never sends an
		// empty turn (the SA reads an attachment as context for a request, not as
		// the request itself). The disabled submit button covers the click path;
		// this guards every other submit route.
		if (!text || disabled) return;
		if (answerPending) {
			// This send answers a waiting question card (text-only). Forward the
			// text and KEEP the staged attachments — they're not part of an answer,
			// but they shouldn't vanish; they ride the next normal turn.
			onSend({ text });
			return;
		}
		const attachments = picked.map(toAttachmentRef);
		onSend({
			text,
			attachments: attachments.length > 0 ? attachments : undefined,
		});
		// PromptInput clears its own text; we clear the staged attachments.
		setPicked([]);
	};

	return (
		<>
			<PromptInput
				className={cn(
					// Pad so the rounded input floats inside its container. The InputGroup
					// already carries the border + violet focus ring; without padding its
					// rounded corners + ring sit flush against the centered card's
					// rounded-2xl overflow-hidden edge and get cropped. So the form itself
					// needs no ring/fill — just padding, plus a top divider when docked.
					"p-3",
					centered ? "" : "border-t border-nova-border",
				)}
				onSubmit={handleSubmit}
			>
				<ChatAttachmentBar
					assets={picked}
					onRemove={removePicked}
					onExtracted={reconcileExtract}
					extractionAbortSignal={extractionAbortSignal}
					onPreview={(asset) =>
						setPreviewTarget({
							id: asset.id,
							kind: asset.kind,
							filename: asset.displayName ?? asset.originalFilename,
							title: asset.extract?.title,
							summary: asset.extract?.summary,
						})
					}
				/>
				<PromptInputBody>
					<PromptInputTextarea
						disabled={disabled}
						onChange={(e) => {
							const { value } = e.target;
							setTextLength(value.length);
							setHasText(value.trim().length > 0);
						}}
						onKeyDown={handleTextareaKeyDown}
						placeholder={
							openingPrompt
								? "Tell me about the app you want to build..."
								: "Ask for changes..."
						}
					/>
				</PromptInputBody>
				<PromptInputFooter>
					<PromptInputTools>
						{/* Attach from the file manager. Disabled while a turn is in
						 *  flight (staging something you can't yet send reads as broken)
						 *  AND while a question card is awaiting a reply — that send is a
						 *  text-only answer, so an attachment couldn't ride it anyway. */}
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										onClick={() => setPickerOpen(true)}
										disabled={disabled || answerPending}
										aria-label="Attach a file"
										className="flex size-11 cursor-pointer items-center justify-center rounded-lg text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright disabled:cursor-default disabled:opacity-50"
									>
										<Icon icon={tablerPaperclip} className="size-4" />
									</button>
								}
							/>
							<TooltipContent>Attach a file</TooltipContent>
						</Tooltip>
					</PromptInputTools>
					{/* Counter + cost chip + submit grouped on the right. The counter is
					 *  hidden until the text nears the limit; the cost chip is a calm,
					 *  informational hint of what this turn will spend (muted, not a
					 *  semantic warning — it informs, it doesn't alarm; the number is
					 *  `chargeAmount(appReady)`, so it tracks the real charge exactly).
					 *  The submit is disabled when the text is empty (a staged attachment
					 *  alone can't send) or over the limit (the text is never truncated —
					 *  only sending is blocked). While a turn is in flight the whole input
					 *  is disabled (Nova shows progress on the signal grid, not a stop
					 *  button), so the submit shows the spinner. */}
					<div className="flex items-center gap-2">
						<CharCounter length={textLength} max={MAX_CHAT_MESSAGE_CHARS} />
						<Tooltip>
							<TooltipTrigger render={<CreditAmount value={cost} />} />
							<TooltipContent>
								{appReady
									? `Edits use ${cost} credits — clarifying questions are free.`
									: `This build will use ${cost} credits.`}
								{summary && (
									<span className="mt-0.5 block text-nova-text-muted">
										You have {summary.balance.toLocaleString()} credits left
										this month.
									</span>
								)}
							</TooltipContent>
						</Tooltip>
						<PromptInputSubmit
							disabled={disabled || overLimit || !hasText}
							status={disabled ? "submitted" : "ready"}
							className="size-11 rounded-lg"
						/>
					</div>
				</PromptInputFooter>
			</PromptInput>

			{/* The file manager + the preview dialog live OUTSIDE the form (both
			 *  portal to the body anyway), so their internal buttons can't submit
			 *  the composer. The picker only offers chat-attachable kinds; the
			 *  preview opens from a staged chip. */}
			<MediaPickerDialog
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				kinds={CHAT_ATTACHMENT_KINDS}
				onPick={addPicked}
				// Let the file manager warn before deleting a file that's staged as a
				// chip here, and drop the chip when it's deleted — otherwise the chip
				// would dangle, pointing at bytes that no longer exist.
				attachedAssetIds={picked.map((a) => a.id)}
				onAssetDeleted={removePicked}
			/>
			<AssetPreviewDialog
				target={previewTarget}
				onOpenChange={(open) => {
					if (!open) setPreviewTarget(null);
				}}
			/>
		</>
	);
}
