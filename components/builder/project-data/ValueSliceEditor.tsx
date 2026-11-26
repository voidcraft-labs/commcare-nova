"use client";
import { useEffect, useId, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { Input } from "@/components/shadcn/input";
import { Textarea } from "@/components/shadcn/textarea";
import { formatLookupBytes } from "@/lib/lookup/format";
import {
	editLookupValueAction,
	readLookupValueAction,
} from "@/lib/lookup/largeValues/actions";
import type { LookupValueReadRequest } from "@/lib/lookup/largeValues/input";
import { changedLookupText, type LargeRowEdit } from "./largeRowModel";
import { uploadLookupValue } from "./lookupValueUpload";

type Slice = Extract<
	Awaited<ReturnType<typeof readLookupValueAction>>,
	{ ok: true }
>;
export function ValueSliceEditor({
	projectId,
	target,
	initialOffset,
	canEdit,
	label,
	saved,
	retain,
	onSaved,
	onClose,
}: {
	saved: Extract<LargeRowEdit, { kind: "slice" }>;
	retain: (edit: LargeRowEdit) => void;
	projectId: string;
	target: LookupValueReadRequest;
	initialOffset: number;
	canEdit: boolean;
	label: string;
	onSaved: () => Promise<void>;
	onClose: () => void;
}) {
	const [slice, setSlice] = useState<Slice>();
	const [initial] = useState(saved);
	const [text, setText] = useState(saved.text ?? "");
	const [file, setFile] = useState<File | undefined>(saved.file);
	const [whole, setWhole] = useState(saved.whole ?? false);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState("");
	const [progress, setProgress] = useState<number>();
	const [revision] = useState(target);
	const [offset, setOffset] = useState(initialOffset);
	const [readAgain, setReadAgain] = useState(0);
	const [attempt, setAttempt] = useState<string | undefined>(saved.operationId);
	const attemptRef = useRef<AbortController | null>(null);
	const id = useId();
	const remember = (
		change: Partial<Extract<LargeRowEdit, { kind: "slice" }>>,
	) =>
		retain({
			...saved,
			initialOffset: offset,
			text,
			file,
			whole,
			operationId: attempt,
			...change,
		});
	useEffect(() => {
		let active = true;
		setSlice(undefined);
		setError("");
		const read = async () => {
			try {
				const value = await readLookupValueAction(projectId, {
					...revision,
					byteOffset: offset,
				});
				if (!active) return;
				if (value.ok) {
					setSlice(value);
					setText(
						initial.initialOffset === offset
							? (initial.text ?? value.text)
							: value.text,
					);
				} else setError(value.message);
			} catch {
				if (active)
					setError("Nova couldn't read this part. You can try again.");
			}
		};
		void readAgain;
		void read();
		return () => {
			active = false;
		};
	}, [projectId, revision, offset, readAgain, initial]);
	useEffect(() => () => attemptRef.current?.abort(), []);
	const save = async () => {
		if (working || !canEdit) return;
		let upload = saved.upload;
		if (!upload) {
			if (!slice) return;
			const changed =
				!whole && !file
					? changedLookupText(slice.text, text, slice.byteOffset)
					: undefined;
			upload = {
				baseDigest: slice.valueDigest,
				startByte: changed?.startByte ?? (whole ? 0 : slice.byteOffset),
				endByte:
					changed?.endByte ??
					(whole
						? slice.totalBytes
						: slice.byteOffset + new TextEncoder().encode(slice.text).length),
				replacement: file ?? new Blob([changed?.replacement ?? text]),
			};
		}
		const operationId = attempt ?? uuid();
		setAttempt(operationId);
		remember({ operationId, upload });
		const run = new AbortController();
		attemptRef.current = run;
		setWorking(true);
		setError("");
		try {
			const answer = await uploadLookupValue(
				projectId,
				{
					...revision,
					kind: "begin",
					operationId,
					baseDigest: upload.baseDigest,
					startByte: upload.startByte,
					endByte: upload.endByte,
				},
				upload.replacement,
				run.signal,
				setProgress,
			);
			if (run.signal.aborted) return;
			if (answer.ok && answer.state === "complete") {
				await onSaved();
				onClose();
			} else if (!answer.ok) setError(answer.message);
		} catch {
			if (!run.signal.aborted)
				setError(
					"Nova couldn't confirm this edit. You can resume with the same replacement.",
				);
		} finally {
			if (!run.signal.aborted) setWorking(false);
		}
	};
	const cancel = async () => {
		if (!attempt) return;
		attemptRef.current?.abort();
		setWorking(true);
		try {
			const answer = await editLookupValueAction(projectId, {
				kind: "cancel",
				tableId: revision.tableId,
				operationId: attempt,
			});
			if (!answer.ok) {
				setError(answer.message);
				return;
			}
			if (answer.state === "complete") {
				await onSaved();
				onClose();
				return;
			}
			setAttempt(undefined);
			remember({ operationId: undefined, upload: undefined });
			setProgress(undefined);
			setError("");
		} catch {
			setError("Nova couldn't confirm cancellation. You can try again.");
		} finally {
			setWorking(false);
		}
	};
	return (
		<section
			className="space-y-3 rounded-lg border border-nova-border p-3"
			aria-label={label}
		>
			<h3 className="font-medium">{label}</h3>
			{slice && (
				<>
					<p className="text-xs text-nova-text-secondary">
						{slice.totalBytes === 0
							? "Empty text"
							: `Bytes ${slice.byteOffset + 1} to ${slice.nextByteOffset ?? slice.totalBytes} of ${slice.totalBytes}`}
					</p>
					{canEdit ? (
						<>
							<label htmlFor={id}>
								{whole
									? "Replacement for the whole value"
									: "Text in this part"}
							</label>
							<Textarea
								id={id}
								rows={5}
								disabled={!!attempt || !!file}
								value={text}
								onChange={(e) => {
									setText(e.target.value);
									remember({ text: e.target.value });
								}}
							/>
							<label htmlFor={`${id}-file`}>Or use a UTF-8 text file</label>
							<Input
								id={`${id}-file`}
								type="file"
								disabled={!!attempt}
								onChange={(e) => {
									const file = e.target.files?.[0];
									setFile(file);
									remember({ file });
								}}
							/>
							{(slice.byteOffset > 0 || slice.nextByteOffset !== null) && (
								<label
									htmlFor={`${id}-whole`}
									className="flex items-center gap-2"
								>
									<Checkbox
										id={`${id}-whole`}
										disabled={!!attempt}
										checked={whole}
										onCheckedChange={(checked) => {
											setWhole(checked);
											setText(checked ? "" : slice.text);
											remember({
												whole: checked,
												text: checked ? "" : slice.text,
											});
										}}
									/>
									Replace the whole value
								</label>
							)}
						</>
					) : (
						<pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
							{slice.text}
						</pre>
					)}
					<div className="flex flex-wrap gap-2">
						{offset > 0 && (
							<Button
								variant="outline"
								disabled={
									!!attempt || file !== undefined || text !== slice.text
								}
								onClick={() => setOffset(0)}
							>
								Start of value
							</Button>
						)}
						{slice.nextByteOffset !== null && (
							<Button
								variant="outline"
								disabled={
									!!attempt || file !== undefined || text !== slice.text
								}
								onClick={() => {
									if (slice.nextByteOffset !== null)
										setOffset(slice.nextByteOffset);
								}}
							>
								Next part
							</Button>
						)}
						{canEdit && (
							<Button disabled={working} onClick={() => void save()}>
								{attempt ? "Resume edit" : "Save replacement"}
							</Button>
						)}
						{attempt && (
							<Button variant="outline" onClick={() => void cancel()}>
								Cancel upload
							</Button>
						)}
					</div>
				</>
			)}
			{attempt && error && (
				<p>
					You can cancel the upload, or leave it to expire. An unfinished upload
					keeps the saved value.
				</p>
			)}
			{progress !== undefined && (
				<p role="status">{formatLookupBytes(progress)} uploaded</p>
			)}
			{error && (
				<p role="alert" className="text-nova-rose">
					{error}
				</p>
			)}
			{!slice && !error && <p role="status">Reading value</p>}
			{!slice && error && saved.text !== undefined && (
				<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
					<strong>Your text</strong> {saved.text}
				</p>
			)}
			{!slice && error && attempt && saved.upload && canEdit && (
				<Button disabled={working} onClick={() => void save()}>
					Resume edit
				</Button>
			)}
			{!slice && error && attempt && (
				<Button variant="outline" onClick={() => void cancel()}>
					Cancel upload
				</Button>
			)}
			{!slice && error && (
				<Button variant="outline" onClick={() => setReadAgain((x) => x + 1)}>
					Read again
				</Button>
			)}
			<Button variant="ghost" disabled={working} onClick={onClose}>
				{attempt
					? "Leave this upload"
					: saved.text !== undefined || saved.file
						? "Discard edit"
						: "Back to row"}
			</Button>
		</section>
	);
}
