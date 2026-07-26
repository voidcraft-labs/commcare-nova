"use client";
import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type CaptureField, fieldRegistry } from "@/lib/domain";
import {
	captureAcceptAttribute,
	MAX_CAPTURE_BYTES,
} from "@/lib/domain/captureFormats";
import type { FieldState } from "@/lib/preview/engine/types";
import { useEditMode } from "@/lib/session/hooks";
import {
	AttachmentRejected,
	type AttachmentTaskContext,
	cancelAttachmentTask,
	discardAttachment,
	forgetOwnedStagedAttachment,
	getAttachmentSlotPath,
	getOwnedStagedAttachment,
	isAttachmentTaskAbort,
	registerAttachmentSlotPath,
	rememberOwnedStagedAttachment,
	runAttachmentTask,
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
 * `fileNameCache` and does not survive a page load; here it lives in the
 * entry/slot ownership registry and likewise does not survive one. Keeping it
 * above this component matters because relevance and Preview/Edit can remount
 * the control without ending the form entry.
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
	readonly attachmentSlotKey?: string | undefined;
	readonly questionLabelId?: string | undefined;
	readonly questionLabel?: string | undefined;
	readonly onChange: (value: string) => void;
	readonly onBlur: () => void;
	readonly onChangeAt?: ((path: string, value: string) => void) | undefined;
	readonly onBlurAt?: ((path: string) => void) | undefined;
}

export function AttachmentField({
	field,
	state,
	path,
	appId,
	entryKey,
	attachmentSlotKey,
	questionLabelId,
	questionLabel,
	onChange,
	onBlur,
	onChangeAt,
	onBlurAt,
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
			attachmentSlotKey={attachmentSlotKey}
			questionLabelId={questionLabelId}
			questionLabel={questionLabel}
			onChange={onChange}
			onBlur={onBlur}
			onChangeAt={onChangeAt}
			onBlurAt={onBlurAt}
		/>
	);
}

function AttachmentControl({
	field,
	state,
	path,
	appId,
	entryKey,
	attachmentSlotKey,
	questionLabelId,
	questionLabel,
	onChange,
	onBlur,
	onChangeAt,
	onBlurAt,
}: AttachmentFieldProps) {
	const inputId = useId();
	const actionId = useId();
	const statusId = useId();
	const errorId = useId();
	const validationId = useId();
	const helpId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const accessibleQuestionLabel =
		questionLabel ?? field.label ?? fieldRegistry[field.kind].label;
	const slotKey = attachmentSlotKey ?? path ?? field.uuid;
	const initialOwned =
		appId && entryKey
			? getOwnedStagedAttachment({
					appId,
					entryKey,
					slotKey,
				})
			: undefined;
	const stagedRef = useRef<StagedAttachment | undefined>(initialOwned);
	const maintenanceTaskSequenceRef = useRef(0);
	const previousAnswerValueRef = useRef(state.value);
	const [staged, setStaged] = useState<StagedAttachment | undefined>(
		initialOwned,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const ownershipScopeRef = useRef({ appId, entryKey, slotKey });

	useEffect(() => {
		const previous = ownershipScopeRef.current;
		if (
			previous.appId === appId &&
			previous.entryKey === entryKey &&
			previous.slotKey === slotKey
		)
			return;
		ownershipScopeRef.current = { appId, entryKey, slotKey };
		const owned =
			appId && entryKey
				? getOwnedStagedAttachment({
						appId,
						entryKey,
						slotKey,
					})
				: undefined;
		stagedRef.current = owned;
		setStaged(owned);
		setBusy(false);
		setError(undefined);
	}, [appId, entryKey, slotKey]);

	useEffect(() => {
		if (!appId || !entryKey || !path) return;
		registerAttachmentSlotPath({
			appId,
			entryKey,
			slotKey,
			instancePath: path,
		});
	}, [appId, entryKey, path, slotKey]);

	const currentPath = useCallback((): string | undefined => {
		if (!appId || !entryKey) return path;
		return (
			getAttachmentSlotPath({
				appId,
				entryKey,
				slotKey,
			}) ?? path
		);
	}, [appId, entryKey, path, slotKey]);

	const changeCurrent = useCallback(
		(value: string): void => {
			const targetPath = currentPath();
			if (targetPath !== undefined && onChangeAt !== undefined) {
				onChangeAt(targetPath, value);
				return;
			}
			onChange(value);
		},
		[currentPath, onChange, onChangeAt],
	);

	const blurCurrent = useCallback((): void => {
		const targetPath = currentPath();
		if (targetPath !== undefined && onBlurAt !== undefined) {
			onBlurAt(targetPath);
			return;
		}
		onBlur();
	}, [currentPath, onBlur, onBlurAt]);

	const stageWithinTask = useCallback(
		async (file: File, context: AttachmentTaskContext): Promise<void> => {
			const uploadPath = currentPath();
			if (!appId || !entryKey || !uploadPath) {
				const unavailable = new AttachmentRejected(
					"This form isn't ready to take attachments yet. Wait a moment and try again.",
				);
				setError(unavailable.message);
				throw unavailable;
			}
			setError(undefined);
			setBusy(true);
			try {
				const next = await stageAttachment({
					appId,
					entryKey,
					fieldUuid: field.uuid,
					instancePath: uploadPath,
					file,
					signal: context.signal,
				});
				if (!context.isCurrent()) {
					await discardAttachment({
						appId,
						attachmentId: next.attachmentId,
					}).catch(() => undefined);
					return;
				}
				// Replace only after the new generation confirms. Ownership lives
				// at entry/slot scope, above this component's render lifetime.
				const previous = stagedRef.current;
				stagedRef.current = next;
				rememberOwnedStagedAttachment({
					appId,
					entryKey,
					slotKey,
					instancePath: uploadPath,
					attachment: next,
				});
				setStaged(next);
				changeCurrent(next.attachmentName);
				if (
					previous !== undefined &&
					previous.attachmentId !== next.attachmentId
				) {
					await discardAttachment({
						appId,
						attachmentId: previous.attachmentId,
						signal: context.signal,
					}).catch(() => undefined);
				}
			} catch (err) {
				if (!context.isCurrent() || isAttachmentTaskAbort(err)) throw err;
				setError(
					err instanceof AttachmentRejected
						? err.message
						: "That attachment couldn't be saved. Check your connection and try again.",
				);
				throw err;
			} finally {
				if (context.isCurrent()) {
					setBusy(false);
					blurCurrent();
				}
			}
		},
		[
			appId,
			entryKey,
			field.uuid,
			slotKey,
			currentPath,
			changeCurrent,
			blurCurrent,
		],
	);

	const stage = useCallback(
		async (file: File) => {
			if (!entryKey || currentPath() === undefined) {
				setError(
					"This form isn't ready to take attachments yet. Wait a moment and try again.",
				);
				return;
			}
			await runAttachmentTask({
				entryKey,
				slotKey,
				task: (context) => stageWithinTask(file, context),
			}).catch((err: unknown) => {
				if (!isAttachmentTaskAbort(err)) {
					setBusy(false);
					blurCurrent();
				}
			});
		},
		[entryKey, slotKey, currentPath, stageWithinTask, blurCurrent],
	);

	const clear = useCallback(() => {
		const owned =
			appId && entryKey
				? forgetOwnedStagedAttachment({
						appId,
						entryKey,
						slotKey,
					})
				: undefined;
		const previous = owned ?? stagedRef.current;
		stagedRef.current = undefined;
		setStaged(undefined);
		setBusy(false);
		setError(undefined);
		if (inputRef.current) inputRef.current.value = "";
		if (entryKey) cancelAttachmentTask(entryKey, slotKey);
		if (appId && entryKey) {
			// Clear is its own queued operation rather than another generation
			// of the upload path. A file picked immediately afterward must wait
			// for this answer-clear, not abort it and resurrect the old answer
			// when the replacement later fails.
			const clearTaskKey = `$nova-clear$${slotKey}:${++maintenanceTaskSequenceRef.current}`;
			void runAttachmentTask({
				entryKey,
				slotKey: clearTaskKey,
				task: async ({ signal }) => {
					// Answer first, bytes second. The reverse order is the
					// upstream defect this lane exists beside: on a device,
					// clearing a REQUIRED capture removes the file and leaves
					// the question still naming it.
					changeCurrent("");
					if (previous !== undefined) {
						await discardAttachment({
							appId,
							attachmentId: previous.attachmentId,
							signal,
						}).catch(() => undefined);
					}
					blurCurrent();
				},
			}).catch((err: unknown) => {
				if (!isAttachmentTaskAbort(err)) {
					setError(
						"That attachment couldn't be cleared. Check your connection and try again.",
					);
				}
			});
			return;
		}

		changeCurrent("");
		if (previous && appId) {
			void discardAttachment({
				appId,
				attachmentId: previous.attachmentId,
			}).catch(() => undefined);
		}
		blurCurrent();
	}, [appId, entryKey, slotKey, changeCurrent, blurCurrent]);

	// Engine reset and repeat removal own the answer, so mirror an externally
	// cleared value into local filename/busy state and cancel any late upload.
	useEffect(() => {
		const previousValue = previousAnswerValueRef.current;
		previousAnswerValueRef.current = state.value;
		if (state.value !== "") {
			if (stagedRef.current === undefined && appId && entryKey) {
				const owned = getOwnedStagedAttachment({
					appId,
					entryKey,
					slotKey,
				});
				if (owned !== undefined) {
					stagedRef.current = owned;
					setStaged(owned);
				}
			}
			return;
		}
		if (previousValue === "" || stagedRef.current === undefined) {
			return;
		}
		const previous =
			appId && entryKey
				? (forgetOwnedStagedAttachment({
						appId,
						entryKey,
						slotKey,
					}) ?? stagedRef.current)
				: stagedRef.current;
		stagedRef.current = undefined;
		setStaged(undefined);
		setBusy(false);
		setError(undefined);
		if (inputRef.current) inputRef.current.value = "";
		if (entryKey) cancelAttachmentTask(entryKey, slotKey);
		if (previous !== undefined && appId !== undefined) {
			void discardAttachment({
				appId,
				attachmentId: previous.attachmentId,
			}).catch(() => undefined);
		}
	}, [appId, entryKey, slotKey, state.value]);

	const hasAnswer = state.value !== "";
	const showError = state.touched && !state.valid;
	const describedBy = [
		statusId,
		error ? errorId : undefined,
		showError && !error ? validationId : undefined,
		helpId,
	]
		.filter((id): id is string => id !== undefined)
		.join(" ");

	return (
		<div className="space-y-2">
			{field.kind === "signature" ? (
				<SignaturePad
					entryKey={entryKey ?? ""}
					instancePath={path ?? ""}
					slotKey={slotKey}
					questionLabelId={questionLabelId}
					questionLabel={accessibleQuestionLabel}
					uploading={busy}
					hasAnswer={hasAnswer}
					onDrawn={stageWithinTask}
					onClear={clear}
					onEncodingError={(message) => setError(message)}
				/>
			) : (
				<div className="flex items-center gap-2">
					{/* A label styled as the control, so the 48px target and the
					    keyboard focus ring belong to the real input. */}
					<label
						htmlFor={inputId}
						aria-disabled={busy}
						className={`relative inline-flex min-h-12 items-center gap-2 overflow-hidden rounded-md border border-pv-input-border bg-pv-surface px-4 text-sm font-medium text-nova-text transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-pv-input-focus ${
							busy
								? "cursor-default opacity-40"
								: "cursor-pointer hover:border-pv-input-focus"
						}`}
					>
						<input
							ref={inputRef}
							id={inputId}
							type="file"
							className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
							accept={captureAcceptAttribute(field.kind)}
							disabled={busy}
							aria-label={
								questionLabelId
									? undefined
									: `${accessibleQuestionLabel}. ${
											busy
												? "Attaching"
												: hasAnswer
													? "Replace file"
													: "Attach file"
										}`
							}
							aria-labelledby={
								questionLabelId ? `${questionLabelId} ${actionId}` : undefined
							}
							aria-describedby={describedBy}
							autoComplete="off"
							data-1p-ignore
							onChange={(e) => {
								const file = e.target.files?.[0];
								// A file input suppresses `change` when the same path is
								// picked twice. Reset immediately so a rejected upload can
								// be retried without choosing a different file first.
								e.currentTarget.value = "";
								if (file) void stage(file);
							}}
						/>
						<Icon
							icon={tablerPaperclip}
							width="16"
							height="16"
							aria-hidden="true"
						/>
						<span id={actionId}>
							{busy ? "Attaching…" : hasAnswer ? "Replace file" : "Attach file"}
						</span>
					</label>
					{hasAnswer ? (
						<button
							type="button"
							onClick={clear}
							disabled={busy}
							className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-md p-2 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text disabled:opacity-40"
						>
							<Icon icon={tablerX} width="16" height="16" aria-hidden="true" />
							<span className="sr-only">
								Remove attachment for {accessibleQuestionLabel}
							</span>
						</button>
					) : null}
				</div>
			)}

			{/* The whole confirmation a worker gets: a name, or nothing. Matches
			    `entry_file.html`'s `fileNameDisplay`. */}
			<p
				id={statusId}
				role="status"
				aria-label={`${accessibleQuestionLabel} attachment status`}
				aria-live="polite"
				className="text-xs text-nova-text-muted"
			>
				{busy
					? field.kind === "signature"
						? "Saving signature…"
						: "Attaching file…"
					: hasAnswer
						? (staged?.originalFilename ?? "File attached")
						: "No file attached."}
			</p>

			{error ? (
				<p
					id={errorId}
					role="alert"
					className="flex items-start gap-1.5 text-xs text-nova-red"
				>
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
				<p id={validationId} role="alert" className="text-xs text-nova-red">
					{state.errorMessage ?? "This question needs an attachment."}
				</p>
			) : null}

			<p id={helpId} className="text-xs text-nova-text-muted/70">
				Up to {Math.floor(MAX_CAPTURE_BYTES / 1_000_000)} MB.
			</p>
		</div>
	);
}
