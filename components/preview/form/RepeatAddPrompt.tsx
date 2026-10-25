/**
 * RepeatAddPrompt: Android's repeat prompt, as Preview running as Android
 * plays it (`lib/preview/platform.ts`, `repeatAdd`).
 *
 * Stepping Next past the last entry of a repeat the worker adds to, or past
 * the repeat when it has none, Android asks whether to add an entry
 * (`activities/FormEntryActivityUIController.java::createRepeatDialog`):
 * Go back, the add choice ("Add a new {label}?" before the first entry,
 * "Add another {label}?" after, `FormEntryCaption.getRepeatText`), and Do
 * not add, which reads "Do not add, I'm finished" when nothing follows the
 * repeat. Add opens the new entry's first screen; Do not add moves on; Go
 * back stays on the screen before the prompt. The pager owns the prompt
 * (`useFormPaging`); this draws it, in the worker's language.
 */
"use client";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { useEngineStateAt } from "@/lib/preview/hooks/useEngineState";
import { usePresentationField } from "@/lib/preview/hooks/useVisibleFieldOrder";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import type { OpenRepeatPrompt } from "./sections/useFormPaging";

export function RepeatAddPrompt({
	prompt,
	onAdd,
	onDecline,
	onGoBack,
}: {
	readonly prompt: OpenRepeatPrompt | null;
	readonly onAdd: () => void;
	readonly onDecline: () => void;
	readonly onGoBack: () => void;
}) {
	return (
		<AlertDialog
			open={prompt !== null}
			onOpenChange={(open) => {
				if (!open) onGoBack();
			}}
		>
			{prompt !== null ? (
				<RepeatAddPromptContent
					prompt={prompt}
					onAdd={onAdd}
					onDecline={onDecline}
					onGoBack={onGoBack}
				/>
			) : null}
		</AlertDialog>
	);
}

function RepeatAddPromptContent({
	prompt,
	onAdd,
	onDecline,
	onGoBack,
}: {
	readonly prompt: OpenRepeatPrompt;
	readonly onAdd: () => void;
	readonly onDecline: () => void;
	readonly onGoBack: () => void;
}) {
	const { language } = useBuilderLanguage();
	const field = usePresentationField(prompt.point.repeatUuid);
	const state = useEngineStateAt(
		prompt.point.repeatUuid,
		prompt.point.repeatPath,
	);
	const projectProse = useProseProjection();
	const label =
		state.resolvedLabel ??
		(field !== undefined && "label" in field && field.label
			? projectProse(field.label)
			: runtimeMessage(language, "entry"));
	const addChoice = runtimeMessage(
		language,
		prompt.point.entryCount === 0 ? "repeatAddNew" : "repeatAddAnother",
		{ label },
	);
	return (
		<AlertDialogContent>
			<AlertDialogHeader>
				<AlertDialogTitle>{addChoice}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogFooter className="flex-wrap">
				<Button type="button" variant="outline" onClick={onGoBack}>
					{runtimeMessage(language, "repeatGoBack")}
				</Button>
				<Button type="button" variant="outline" onClick={onDecline}>
					{runtimeMessage(
						language,
						prompt.nothingFollows ? "repeatDoNotAddFinish" : "repeatDoNotAdd",
					)}
				</Button>
				<Button type="button" onClick={onAdd}>
					{addChoice}
				</Button>
			</AlertDialogFooter>
		</AlertDialogContent>
	);
}
