"use client";
import type { FileUIPart } from "ai";
import {
	Attachment,
	AttachmentInfo,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "@/components/ai-elements/attachments";
import {
	PromptInput,
	PromptInputActionAddAttachments,
	PromptInputActionMenu,
	PromptInputActionMenuContent,
	PromptInputActionMenuTrigger,
	PromptInputBody,
	PromptInputFooter,
	PromptInputHeader,
	type PromptInputMessage,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { showToast } from "@/lib/ui/toastStore";
import { cn } from "@/lib/utils";

/** File types the SA can actually consume: text/markdown/csv + images + PDF are
 *  read natively (Anthropic) or condensed by Haiku; docx/xlsx are converted to
 *  markdown server-side. Everything else is rejected at the picker so the server
 *  transform only ever sees this closed set. */
const ACCEPT = ".txt,.md,.csv,.pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx";

/** Per-file and per-turn ceilings — the first line of defense for the base64
 *  payload that rides in the request body (the server enforces its own ceiling
 *  behind this). */
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Friendly, Elm-style messages for PromptInput's file-validation rejections.
 *  Without surfacing these, a rejected attachment silently vanishes (no chip),
 *  which reads as "nothing happened" — the same dead-end as an unhandled accept
 *  mismatch. Keyed by PromptInput's `onError` codes. */
const ATTACHMENT_ERROR_MESSAGES: Record<string, string> = {
	accept:
		"That file type isn't supported. Attach a PDF, image, text, Markdown, CSV, Word, or Excel file.",
	max_file_size:
		"That file is over the 10 MB limit. Try a smaller file, or split it into parts.",
	max_files:
		"You can attach up to 5 files at once — remove one before adding another.",
	duplicate: "That file is already attached.",
};

/** The pending-upload chip row, shown above the textarea while files are staged
 *  for the next send. Renders the PromptInputHeader (and thus its padding) only
 *  when files exist — an empty header would otherwise leave a gutter above the
 *  textarea. Reads from PromptInput's own attachment state. */
function PendingAttachments() {
	const attachments = usePromptInputAttachments();
	if (attachments.files.length === 0) return null;
	return (
		<PromptInputHeader>
			<Attachments variant="inline">
				{attachments.files.map((file) => (
					<Attachment
						className={cn(
							// Armed for two-stage Backspace removal: "press Backspace again
							// to remove this". Uses Nova's destructive color (nova-rose) — a
							// thin ring + soft fill that reads as "pending removal" and is
							// distinct from the textbox's violet focus ring (a matching violet
							// ring read as a focus state and clashed). Solid token, not
							// /opacity — Tailwind v4 doesn't resolve a var-based ring color
							// with an opacity modifier.
							file.id === attachments.armedRemoveId &&
								"bg-nova-rose/10 ring-1 ring-nova-rose",
						)}
						data={file}
						key={file.id}
						onRemove={() => attachments.remove(file.id)}
					>
						<AttachmentPreview />
						<AttachmentInfo />
						<AttachmentRemove />
					</Attachment>
				))}
			</Attachments>
		</PromptInputHeader>
	);
}

interface ChatInputProps {
	/** Send a turn. `files` are AI SDK `FileUIPart`s with data-URL payloads,
	 *  already converted by PromptInput; the server condenses large ones. */
	onSend: (message: { text: string; files?: FileUIPart[] }) => void;
	disabled?: boolean;
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
 * text + attachment state and resets on submit, so this component is stateless: it
 * only shapes the submitted message into Nova's `onSend` contract and supplies the
 * attachment affordance. The model picker, web-search, and speech actions that
 * PromptInput can host are intentionally absent — the SA model is a fixed code
 * constant and there is no search/voice surface.
 */
export function ChatInput({
	onSend,
	disabled,
	centered,
	openingPrompt,
}: ChatInputProps) {
	const handleSubmit = (message: PromptInputMessage) => {
		const text = (message.text ?? "").trim();
		const hasFiles = message.files.length > 0;
		if ((!text && !hasFiles) || disabled) return;
		onSend({ text, files: message.files });
	};

	return (
		<PromptInput
			accept={ACCEPT}
			className={cn(
				// Pad so the rounded input floats inside its container. The InputGroup
				// already carries the border + violet focus ring; without padding its
				// rounded corners + ring sit flush against the centered card's
				// rounded-2xl overflow-hidden edge and get cropped. So the form itself
				// needs no ring/fill — just padding, plus a top divider when docked.
				"p-3",
				centered ? "" : "border-t border-nova-border",
			)}
			globalDrop
			maxFileSize={MAX_FILE_SIZE}
			maxFiles={MAX_FILES}
			multiple
			onError={(err) =>
				showToast(
					"warning",
					"Couldn't attach file",
					ATTACHMENT_ERROR_MESSAGES[err.code] ?? err.message,
				)
			}
			onSubmit={handleSubmit}
		>
			<PendingAttachments />
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
					{/* Disabled in lockstep with the textarea + submit while a turn is
					 *  in flight — staging an attachment you can't yet send (the whole
					 *  composer is locked one-turn-at-a-time) reads as broken. */}
					<PromptInputActionMenu>
						<PromptInputActionMenuTrigger disabled={disabled} />
						<PromptInputActionMenuContent>
							<PromptInputActionAddAttachments />
						</PromptInputActionMenuContent>
					</PromptInputActionMenu>
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
	);
}
