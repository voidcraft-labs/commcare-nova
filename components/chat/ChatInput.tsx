"use client";
import { Icon } from "@iconify/react/offline";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	type PromptInputMessage,
	PromptInputProvider,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputController,
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
import { Button } from "@/components/shadcn/button";
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
import { useReconcilerContext } from "@/lib/collab/context";
import { useCreditBalance } from "@/lib/credits/useCreditBalance";
// `chargeAmount` is the single source of truth for what an action costs, the
// same pure rule the server credit gate charges, so the chip can never display
// a figure that disagrees with the real debit. Client-safe: every import in
// `creditPolicy` is type-only, so it pulls no server data layer into the bundle.
import { chargeAmount } from "@/lib/db/creditPolicy";
import { isDocumentKind } from "@/lib/domain/multimedia";
import {
	useAccessPhase,
	useAppId,
	useChatAppReady,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { showToast } from "@/lib/ui/toastStore";
import { cn } from "@/lib/utils";

function isChatAttachmentKind(
	kind: MediaAssetView["kind"],
): kind is AttachmentRef["kind"] {
	return (CHAT_ATTACHMENT_KINDS as readonly string[]).includes(kind);
}

/** Map a picked library asset to the wire ref the chat sends. The bytes never
 *  ride the request: only this id-keyed pointer, which the server resolves to
 *  the stored extract (documents) or image bytes (vision). */
function toAttachmentRef(asset: MediaAssetView): AttachmentRef {
	if (!isChatAttachmentKind(asset.kind)) {
		throw new Error(`Asset kind ${asset.kind} cannot be attached to chat.`);
	}
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
	/** The composer can't be typed in or submitted. Says nothing about WHY:
	 *  a turn may be in flight, or something else may simply own the screen. */
	disabled?: boolean;
	/** A turn is actually in flight, so the submit button shows a spinner. A
	 *  strict subset of `disabled`: locking the composer for a non-chat reason
	 *  (creating the starter) must not claim the user's message is being sent. */
	submitting?: boolean;
	/** True while an AskQuestionsCard is waiting for a reply: a composer send
	 *  routes to that card as a text-only answer, so attachments can't go with it.
	 *  Disables the attach button and preserves any staged files for the next
	 *  normal turn rather than dropping them. */
	answerPending?: boolean;
	/** Centered (Idle) card layout vs docked sidebar: drives the input chrome
	 *  (the docked variant gets a top divider). */
	centered?: boolean;
	/** True only for the opening prompt of a brand-new build (centered + nothing
	 *  sent yet). The instant the user sends, the placeholder switches from the
	 *  app description to a change request, before the layout finishes docking. */
	openingPrompt?: boolean;
	/** Reports whether a staged document is still being read (extracted). The
	 *  sidebar lifts this into the activity status so the pre-send wait
	 *  shows the same "Reading your documents" status as the post-send resolve,
	 *  instead of leaving the user with only the attachment chip. */
	onReadingChange?: (reading: boolean) => void;
	/** Build-scoped abort signal for staged documents' extraction reads. Owning
	 *  the read at the build level keeps it running after the chip unmounts on
	 *  send, while still aborting when the build is torn down. */
	extractionAbortSignal?: AbortSignal;
}

/**
 * The chat composer, built on AI Elements `PromptInput`. The typed draft lives
 * in `PromptInputProvider` so the textarea is controlled: the send gate and the
 * character counter derive from the same value the box displays, and no event
 * bookkeeping can let the two disagree (paste, drop, undo, any path that puts
 * text in the box enables the send). THIS component owns the staged
 * attachments: assets the user picks from the media library (file manager),
 * not files staged in the browser. The "+" opens the picker; picked assets
 * show as chips above the textarea and ride the next send as id refs. There is
 * no raw-file path: every attachment is a stored asset Nova reads via its
 * extract (or, for images, its bytes).
 */
export function ChatInput(props: ChatInputProps) {
	return (
		<PromptInputProvider>
			<ChatInputComposer {...props} />
		</PromptInputProvider>
	);
}

function ChatInputComposer({
	onSend,
	disabled,
	submitting,
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
	/** The one source of truth for the typed draft: the provider's controlled
	 *  value. Everything the footer needs is a pure derivation of it, so the
	 *  send gate is "is there content to send", never "did an event fire". */
	const { textInput } = usePromptInputController();
	const textLength = textInput.value.length;
	const hasText = textInput.value.trim().length > 0;
	const overLimit = textLength > MAX_CHAT_MESSAGE_CHARS;
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const reconcilerContext = useReconcilerContext();
	const scopeEpochRef = useRef(scopeEpoch);
	scopeEpochRef.current = scopeEpoch;
	const previousScopeEpochRef = useRef(scopeEpoch);
	const visiblePicked =
		previousScopeEpochRef.current === scopeEpoch ? picked : [];
	const ownsCurrentProjectScope = () =>
		accessPhase === "authorized" && scopeEpochRef.current === scopeEpoch;
	useEffect(() => {
		if (previousScopeEpochRef.current === scopeEpoch) return;
		previousScopeEpochRef.current = scopeEpoch;
		/* The provider owns the typed draft and remains mounted. Only stored
		 * Project asset handles and their portaled surfaces are discarded. */
		setPicked([]);
		setPickerOpen(false);
		setPreviewTarget(null);
	}, [scopeEpoch]);
	useEffect(
		() =>
			reconcilerContext?.subscribeProjectScopeReset((nextScopeEpoch) => {
				/* Disown callbacks synchronously with the boundary. Extraction and
				 * upload promises may settle before React commits the epoch render. */
				scopeEpochRef.current = nextScopeEpoch;
				setPicked([]);
				setPickerOpen(false);
				setPreviewTarget(null);
			}),
		[reconcilerContext],
	);

	/* Cost-chip data: mirror the server's charge exactly. `useChatAppReady` is
	 * the same derivation `ChatContainer`'s request fields use, and it tracks
	 * the server's app-row-status rule through the session store's
	 * `buildUnfinished` latch: a mid-build send (a paused askQuestions round,
	 * a re-drive) shows the build rate even though the committed modules make
	 * the phase read Ready. `useBuilderIsReady` deliberately does NOT carry
	 * that latch (it answers "is there a usable blueprint", which is true
	 * mid-build), so the chip must not use it. `chargeAmount` owns the
	 * amounts: never hardcode 100/5 here. */
	const appReady = useChatAppReady();
	/* Land chat-attached documents in THIS app's Project so the conversation
	 * resolves them under the same Project (see `resolveAttachments`). */
	const appId = useAppId();
	const cost = chargeAmount(appReady);
	/* Best-effort balance for the tooltip's "credits left this month" line; a null
	 * summary simply omits that line. Default-enabled: the builder always renders
	 * behind auth, so the fetch can't race sign-in here. */
	const { summary } = useCreditBalance();

	const addPicked = (asset: MediaAssetView) => {
		const callbackScopeEpoch = scopeEpoch;
		if (scopeEpochRef.current !== callbackScopeEpoch) return;
		setPicked((cur) =>
			cur.some((a) => a.id === asset.id) ? cur : [...cur, asset],
		);
	};
	const removePicked = (assetId: string) => {
		const callbackScopeEpoch = scopeEpoch;
		if (scopeEpochRef.current !== callbackScopeEpoch) return;
		setPicked((cur) => cur.filter((a) => a.id !== assetId));
	};
	// Eager extraction finishes AFTER a document is staged, so the snapshot picked
	// here has no title/summary yet. When the chip's badge reports completion, fold
	// the fresh extract back in, so the chip preview shows the title/summary right
	// away (not only after a library re-fetch) and the ref sent on submit carries
	// them too (`toAttachmentRef` reads `asset.extract`).
	const reconcileExtract = (assetId: string, extract: ExtractMeta) => {
		const callbackScopeEpoch = scopeEpoch;
		if (scopeEpochRef.current !== callbackScopeEpoch) return;
		setPicked((cur) =>
			cur.map((a) => (a.id === assetId ? { ...a, extract } : a)),
		);
	};

	// A staged document is "reading" until its extract settles. Derived from
	// `picked` (not the chip badges): a freshly staged doc has no extract yet, and
	// the badge's `onExtracted` folds a ready OR failed terminal status back in via
	// `reconcileExtract`, so once every staged doc is ready/failed, this clears.
	// Reported up so the sidebar can show the "Reading your documents" status.
	const reading = visiblePicked.some(
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
	// runs (it resets the textarea immediately): otherwise the over-limit paste
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

	const handleSubmit = (message: PromptInputMessage): boolean | undefined => {
		/* PromptInput can dispatch a queued submit in the synchronous reset stack,
		 * before React supplies new access props. The registry advances this ref
		 * immediately; returning false keeps the draft in the box for the send
		 * the user will retry once the surface settles. */
		if (!ownsCurrentProjectScope() || disabled) return false;
		const text = (message.text ?? "").trim();
		// Require typed text to send: a staged attachment alone never sends an
		// empty turn (the SA reads an attachment as context for a request, not as
		// the request itself). The disabled submit button covers the click path;
		// this guards every other submit route.
		if (!text) return false;
		if (answerPending) {
			// This send answers a waiting question card (text-only). Forward the
			// text and KEEP the staged attachments: they're not part of an answer,
			// but they shouldn't vanish; they ride the next normal turn.
			onSend({ text });
			return;
		}
		const attachments = visiblePicked.map(toAttachmentRef);
		onSend({
			text,
			attachments: attachments.length > 0 ? attachments : undefined,
		});
		// PromptInput clears the draft after we return; we clear the staged
		// attachments.
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
					// needs no ring/fill: just padding, plus a top divider when docked.
					"p-3",
					centered ? "" : "border-t border-nova-border",
				)}
				onSubmit={handleSubmit}
			>
				<ChatAttachmentBar
					assets={visiblePicked}
					onRemove={removePicked}
					onExtracted={reconcileExtract}
					extractionAbortSignal={extractionAbortSignal}
					onPreview={(asset) => {
						if (!ownsCurrentProjectScope()) return;
						setPreviewTarget({
							id: asset.id,
							kind: asset.kind,
							filename: asset.displayName ?? asset.originalFilename,
							title: asset.extract?.title,
							summary: asset.extract?.summary,
						});
					}}
				/>
				<PromptInputBody>
					<PromptInputTextarea
						disabled={disabled}
						onKeyDown={handleTextareaKeyDown}
						/* The opening prompt sits directly under a heading that
						 * already asks what you would like to build, so this names
						 * the box instead of asking the same question twice. */
						placeholder={
							openingPrompt
								? "Describe your app"
								: "What would you like to change?"
						}
					/>
				</PromptInputBody>
				<PromptInputFooter>
					<PromptInputTools>
						{/* Attach from the file manager. Disabled while a turn is in
						 *  flight (staging something you can't yet send reads as broken)
						 *  AND while a question card is awaiting a reply: that send is a
						 *  text-only answer, so an attachment couldn't ride it anyway. */}
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										type="button"
										variant="ghost"
										size="icon"
										onClick={() => {
											if (ownsCurrentProjectScope()) setPickerOpen(true);
										}}
										disabled={disabled || answerPending}
										aria-label="Attach a file"
										className="text-nova-text-muted"
									>
										<Icon icon={tablerPaperclip} className="size-4" />
									</Button>
								}
							/>
							<TooltipContent>Attach a file</TooltipContent>
						</Tooltip>
					</PromptInputTools>
					{/* Counter + cost chip + submit grouped on the right. The counter is
					 *  hidden until the text nears the limit; the cost chip is a calm,
					 *  informational hint of what this turn will spend (muted, not a
					 *  semantic warning: it informs, it doesn't alarm; the number is
					 *  `chargeAmount(appReady)`, so it tracks the real charge exactly).
					 *  The submit is disabled when the text is empty (a staged attachment
					 *  alone can't send) or over the limit (the text is never truncated:
					 *  only sending is blocked). While a turn is in flight the whole input
					 *  is disabled (Nova shows progress in the activity status, not a stop
					 *  button), so the submit shows the spinner. */}
					<div className="flex items-center gap-2">
						<CharCounter length={textLength} max={MAX_CHAT_MESSAGE_CHARS} />
						<Tooltip>
							<TooltipTrigger render={<CreditAmount value={cost} />} />
							<TooltipContent>
								{appReady
									? `Edits use ${cost} credits. Clarifying questions are free.`
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
							status={submitting ? "submitted" : "ready"}
							className="size-11 rounded-xl"
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
				onOpenChange={(open) => {
					if (!open || ownsCurrentProjectScope()) setPickerOpen(open);
				}}
				kinds={CHAT_ATTACHMENT_KINDS}
				appId={appId}
				onPick={(selection) => {
					if (selection.kind === "uploaded") addPicked(selection.asset);
				}}
				// Let the file manager warn before deleting a file that's staged as a
				// chip here, and drop the chip when it's deleted: otherwise the chip
				// would dangle, pointing at bytes that no longer exist.
				attachedAssetIds={visiblePicked.map((a) => a.id)}
				onAssetDeleted={removePicked}
			/>
			<AssetPreviewDialog
				target={accessPhase === "authorized" ? previewTarget : null}
				onOpenChange={(open) => {
					if (!open) setPreviewTarget(null);
				}}
			/>
		</>
	);
}
