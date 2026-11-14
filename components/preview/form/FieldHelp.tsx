"use client";

import { Icon } from "@iconify/react/offline";
import tablerHelpCircle from "@iconify-icons/tabler/help-circle";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerX from "@iconify-icons/tabler/x";
import { useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogTitle,
} from "@/components/shadcn/dialog";
import type { ProseTemplate } from "@/lib/domain";
import type { Media } from "@/lib/domain/multimedia";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { LabelContent } from "@/lib/references/LabelContent";
import { usePreviewPlatformRules } from "@/lib/session/hooks";

interface FieldHelpProps {
	id?: string;
	help: ProseTemplate | undefined;
	resolvedHelp?: string;
	helpMedia: Media | undefined;
	/** The help text shows as typed (`lib/domain/plainText.ts::helpShowsAsTyped`):
	 *  its question holds `plainHelp`, or its form's text formatting is off.
	 *  Edit mode then shows it as written; the running preview follows the
	 *  platform's `plainHelp` rule. */
	asTyped?: boolean;
	/** False in edit mode, where help shows inline; true in the running
	 *  preview, where it plays each runtime's button and dialog. */
	interactive: boolean;
	/** The question's label text, which names the help dialog for a screen
	 *  reader (neither runtime's dialog draws a title). */
	questionLabel?: string;
	/** Where the running form mounts the button: Web Apps puts it at the end
	 *  of the label line, Android right-aligned under the question. A mount
	 *  for the other platform renders nothing, so a caller can mount both. */
	placement?: "label" | "below";
}

/**
 * A field's help text and help media.
 *
 * **Edit mode** renders both inline and muted, so the author sees the help
 * they write. Help is not inline-editable in the form (it's edited in the
 * field panel), so it needs no `TextEditable` wrapper. Returns `null` when
 * the field has neither, so a caller can mount it unconditionally.
 *
 * **The running preview** plays the runtime it runs as, a help button and a
 * dialog (`lib/preview/platform.ts`, `help` and `helpMediaWithoutText`):
 *
 * - Web Apps draws a question-mark button at the end of the label line, only
 *   when the question has help text (`form_entry/question.html` renders help
 *   media inside the help text's own block), and its modal holds the help
 *   and a close button.
 * - Android draws an info button right-aligned under the question when it
 *   has help text or help media alone (`FormEntryPrompt.hasHelp`), and its
 *   dialog holds the help and an OK button
 *   (`QuestionWidget.java::fireHelpText`).
 *
 * Neither runtime's dialog has a title, so the dialog's title holds the
 * question's label for a screen reader only. Help renders through the label
 * rendering of the runtime. A help text shown as typed writes no markdown
 * form: Android then draws it as written, and Web Apps formats it anyway
 * (`lib/preview/platform.ts`, `plainHelp`).
 */
export function FieldHelp({
	id,
	help,
	resolvedHelp,
	helpMedia,
	asTyped = false,
	interactive,
	questionLabel,
	placement,
}: FieldHelpProps) {
	if (!help && !helpMedia) return null;
	if (!interactive)
		return (
			<div id={id} className="space-y-1.5">
				{help && (
					<LabelContent
						label={help}
						resolvedLabel={resolvedHelp}
						isEditMode
						plainLabel={asTyped}
						className="text-xs text-nova-text-muted"
					/>
				)}
				<MediaDisplay media={helpMedia} interactive={false} />
			</div>
		);
	return (
		<RunningFieldHelp
			help={help}
			resolvedHelp={resolvedHelp}
			helpMedia={helpMedia}
			asTyped={asTyped}
			questionLabel={questionLabel}
			placement={placement}
		/>
	);
}

function RunningFieldHelp({
	help,
	resolvedHelp,
	helpMedia,
	asTyped,
	questionLabel,
	placement,
}: {
	help: ProseTemplate | undefined;
	resolvedHelp?: string;
	helpMedia: Media | undefined;
	asTyped: boolean;
	questionLabel?: string;
	placement?: "label" | "below";
}) {
	const rules = usePreviewPlatformRules();
	const { language } = useBuilderLanguage();
	const [open, setOpen] = useState(false);
	const webApps = rules.help === "label-icon";
	if ((placement === "label") !== webApps) return null;
	if (!help && rules.helpMediaWithoutText === "hidden") return null;
	const showHelp = runtimeMessage(language, "showHelp");
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<div className={webApps ? "inline-flex shrink-0" : "flex justify-end"}>
				<button
					type="button"
					aria-label={showHelp}
					onClick={() => setOpen(true)}
					className="nova-focusable inline-flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-lg text-pv-accent-bright transition-colors not-disabled:hover:bg-white/5"
				>
					<Icon
						icon={webApps ? tablerHelpCircle : tablerInfoCircle}
						width="18"
						height="18"
						aria-hidden="true"
					/>
				</button>
			</div>
			<DialogContent showCloseButton={false}>
				<DialogTitle className="sr-only">
					{questionLabel ?? showHelp}
				</DialogTitle>
				{webApps ? (
					<DialogClose
						aria-label={runtimeMessage(language, "close")}
						className="nova-focusable absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-lg text-nova-text-secondary transition-colors hover:text-nova-text"
					>
						<Icon icon={tablerX} width="16" height="16" aria-hidden="true" />
					</DialogClose>
				) : null}
				<DialogBody className="space-y-3 pr-11">
					{help && (
						<LabelContent
							label={help}
							resolvedLabel={resolvedHelp}
							isEditMode={false}
							rendering={rules.labelMarkdown}
							plainLabel={asTyped && rules.plainHelp === "literal"}
							className="text-sm text-nova-text"
						/>
					)}
					<MediaDisplay media={helpMedia} interactive />
				</DialogBody>
				{webApps ? null : (
					<DialogFooter>
						<DialogClose className="nova-focusable inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium text-pv-accent-bright transition-colors hover:bg-white/5">
							{runtimeMessage(language, "ok")}
						</DialogClose>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
