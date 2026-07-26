/**
 * Add a column to an existing table.
 *
 * Adding is the one schema change that is purely additive — no existing value
 * changes meaning and no app can be broken by it — so it needs `edit` rather
 * than `delete` and asks for no confirmation. The export name is derived from
 * what the author types and stays editable, because it is a contract every CSV
 * heading and every export will use, and guessing it silently would hide that.
 */
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { LOOKUP_DATA_TYPES } from "@/lib/lookup/constants";
import type { LookupColumnDraft, LookupDataType } from "@/lib/lookup/types";
import { COLUMN_TYPE_LABELS, suggestWireName } from "./projectDataModel";

export function AddColumnDialog({
	open,
	onClose,
	onCreate,
}: {
	open: boolean;
	onClose: () => void;
	/** Resolves `null` on success, or the refusal to show in the dialog. */
	onCreate: (draft: LookupColumnDraft) => Promise<string | null>;
}) {
	const labelId = useId();
	const wireNameId = useId();
	const typeId = useId();
	const [label, setLabel] = useState("");
	const [wireName, setWireName] = useState("");
	/* Whether the author has taken the export name over. Until they do it
	 * tracks the label, which is what makes the common case one field — but a
	 * hand-typed name is never overwritten afterwards. */
	const [wireNameTouched, setWireNameTouched] = useState(false);
	const [dataType, setDataType] = useState<LookupDataType>("text");
	const [failure, setFailure] = useState<string | null>(null);
	const [working, setWorking] = useState(false);
	const operation = useRef(0);
	const mounted = useRef(true);
	useEffect(
		() => () => {
			mounted.current = false;
			operation.current += 1;
		},
		[],
	);

	const effectiveWireName = wireNameTouched ? wireName : suggestWireName(label);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !working) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add a column</DialogTitle>
					<DialogDescription>
						Every row gains this column, with no value in it until you fill one
						in. Nothing that already exists changes.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div>
						<Label htmlFor={labelId} className="text-[13px]">
							Name people see
						</Label>
						<Input
							id={labelId}
							value={label}
							autoComplete="off"
							data-1p-ignore
							disabled={working}
							onChange={(event) => setLabel(event.target.value)}
							className="mt-1 h-11"
						/>
					</div>
					<div>
						<Label htmlFor={wireNameId} className="text-[13px]">
							Name in exports and CSV
						</Label>
						<Input
							id={wireNameId}
							value={effectiveWireName}
							autoComplete="off"
							data-1p-ignore
							disabled={working}
							onChange={(event) => {
								setWireNameTouched(true);
								setWireName(event.target.value);
							}}
							className="mt-1 h-11"
						/>
						<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
							Letters, digits, and underscores; it cannot start with a digit.
							This is the heading a CSV import must use.
						</p>
					</div>
					<div>
						<Label htmlFor={typeId} className="text-[13px]">
							Type of value
						</Label>
						<Select
							value={dataType}
							disabled={working}
							onValueChange={(next) => setDataType(next as LookupDataType)}
						>
							<SelectTrigger id={typeId} className="mt-1 h-11 w-full">
								<SelectValue>
									{(selected) => COLUMN_TYPE_LABELS[selected as LookupDataType]}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{LOOKUP_DATA_TYPES.map((candidate) => (
									<SelectItem key={candidate} value={candidate}>
										{COLUMN_TYPE_LABELS[candidate]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{failure !== null && (
						<p
							role="alert"
							className="text-[13px] leading-relaxed text-nova-rose"
						>
							{failure}
						</p>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						disabled={working}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="default"
						className="min-h-11"
						disabled={
							working || label.trim() === "" || effectiveWireName.trim() === ""
						}
						onClick={async () => {
							if (working) return;
							const request = operation.current + 1;
							operation.current = request;
							setWorking(true);
							setFailure(null);
							let refusal: string | null;
							try {
								refusal = await onCreate({
									label: label.trim(),
									wireName: effectiveWireName.trim(),
									dataType,
								});
							} catch {
								if (mounted.current && operation.current === request) {
									setWorking(false);
									setFailure(
										"Nova could not add this column. Check your connection and try again.",
									);
								}
								return;
							}
							if (!mounted.current || operation.current !== request) return;
							setWorking(false);
							if (refusal === null) onClose();
							else setFailure(refusal);
						}}
					>
						{working ? "Adding…" : "Add column"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
