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
import { useCanEdit, useEditMode } from "@/lib/session/hooks";
import { useOptionalBuilderSessionApi } from "@/lib/session/provider";
import {
	AttachmentRejected,
	type AttachmentSlotDraft,
	type AttachmentSlotIssue,
	type AttachmentTaskContext,
	cancelAttachmentSlotWork,
	cancelAttachmentTask,
	clearAttachmentSlotDraft,
	clearAttachmentSlotIssue,
	forgetOwnedStagedAttachment,
	getAttachmentSlotDraft,
	getAttachmentSlotIssue,
	getAttachmentSlotPath,
	getOwnedStagedAttachment,
	isAttachmentTaskAbort,
	registerAttachmentSlotPath,
	rememberAttachmentSlotDraft,
	rememberOwnedStagedAttachment,
	resolveAttachmentSlotKey,
	retryAttachmentRetarget,
	runAttachmentTask,
	type StagedAttachment,
	scheduleAttachmentCleanup,
	setAttachmentSlotIssue,
	stageAttachment,
	subscribeAttachmentSlotState,
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
	readonly questionLabelledBy?: string | undefined;
	readonly questionDescriptionIds?: string | undefined;
	readonly questionLabel?: string | undefined;
	readonly onChange: (value: string) => void;
	readonly onBlur: () => void;
	readonly onChangeAt?: ((path: string, value: string) => void) | undefined;
	readonly onBlurAt?: ((path: string) => void) | undefined;
}

type AttachmentIntent =
	| "idle"
	| "queued-upload"
	| "uploading"
	| "queued-clear"
	| "queued-retarget";

function intentForDraft(
	draft: AttachmentSlotDraft | undefined,
): AttachmentIntent {
	if (draft?.status === "queued-upload") return "queued-upload";
	if (draft?.status === "uploading") return "uploading";
	return "idle";
}

export function AttachmentField({
	field,
	state,
	path,
	appId,
	entryKey,
	attachmentSlotKey,
	questionLabelId,
	questionLabelledBy,
	questionDescriptionIds,
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
			questionLabelledBy={questionLabelledBy}
			questionDescriptionIds={questionDescriptionIds}
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
	questionLabelledBy,
	questionDescriptionIds,
	questionLabel,
	onChange,
	onBlur,
	onChangeAt,
	onBlurAt,
}: AttachmentFieldProps) {
	const mayEdit = useCanEdit();
	const session = useOptionalBuilderSessionApi();
	const inputId = useId();
	const actionId = useId();
	const statusId = useId();
	const removeActionId = useId();
	const retryActionId = useId();
	const issueRemoveActionId = useId();
	const errorId = useId();
	const validationId = useId();
	const helpId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const accessibleQuestionLabel =
		questionLabel ?? field.label ?? fieldRegistry[field.kind].label;
	const requestedSlotKey = attachmentSlotKey ?? path ?? field.uuid;
	const slotKey =
		appId && entryKey && path
			? resolveAttachmentSlotKey({
					appId,
					entryKey,
					requestedSlotKey,
					instancePath: path,
					fieldUuid: field.uuid,
				})
			: requestedSlotKey;
	const mayEditRef = useRef(mayEdit);
	mayEditRef.current = mayEdit;
	const hasWriteAuthority = useCallback((): boolean => {
		const current = session?.getState();
		return current === undefined
			? mayEditRef.current
			: current.accessPhase === "authorized" &&
					current.canEdit &&
					current.appId === appId;
	}, [appId, session]);
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
	const initialDraft =
		appId && entryKey
			? getAttachmentSlotDraft({ appId, entryKey, slotKey })
			: undefined;
	const [slotDraft, setSlotDraftState] = useState<
		AttachmentSlotDraft | undefined
	>(initialDraft);
	const initialIntent = intentForDraft(initialDraft);
	const intentRef = useRef<AttachmentIntent>(initialIntent);
	const [intent, setIntentState] = useState<AttachmentIntent>(initialIntent);
	const setIntent = useCallback((next: AttachmentIntent): void => {
		intentRef.current = next;
		setIntentState(next);
	}, []);
	const [error, setError] = useState<string | undefined>();
	const initialIssue =
		appId && entryKey
			? getAttachmentSlotIssue({ appId, entryKey, slotKey })
			: undefined;
	const [slotIssue, setSlotIssueState] = useState<
		AttachmentSlotIssue | undefined
	>(initialIssue);
	const [signatureRetryRevision, setSignatureRetryRevision] = useState(0);
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
		const draft =
			appId && entryKey
				? getAttachmentSlotDraft({ appId, entryKey, slotKey })
				: undefined;
		setSlotDraftState(draft);
		setIntent(intentForDraft(draft));
		setError(undefined);
		setSlotIssueState(
			appId && entryKey
				? getAttachmentSlotIssue({ appId, entryKey, slotKey })
				: undefined,
		);
	}, [appId, entryKey, slotKey, setIntent]);

	useEffect(() => {
		if (!appId || !entryKey || !path) return;
		registerAttachmentSlotPath({
			appId,
			entryKey,
			slotKey,
			instancePath: path,
			fieldUuid: field.uuid,
			captureKind: field.kind,
		});
	}, [appId, entryKey, field.kind, field.uuid, path, slotKey]);

	useEffect(() => {
		if (mayEdit) return;
		if (entryKey) cancelAttachmentSlotWork(entryKey, slotKey);
		if (appId && entryKey) {
			clearAttachmentSlotDraft({ appId, entryKey, slotKey });
		}
		if (inputRef.current) inputRef.current.value = "";
		setIntent("idle");
	}, [appId, entryKey, mayEdit, setIntent, slotKey]);

	useEffect(() => {
		if (!appId || !entryKey) {
			setSlotIssueState(undefined);
			return;
		}
		const update = () => {
			const owned = getOwnedStagedAttachment({
				appId,
				entryKey,
				slotKey,
			});
			if (
				owned?.attachmentId !== stagedRef.current?.attachmentId ||
				owned?.attachmentName !== stagedRef.current?.attachmentName
			) {
				stagedRef.current = owned;
				setStaged(owned);
			}
			setSlotIssueState(getAttachmentSlotIssue({ appId, entryKey, slotKey }));
			const draft = getAttachmentSlotDraft({ appId, entryKey, slotKey });
			setSlotDraftState(draft);
			const draftIntent = intentForDraft(draft);
			if (
				draftIntent !== "idle" ||
				intentRef.current === "queued-upload" ||
				intentRef.current === "uploading"
			) {
				setIntent(draftIntent);
			}
		};
		update();
		return subscribeAttachmentSlotState(entryKey, update);
	}, [appId, entryKey, slotKey, setIntent]);

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
			if (!hasWriteAuthority()) {
				throw new AttachmentRejected(
					"Project editors can attach files and signatures.",
				);
			}
			if (!appId || !entryKey || !uploadPath) {
				const unavailable = new AttachmentRejected(
					"This form isn't ready to attach files yet. Wait a moment and try again.",
				);
				setError(unavailable.message);
				throw unavailable;
			}
			setError(undefined);
			clearAttachmentSlotIssue({
				appId,
				entryKey,
				slotKey,
				kind: "save",
			});
			if (field.kind !== "signature") {
				rememberAttachmentSlotDraft({
					appId,
					entryKey,
					slotKey,
					file,
					status: "uploading",
					generation: context.generation,
				});
			}
			setIntent("uploading");
			try {
				const next = await stageAttachment({
					appId,
					entryKey,
					fieldUuid: field.uuid,
					instancePath: uploadPath,
					file,
					signal: context.signal,
				});
				if (!context.isCurrent() || !hasWriteAuthority()) {
					scheduleAttachmentCleanup({
						appId,
						attachmentId: next.attachmentId,
					});
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
					maximumDraftGeneration: context.generation,
				});
				setStaged(next);
				changeCurrent(next.attachmentName);
				if (
					previous !== undefined &&
					previous.attachmentId !== next.attachmentId
				) {
					scheduleAttachmentCleanup({
						appId,
						attachmentId: previous.attachmentId,
					});
				}
			} catch (err) {
				if (!context.isCurrent() || isAttachmentTaskAbort(err)) throw err;
				const message =
					err instanceof AttachmentRejected
						? err.message
						: "That attachment couldn't be saved. Check your connection and try again.";
				setAttachmentSlotIssue({
					appId,
					entryKey,
					slotKey,
					issue: {
						kind: "save",
						message:
							field.kind === "signature"
								? "This signature could not be saved. Retry now or use Clear signature."
								: message,
					},
				});
				if (field.kind !== "signature") {
					rememberAttachmentSlotDraft({
						appId,
						entryKey,
						slotKey,
						file,
						status: "needs-attention",
						generation: context.generation,
					});
				}
				throw err;
			} finally {
				if (context.isCurrent()) {
					setIntent("idle");
					blurCurrent();
				}
			}
		},
		[
			appId,
			entryKey,
			field.kind,
			field.uuid,
			slotKey,
			currentPath,
			changeCurrent,
			blurCurrent,
			setIntent,
			hasWriteAuthority,
		],
	);

	const stage = useCallback(
		async (file: File) => {
			if (intentRef.current !== "idle" || !hasWriteAuthority()) return;
			if (!entryKey || currentPath() === undefined) {
				setError(
					"This form isn't ready to attach files yet. Wait a moment and try again.",
				);
				return;
			}
			if (appId) {
				rememberAttachmentSlotDraft({
					appId,
					entryKey,
					slotKey,
					file,
					status: "queued-upload",
				});
			}
			setIntent("queued-upload");
			await runAttachmentTask({
				entryKey,
				slotKey,
				task: (context) => stageWithinTask(file, context),
			}).catch((err: unknown) => {
				if (!isAttachmentTaskAbort(err)) {
					setIntent("idle");
					blurCurrent();
				}
			});
		},
		[
			appId,
			entryKey,
			slotKey,
			currentPath,
			stageWithinTask,
			blurCurrent,
			setIntent,
			hasWriteAuthority,
		],
	);

	const clear = useCallback(() => {
		if (!hasWriteAuthority()) return;
		const activeIntent = intentRef.current;
		if (
			activeIntent !== "idle" &&
			!(
				field.kind === "signature" &&
				(activeIntent === "queued-upload" ||
					activeIntent === "uploading" ||
					activeIntent === "queued-retarget")
			)
		) {
			return;
		}
		// Signature Clear is an explicit replacement intent even while its old
		// bitmap is uploading. Cancel that generation before composing the one
		// queued answer-clear transition; a late confirm cannot resurrect ink.
		if (entryKey) cancelAttachmentTask(entryKey, slotKey);
		if (appId && entryKey) {
			clearAttachmentSlotDraft({ appId, entryKey, slotKey });
		}
		setIntent("queued-clear");
		setError(undefined);
		if (inputRef.current) inputRef.current.value = "";
		if (appId && entryKey) {
			// Clear is its own queued operation rather than another generation
			// of the upload path. A file picked immediately afterward must wait
			// for this answer-clear, not abort it and resurrect the old answer
			// when the replacement later fails.
			const clearTaskKey = `$nova-clear$${slotKey}:${++maintenanceTaskSequenceRef.current}`;
			void runAttachmentTask({
				entryKey,
				slotKey: clearTaskKey,
				target: {
					slotKey,
					instancePath: currentPath() ?? path ?? slotKey,
					fieldUuid: field.uuid,
				},
				task: async () => {
					// Authority can change while Clear waits behind another slot.
					// Re-read it before mutating either the answer or ownership.
					if (!hasWriteAuthority()) return;
					const previous =
						forgetOwnedStagedAttachment({
							appId,
							entryKey,
							slotKey,
						}) ?? stagedRef.current;
					stagedRef.current = undefined;
					setStaged(undefined);
					// Answer first, bytes second. The reverse order is the
					// upstream defect this lane exists beside: on a device,
					// clearing a REQUIRED capture removes the file and leaves
					// the question still naming it.
					changeCurrent("");
					if (previous !== undefined) {
						scheduleAttachmentCleanup({
							appId,
							attachmentId: previous.attachmentId,
						});
					}
					blurCurrent();
				},
			})
				.catch((err: unknown) => {
					if (!isAttachmentTaskAbort(err)) {
						setError(
							"That attachment couldn't be cleared. Check your connection and try again.",
						);
					}
				})
				.finally(() => setIntent("idle"));
			return;
		}

		const previous = stagedRef.current;
		stagedRef.current = undefined;
		setStaged(undefined);
		changeCurrent("");
		if (previous && appId) {
			scheduleAttachmentCleanup({
				appId,
				attachmentId: previous.attachmentId,
			});
		}
		blurCurrent();
		setIntent("idle");
	}, [
		appId,
		entryKey,
		field.kind,
		field.uuid,
		path,
		slotKey,
		currentPath,
		changeCurrent,
		blurCurrent,
		setIntent,
		hasWriteAuthority,
	]);

	const cancelUpload = useCallback(() => {
		if (
			intentRef.current !== "queued-upload" &&
			intentRef.current !== "uploading"
		) {
			return;
		}
		if (entryKey) cancelAttachmentTask(entryKey, slotKey);
		if (appId && entryKey) {
			clearAttachmentSlotDraft({ appId, entryKey, slotKey });
		}
		if (inputRef.current) inputRef.current.value = "";
		setIntent("idle");
		setError(
			stagedRef.current !== undefined || state.value !== ""
				? "Attachment canceled. The existing attachment is still attached."
				: "Attachment canceled. No file was attached.",
		);
		blurCurrent();
	}, [appId, blurCurrent, entryKey, setIntent, slotKey, state.value]);

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
		setError(undefined);
		if (inputRef.current) inputRef.current.value = "";
		setIntent("idle");
		if (entryKey) cancelAttachmentTask(entryKey, slotKey);
		if (appId && entryKey) {
			clearAttachmentSlotDraft({ appId, entryKey, slotKey });
		}
		if (previous !== undefined && appId !== undefined) {
			scheduleAttachmentCleanup({
				appId,
				attachmentId: previous.attachmentId,
			});
		}
	}, [appId, entryKey, slotKey, state.value, setIntent]);

	const retryIssue = useCallback(() => {
		if (
			!slotIssue ||
			!appId ||
			!entryKey ||
			intentRef.current !== "idle" ||
			!hasWriteAuthority()
		) {
			return;
		}
		if (slotIssue.kind === "save" || slotIssue.kind === "replace") {
			if (field.kind !== "signature") {
				inputRef.current?.click();
				return;
			}
			if (slotIssue.kind === "replace") return;
			setIntent("queued-upload");
			setSignatureRetryRevision((revision) => revision + 1);
			return;
		}
		setIntent("queued-retarget");
		void retryAttachmentRetarget({ appId, entryKey, slotKey })
			.catch((error: unknown) => {
				if (!isAttachmentTaskAbort(error)) blurCurrent();
			})
			.finally(() => setIntent("idle"));
	}, [
		appId,
		entryKey,
		field.kind,
		slotIssue,
		slotKey,
		blurCurrent,
		setIntent,
		hasWriteAuthority,
	]);

	const hasAnswer = state.value !== "";
	const busy = intent !== "idle";
	const interactionBlocked = busy || !mayEdit;
	const uploadActive = intent === "queued-upload" || intent === "uploading";
	const chooseFileRecovery =
		(slotIssue?.kind === "save" || slotIssue?.kind === "replace") &&
		field.kind !== "signature";
	const showRecoveryAction = !(
		slotIssue?.kind === "replace" && field.kind === "signature"
	);
	const showError = state.touched && !state.valid;
	const labelledBy = questionLabelledBy ?? questionLabelId;
	const describedBy = [
		questionDescriptionIds,
		statusId,
		error || slotIssue ? errorId : undefined,
		showError && !error && !slotIssue ? validationId : undefined,
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
					questionLabelledBy={labelledBy}
					questionLabel={accessibleQuestionLabel}
					uploading={intent === "uploading"}
					queued={intent === "queued-upload" || intent === "queued-retarget"}
					interactionBlocked={!mayEdit || intent === "queued-clear"}
					readOnly={!mayEdit}
					hasWriteAuthority={hasWriteAuthority}
					hasAnswer={hasAnswer}
					needsAttention={slotIssue !== undefined}
					retryRevision={signatureRetryRevision}
					required={state.required}
					invalid={showError}
					statusId={statusId}
					describedBy={describedBy}
					onDrawn={stageWithinTask}
					onClear={clear}
					onEncodingError={() => {
						if (appId && entryKey) {
							setAttachmentSlotIssue({
								appId,
								entryKey,
								slotKey,
								issue: {
									kind: "save",
									message:
										"This signature could not be saved. Retry now or use Clear signature.",
								},
							});
						}
						setIntent("idle");
					}}
				/>
			) : (
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					{/* A label styled as the control, so the 48px target and the
					    keyboard focus ring belong to the real input. */}
					<label
						htmlFor={inputId}
						aria-disabled={interactionBlocked}
						className={`relative inline-flex min-h-12 min-w-0 max-w-full touch-manipulation items-center gap-2 overflow-hidden rounded-md border border-pv-input-border bg-pv-surface px-4 text-sm font-medium text-nova-text transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-pv-input-focus ${
							interactionBlocked
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
							disabled={interactionBlocked}
							required={state.required}
							aria-invalid={showError}
							aria-label={
								labelledBy
									? undefined
									: `${accessibleQuestionLabel}. ${
											!mayEdit
												? "Read-only attachment"
												: busy
													? "Attaching"
													: hasAnswer
														? "Replace file"
														: "Attach file"
										}`
							}
							aria-labelledby={
								labelledBy ? `${labelledBy} ${actionId}` : undefined
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
							{intent === "queued-upload"
								? "Waiting to attach…"
								: intent === "uploading"
									? "Attaching…"
									: hasAnswer
										? "Replace file"
										: "Attach file"}
						</span>
					</label>
					{uploadActive ? (
						<button
							type="button"
							onClick={cancelUpload}
							aria-describedby={describedBy}
							aria-label={`Cancel attachment for ${accessibleQuestionLabel}`}
							className="inline-flex min-h-12 touch-manipulation items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text"
						>
							<Icon icon={tablerX} width="16" height="16" aria-hidden="true" />
							Cancel
						</button>
					) : hasAnswer && !slotIssue ? (
						<button
							type="button"
							onClick={clear}
							disabled={interactionBlocked}
							aria-describedby={describedBy}
							aria-labelledby={
								labelledBy ? `${removeActionId} ${labelledBy}` : undefined
							}
							className="inline-flex min-h-12 touch-manipulation items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm text-nova-text-muted transition-colors not-disabled:hover:bg-white/[0.06] not-disabled:hover:text-nova-text disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Icon icon={tablerX} width="16" height="16" aria-hidden="true" />
							<span id={removeActionId}>Remove</span>
							{labelledBy ? null : (
								<span className="sr-only">
									{" "}
									attachment for {accessibleQuestionLabel}
								</span>
							)}
						</button>
					) : null}
				</div>
			)}

			{/* The whole confirmation a worker gets: a name, or nothing. Matches
			    `entry_file.html`'s `fileNameDisplay`. */}
			{field.kind !== "signature" ? (
				<p
					id={statusId}
					role="status"
					aria-label={`${accessibleQuestionLabel} attachment status`}
					aria-live="polite"
					className="min-w-0 break-words text-xs text-nova-text-muted [overflow-wrap:anywhere]"
				>
					{intent === "queued-upload"
						? slotDraft === undefined
							? "Waiting to attach file…"
							: `Waiting to attach ${slotDraft.file.name}…`
						: intent === "uploading"
							? slotDraft === undefined
								? "Attaching file…"
								: `Attaching ${slotDraft.file.name}…`
							: intent === "queued-clear"
								? "Waiting to remove file…"
								: hasAnswer
									? (staged?.originalFilename ?? "File attached")
									: (slotDraft?.file.name ?? "No file attached.")}
				</p>
			) : null}

			{!mayEdit ? (
				<p className="text-xs text-nova-text-muted">
					{field.kind === "signature"
						? "Project editors can attach signatures."
						: "Project editors can attach files."}
				</p>
			) : null}

			{slotIssue ? (
				<div
					id={errorId}
					role="alert"
					className="space-y-2 text-xs text-nova-red"
				>
					<p className="flex items-start gap-1.5">
						<Icon
							icon={tablerAlertTriangle}
							width="14"
							height="14"
							aria-hidden="true"
							className="mt-0.5 shrink-0"
						/>
						<span>{slotIssue.message}</span>
					</p>
					<div className="flex flex-wrap gap-2">
						{showRecoveryAction ? (
							<button
								type="button"
								onClick={retryIssue}
								disabled={interactionBlocked}
								data-attachment-recovery
								aria-label={`${
									chooseFileRecovery
										? "Choose file"
										: `Retry ${
												field.kind === "signature" ? "signature" : "attachment"
											}`
								} for ${accessibleQuestionLabel}`}
								aria-labelledby={
									labelledBy ? `${retryActionId} ${labelledBy}` : undefined
								}
								className="inline-flex min-h-11 touch-manipulation items-center rounded-md border border-current px-3 font-medium transition-colors not-disabled:hover:bg-nova-red/10 disabled:cursor-not-allowed disabled:opacity-40"
							>
								<span id={retryActionId}>
									{chooseFileRecovery ? "Choose file" : "Retry"}
								</span>
							</button>
						) : null}
						{field.kind === "signature" ? null : (
							<button
								type="button"
								onClick={clear}
								disabled={interactionBlocked}
								aria-label={`Remove attachment for ${accessibleQuestionLabel}`}
								aria-labelledby={
									labelledBy
										? `${issueRemoveActionId} ${labelledBy}`
										: undefined
								}
								className="inline-flex min-h-11 touch-manipulation items-center rounded-md px-3 font-medium transition-colors not-disabled:hover:bg-nova-red/10 disabled:cursor-not-allowed disabled:opacity-40"
							>
								<span id={issueRemoveActionId}>Remove attachment</span>
							</button>
						)}
					</div>
				</div>
			) : null}

			{error && !slotIssue ? (
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

			{showError && !error && !slotIssue ? (
				<p id={validationId} role="alert" className="text-xs text-nova-red">
					{state.errorMessage ?? "This question needs an attachment."}
				</p>
			) : null}

			<p id={helpId} className="text-xs text-nova-text-muted">
				Up to {Math.floor(MAX_CAPTURE_BYTES / 1_000_000)} MB.
			</p>
		</div>
	);
}
