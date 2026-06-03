"use client";
import { Icon } from "@iconify/react/offline";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import { useState } from "react";
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
import type { MediaAssetView } from "@/components/builder/media/mediaClient";
import { ChatAttachmentBar } from "@/components/chat/ChatAttachmentBar";
import {
	type AttachmentRef,
	CHAT_ATTACHMENT_KINDS,
} from "@/lib/chat/attachmentRefs";
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
}

/**
 * The chat composer, built on AI Elements `PromptInput`. PromptInput owns its own
 * text state and resets on submit; THIS component owns the staged attachments —
 * assets the user picks from the media library (file manager), not files staged
 * in the browser. The "+" opens the picker; picked assets show as chips above the
 * textarea and ride the next send as id refs. There is no raw-file path: every
 * attachment is a stored asset the assistant reads via its extract (or, for
 * images, its bytes).
 */
export function ChatInput({
	onSend,
	disabled,
	answerPending,
	centered,
	openingPrompt,
}: ChatInputProps) {
	/** Assets staged for the next send (picked from the file manager). */
	const [picked, setPicked] = useState<MediaAssetView[]>([]);
	/** File-manager dialog open state. */
	const [pickerOpen, setPickerOpen] = useState(false);
	/** Asset currently shown in the preview dialog (`null` = closed). */
	const [previewTarget, setPreviewTarget] = useState<AssetPreviewTarget | null>(
		null,
	);

	const addPicked = (asset: MediaAssetView) =>
		setPicked((cur) =>
			cur.some((a) => a.id === asset.id) ? cur : [...cur, asset],
		);
	const removePicked = (assetId: string) =>
		setPicked((cur) => cur.filter((a) => a.id !== assetId));

	const handleSubmit = (message: PromptInputMessage) => {
		const text = (message.text ?? "").trim();
		if ((!text && picked.length === 0) || disabled) return;
		if (answerPending) {
			// This send answers a waiting question card (text-only). Forward just
			// the text and KEEP the staged attachments — they're not part of an
			// answer, but they shouldn't vanish; they ride the next normal turn.
			if (text) onSend({ text });
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
					onPreview={(asset) =>
						setPreviewTarget({
							id: asset.id,
							kind: asset.kind,
							filename: asset.displayName ?? asset.originalFilename,
						})
					}
				/>
				<PromptInputBody>
					<PromptInputTextarea
						disabled={disabled}
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
						<button
							type="button"
							onClick={() => setPickerOpen(true)}
							disabled={disabled || answerPending}
							aria-label="Attach a file"
							title="Attach a file"
							className="flex size-8 cursor-pointer items-center justify-center rounded-md text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright disabled:cursor-default disabled:opacity-50"
						>
							<Icon icon={tablerPaperclip} className="size-4" />
						</button>
					</PromptInputTools>
					{/* While a turn is in flight the whole input is disabled (Nova shows
					 *  progress on the signal grid, not a stop button), so the submit
					 *  reflects that as the in-flight spinner. */}
					<PromptInputSubmit
						disabled={disabled}
						status={disabled ? "submitted" : "ready"}
					/>
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
