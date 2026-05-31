"use client";
import type { FileUIPart } from "ai";
import {
	Attachment,
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

/** The pending-upload chip row, shown above the textarea while files are staged
 *  for the next send. Reads from PromptInput's own attachment state. */
function PendingAttachments() {
	const attachments = usePromptInputAttachments();
	if (attachments.files.length === 0) return null;
	return (
		<Attachments variant="inline">
			{attachments.files.map((file) => (
				<Attachment
					data={file}
					key={file.id}
					onRemove={() => attachments.remove(file.id)}
				>
					<AttachmentPreview />
					<AttachmentRemove />
				</Attachment>
			))}
		</Attachments>
	);
}

interface ChatInputProps {
	/** Send a turn. `files` are AI SDK `FileUIPart`s with data-URL payloads,
	 *  already converted by PromptInput; the server condenses large ones. */
	onSend: (message: { text: string; files?: FileUIPart[] }) => void;
	disabled?: boolean;
	/** Centered (Idle) layout vs docked sidebar — drives placeholder + chrome. */
	centered?: boolean;
}

/**
 * The chat composer, built on AI Elements `PromptInput`. PromptInput owns its own
 * text + attachment state and resets on submit, so this component is stateless: it
 * only shapes the submitted message into Nova's `onSend` contract and supplies the
 * attachment affordance. The model picker, web-search, and speech actions that
 * PromptInput can host are intentionally absent — the SA model is a fixed code
 * constant and there is no search/voice surface.
 */
export function ChatInput({ onSend, disabled, centered }: ChatInputProps) {
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
				"bg-nova-surface",
				// Docked sidebar gets a top divider; the centered card already has its
				// own border, so it only carries the violet focus emphasis.
				centered
					? "ring-1 ring-nova-violet/20 focus-within:ring-nova-violet/40"
					: "border-t border-nova-border",
			)}
			globalDrop
			maxFileSize={MAX_FILE_SIZE}
			maxFiles={MAX_FILES}
			multiple
			onSubmit={handleSubmit}
		>
			<PromptInputHeader>
				<PendingAttachments />
			</PromptInputHeader>
			<PromptInputBody>
				<PromptInputTextarea
					disabled={disabled}
					placeholder={
						centered
							? "Tell me about the app you want to build..."
							: "Ask for changes..."
					}
				/>
			</PromptInputBody>
			<PromptInputFooter>
				<PromptInputTools>
					<PromptInputActionMenu>
						<PromptInputActionMenuTrigger />
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
