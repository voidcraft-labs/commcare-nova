"use client";
import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useId, useRef, useState } from "react";
import { type CaptureField, fieldRegistry } from "@/lib/domain";
import {
	captureAcceptAttribute,
	MAX_CAPTURE_BYTES,
} from "@/lib/domain/captureFormats";
import type { FieldState } from "@/lib/preview/engine/types";
import { useEditMode } from "@/lib/session/hooks";
import {
	AttachmentRejected,
	discardAttachment,
	type StagedAttachment,
	stageAttachment,
} from "./attachmentClient";
import { SignaturePad } from "./SignaturePad";

/**
 * A capture question in the running preview.
 *
 * ## What this deliberately does NOT show
 *
 * No thumbnail, no playback, no way to reopen the file. That is not a gap
 * — it is what CommCare Web Apps shows. `entry_file.html` is a Browse
 * button, a filename text node, and a Clear button; there is no `<img>`,
 * no `<audio>`, no `<video>`, and Formplayer declares no route that serves
 * a staged capture back (`FormController` has one GET mapping,
 * `URL_GET_INSTANCE`). Nova's preview runs its own engine and COULD render
 * a thumbnail, which is exactly why it must not: an author who lays out a
 * form against a preview that confirms attachments would ship a form whose
 * workers cannot.
 *
 * The filename shown after attaching is this page's knowledge, not the
 * form's. On the real runtime it lives in `form_ui.js`'s in-memory
 * `fileNameCache` and does not survive a page load; here it lives in
 * component state and does not survive one either. Both tell the worker
 * the same truth for the same duration.
 *
 * ## Wording
 *
 * Every string says "attach". Web Apps has no camera, microphone, or
 * recorder anywhere in cloudcare — the file input binds `accept` and
 * nothing else, with no `capture` attribute — so every kind but signature
 * opens the OS file picker. A phone's picker may offer its camera; that is
 * the phone's menu, not something this app can request.
 */
interface AttachmentFieldProps {
	readonly field: CaptureField;
	readonly state: FieldState;
	/** Concrete engine path — carries the repeat index, so a replace
	 *  targets exactly one instance. Absent only on an edit-mode row, which
	 *  never reaches the live control. */
	readonly path: string | undefined;
	readonly appId: string | undefined;
	readonly entryKey: string | undefined;
	readonly onChange: (value: string) => void;
	readonly onBlur: () => void;
}

export function AttachmentField({
	field,
	state,
	path,
	appId,
	entryKey,
	onChange,
	onBlur,
}: AttachmentFieldProps) {
	const isEdit = useEditMode() === "edit";
	const { icon, label } = fieldRegistry[field.kind];

	if (isEdit) {
		// Authoring view: a static card. The author is arranging structure,
		// not collecting data, and staging real bytes from the canvas would
		// mint attachments nobody submits.
		return (
			<div className="flex items-center gap-3 rounded-lg border border-dashed border-pv-input-border bg-pv-surface px-4 py-3">
				<Icon
					icon={icon}
					width="20"
					height="20"
					aria-hidden="true"
					className="text-nova-violet-bright"
				/>
				<span className="text-sm text-nova-text-muted">{label}</span>
			</div>
		);
	}

	return (
		<AttachmentControl
			field={field}
			state={state}
			path={path}
			appId={appId}
			entryKey={entryKey}
			onChange={onChange}
			onBlur={onBlur}
		/>
	);
}

function AttachmentControl({
	field,
	state,
	path,
	appId,
	entryKey,
	onChange,
	onBlur,
}: AttachmentFieldProps) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [staged, setStaged] = useState<StagedAttachment | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const stage = useCallback(
		async (file: File) => {
			if (!appId || !entryKey || !path) {
				setError(
					"This form isn't ready to take attachments yet. Wait a moment and try again.",
				);
				return;
			}
			setError(undefined);
			setBusy(true);
			try {
				const next = await stageAttachment({
					appId,
					entryKey,
					fieldUuid: field.uuid,
					instancePath: path,
					file,
				});
				// Replace: drop the previous attachment only AFTER the new one is
				// confirmed, so a failed upload leaves the old answer intact.
				// The real runtime does the opposite — `FormSession::saveMediaAnswer`
				// deletes the old file before the new value commits — which is how
				// a rejected commit there strands a dangling reference.
				const previous = staged;
				setStaged(next);
				onChange(next.attachmentName);
				if (previous) {
					void discardAttachment({
						appId,
						attachmentId: previous.attachmentId,
					});
				}
			} catch (err) {
				setError(
					err instanceof AttachmentRejected
						? err.message
						: "That attachment couldn't be saved. Check your connection and try again.",
				);
			} finally {
				setBusy(false);
				onBlur();
			}
		},
		[appId, entryKey, field.uuid, path, staged, onChange, onBlur],
	);

	const clear = useCallback(() => {
		// Answer first, bytes second. The reverse order is the upstream defect
		// this lane exists beside: on a device, clearing a REQUIRED capture
		// removes the file and leaves the question still naming it.
		const previous = staged;
		setStaged(undefined);
		setError(undefined);
		onChange("");
		if (inputRef.current) inputRef.current.value = "";
		if (previous && appId) {
			void discardAttachment({ appId, attachmentId: previous.attachmentId });
		}
		onBlur();
	}, [appId, staged, onChange, onBlur]);

	const hasAnswer = state.value !== "";
	const showError = state.touched && !state.valid;

	return (
		<div className="space-y-2">
			{field.kind === "signature" ? (
				<SignaturePad
					uploading={busy}
					hasAnswer={hasAnswer}
					onDrawn={(file) => void stage(file)}
					onClear={clear}
				/>
			) : (
				<div className="flex items-center gap-2">
					<input
						ref={inputRef}
						id={inputId}
						type="file"
						className="sr-only"
						accept={captureAcceptAttribute(field.kind)}
						disabled={busy}
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void stage(file);
						}}
					/>
					{/* A label styled as the control, so the 48px target and the
					    keyboard focus ring belong to the real input. */}
					<label
						htmlFor={inputId}
						className="inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-md border border-pv-input-border bg-pv-surface px-4 text-sm font-medium text-nova-text transition-colors hover:border-pv-input-focus focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-pv-input-focus has-disabled:cursor-default has-disabled:opacity-40"
					>
						<Icon
							icon={tablerPaperclip}
							width="16"
							height="16"
							aria-hidden="true"
						/>
						{busy ? "Attaching…" : hasAnswer ? "Replace file" : "Attach file"}
					</label>
					{hasAnswer ? (
						<button
							type="button"
							onClick={clear}
							disabled={busy}
							className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-md p-2 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text disabled:opacity-40"
						>
							<Icon icon={tablerX} width="16" height="16" aria-hidden="true" />
							<span className="sr-only">Remove attachment</span>
						</button>
					) : null}
				</div>
			)}

			{/* The whole confirmation a worker gets: a name, or nothing. Matches
			    `entry_file.html`'s `fileNameDisplay`. */}
			<p className="text-xs text-nova-text-muted">
				{hasAnswer
					? (staged?.originalFilename ?? "File attached")
					: "No file attached."}
			</p>

			{error ? (
				<p className="flex items-start gap-1.5 text-xs text-nova-red">
					<Icon
						icon={tablerAlertTriangle}
						width="14"
						height="14"
						aria-hidden="true"
						className="mt-0.5 shrink-0"
					/>
					{error}
				</p>
			) : null}

			{showError && !error ? (
				<p className="text-xs text-nova-red">
					{state.errorMessage ?? "This question needs an attachment."}
				</p>
			) : null}

			<p className="text-xs text-nova-text-muted/70">
				Up to {Math.floor(MAX_CAPTURE_BYTES / 1_000_000)} MB.
			</p>
		</div>
	);
}
