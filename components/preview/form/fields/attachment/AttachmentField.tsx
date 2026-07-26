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
	cancelAttachmentTask,
	discardAttachment,
	isAttachmentTaskAbort,
	retargetAttachment,
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
	const stagedRef = useRef<StagedAttachment | undefined>(undefined);
	const maintenanceTaskSequenceRef = useRef(0);
	const maintenanceTaskKeysRef = useRef(new Set<string>());
	const previousPathRef = useRef(path);
	const latestPathRef = useRef(path);
	latestPathRef.current = path;
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
			await runAttachmentTask({
				entryKey,
				instancePath: path,
				task: async ({ signal, isCurrent }) => {
					try {
						const next = await stageAttachment({
							appId,
							entryKey,
							fieldUuid: field.uuid,
							instancePath: path,
							file,
							signal,
						});
						if (!isCurrent()) {
							await discardAttachment({
								appId,
								attachmentId: next.attachmentId,
							}).catch(() => undefined);
							return;
						}
						// Replace only after the new generation confirms. The ref is
						// authoritative across fast signature callbacks; React state
						// may not have committed between two generations.
						const previous = stagedRef.current;
						stagedRef.current = next;
						setStaged(next);
						onChange(next.attachmentName);
						if (previous !== undefined) {
							await discardAttachment({
								appId,
								attachmentId: previous.attachmentId,
								signal,
							}).catch(() => undefined);
						}
					} catch (err) {
						if (!isCurrent() || isAttachmentTaskAbort(err)) return;
						setError(
							err instanceof AttachmentRejected
								? err.message
								: "That attachment couldn't be saved. Check your connection and try again.",
						);
					} finally {
						if (isCurrent()) {
							setBusy(false);
							onBlur();
						}
					}
				},
			}).catch((err: unknown) => {
				if (!isAttachmentTaskAbort(err)) {
					setBusy(false);
					setError(
						"That attachment couldn't be saved. Check your connection and try again.",
					);
					onBlur();
				}
			});
		},
		[appId, entryKey, field.uuid, path, onChange, onBlur],
	);

	const clear = useCallback(() => {
		const previous = stagedRef.current;
		stagedRef.current = undefined;
		setStaged(undefined);
		setBusy(false);
		setError(undefined);
		if (inputRef.current) inputRef.current.value = "";
		if (entryKey && path) cancelAttachmentTask(entryKey, path);
		if (appId && entryKey && path) {
			// Clear is its own queued operation rather than another generation
			// of the upload path. A file picked immediately afterward must wait
			// for this answer-clear, not abort it and resurrect the old answer
			// when the replacement later fails.
			const clearTaskKey = `$nova-clear$${path}:${++maintenanceTaskSequenceRef.current}`;
			maintenanceTaskKeysRef.current.add(clearTaskKey);
			void runAttachmentTask({
				entryKey,
				instancePath: clearTaskKey,
				task: async ({ signal }) => {
					// Answer first, bytes second. The reverse order is the
					// upstream defect this lane exists beside: on a device,
					// clearing a REQUIRED capture removes the file and leaves
					// the question still naming it.
					onChange("");
					if (previous !== undefined) {
						await discardAttachment({
							appId,
							attachmentId: previous.attachmentId,
							signal,
						}).catch(() => undefined);
					}
					onBlur();
				},
			})
				.catch((err: unknown) => {
					if (!isAttachmentTaskAbort(err)) {
						setError(
							"That attachment couldn't be cleared. Check your connection and try again.",
						);
					}
				})
				.finally(() => {
					maintenanceTaskKeysRef.current.delete(clearTaskKey);
				});
			return;
		}

		onChange("");
		if (previous && appId) {
			void discardAttachment({
				appId,
				attachmentId: previous.attachmentId,
			}).catch(() => undefined);
		}
		onBlur();
	}, [appId, entryKey, path, onChange, onBlur]);

	// Engine reset and repeat removal own the answer, so mirror an externally
	// cleared value into local filename/busy state and cancel any late upload.
	useEffect(() => {
		if (state.value !== "" || stagedRef.current === undefined) return;
		const previous = stagedRef.current;
		stagedRef.current = undefined;
		setStaged(undefined);
		setBusy(false);
		setError(undefined);
		if (inputRef.current) inputRef.current.value = "";
		if (entryKey && path) cancelAttachmentTask(entryKey, path);
		if (previous !== undefined && appId !== undefined) {
			void discardAttachment({
				appId,
				attachmentId: previous.attachmentId,
			}).catch(() => undefined);
		}
	}, [appId, entryKey, path, state.value]);

	// Repeat removal compacts positional paths while React preserves this
	// answer by its stable repeat-instance key. Move the staged row through the
	// same form-wide queue before submit can observe the new projection.
	useEffect(() => {
		const previousPath = previousPathRef.current;
		previousPathRef.current = path;
		if (!previousPath || !path || previousPath === path || !entryKey) return;
		cancelAttachmentTask(entryKey, previousPath);
		setBusy(false);
		const current = stagedRef.current;
		if (current === undefined || !appId) return;

		setBusy(true);
		const taskKey = `$nova-retarget$${path}:${++maintenanceTaskSequenceRef.current}`;
		maintenanceTaskKeysRef.current.add(taskKey);
		void runAttachmentTask({
			entryKey,
			instancePath: taskKey,
			task: async ({ signal }) => {
				try {
					await retargetAttachment({
						appId,
						attachmentId: current.attachmentId,
						expectedInstancePath: previousPath,
						instancePath: path,
						signal,
					});
				} catch (err) {
					if (isAttachmentTaskAbort(err)) throw err;
					if (stagedRef.current?.attachmentId === current.attachmentId) {
						stagedRef.current = undefined;
						setStaged(undefined);
						onChange("");
						setError(
							err instanceof AttachmentRejected
								? err.message
								: "That attachment couldn't follow its repeat row. Attach it again.",
						);
					}
					await discardAttachment({
						appId,
						attachmentId: current.attachmentId,
					}).catch(() => undefined);
				} finally {
					if (latestPathRef.current === path) {
						setBusy(false);
					}
				}
			},
		})
			.catch((err: unknown) => {
				if (!isAttachmentTaskAbort(err)) {
					setBusy(false);
					setError(
						"That attachment couldn't follow its repeat row. Attach it again.",
					);
				}
			})
			.finally(() => {
				maintenanceTaskKeysRef.current.delete(taskKey);
			});
	}, [appId, entryKey, path, onChange]);

	useEffect(
		() => () => {
			const latestPath = latestPathRef.current;
			if (entryKey && latestPath) {
				cancelAttachmentTask(entryKey, latestPath);
			}
			if (entryKey) {
				for (const taskKey of maintenanceTaskKeysRef.current) {
					cancelAttachmentTask(entryKey, taskKey);
				}
			}
			maintenanceTaskKeysRef.current.clear();
			const previous = stagedRef.current;
			stagedRef.current = undefined;
			if (previous !== undefined && appId !== undefined) {
				void discardAttachment({
					appId,
					attachmentId: previous.attachmentId,
				}).catch(() => undefined);
			}
		},
		[appId, entryKey],
	);

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
							// A file input suppresses `change` when the same path is
							// picked twice. Reset immediately so a rejected upload can
							// be retried without choosing a different file first.
							e.currentTarget.value = "";
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
