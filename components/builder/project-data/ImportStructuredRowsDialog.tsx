"use client";

import { useId, useState } from "react";
import { v4 as uuid } from "uuid";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import { importLookupRowsAction } from "@/lib/lookup/actions";
import {
	namedImportRowsSchema,
	STRUCTURED_ROW_IMPORT_MAX_BYTES,
} from "@/lib/lookup/namedRowInput";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import { sendLookupGesture } from "./lookupGesture";

export function ImportStructuredRowsDialog({
	table,
	onClose,
	onSaved,
}: {
	table: LookupTableSnapshot;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const [baseline] = useState(table);
	const id = useId();
	const [source, setSource] = useState<{
		text: string;
		count: number;
		operationId: string;
	}>();
	const [working, setWorking] = useState(false);
	const [error, setError] = useState("");
	const [stale, setStale] = useState(false);
	const inspect = async (file: File | undefined) => {
		setSource(undefined);
		setError("");
		if (!file) return;
		if (file.size > STRUCTURED_ROW_IMPORT_MAX_BYTES) {
			setError(
				"This file is larger than 256 KiB. You can import its rows in smaller files.",
			);
			return;
		}
		setWorking(true);
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(
				await file.arrayBuffer(),
			);
			const parsed = namedImportRowsSchema.safeParse(JSON.parse(text));
			if (!parsed.success) {
				setError(
					parsed.error.issues[0]?.message ?? "This file needs a list of rows.",
				);
				return;
			}
			setSource({ text, count: parsed.data.length, operationId: uuid() });
		} catch {
			setError(
				"Nova couldn't read this JSON file. You can check its brackets, commas and quoted text.",
			);
		} finally {
			setWorking(false);
		}
	};
	const save = async () => {
		if (!source || stale || working) return;
		setWorking(true);
		setError("");
		try {
			const result = await sendLookupGesture(
				importLookupRowsAction,
				baseline.projectId,
				{
					tableId: baseline.id,
					expectedTableRevision: baseline.tableRevision,
					json: source.text,
				},
				source.operationId,
			);
			if (result.success) {
				await onSaved();
				onClose();
			} else {
				setError(result.details?.[0]?.message ?? result.message);
				if (result.code === "conflict") {
					setStale(true);
					await onSaved();
				}
			}
		} catch {
			setError(
				"Nova couldn't confirm the import. You can add the same file again to recover its result.",
			);
			await onSaved();
		} finally {
			setWorking(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !working) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add rows from a file</DialogTitle>
					<DialogDescription>
						A JSON file can hold row details, ordered lists and details on
						individual values. New rows follow those already here.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<label htmlFor={id} className="text-sm">
						Rows file
					</label>
					<Input
						type="file"
						id={id}
						accept=".json,application/json"
						disabled={working || stale}
						onChange={(event) => void inspect(event.target.files?.[0])}
					/>
					{source && (
						<p role="status" className="mt-2 text-sm">
							{source.count} {source.count === 1 ? "row" : "rows"} to add to{" "}
							{baseline.name}
						</p>
					)}
					{error && (
						<p role="alert" className="mt-2 text-sm text-nova-rose">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" disabled={working} onClick={onClose}>
						Cancel
					</Button>
					<Button
						disabled={!source || working || stale}
						onClick={() => void save()}
					>
						Add rows
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
