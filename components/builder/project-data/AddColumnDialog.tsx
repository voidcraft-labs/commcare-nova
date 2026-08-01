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
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
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
	useEffect(() => {
		/* Claim the flag on every mount, not just the first — a cleanup-only
		 * version leaves it false forever once React remounts the same instance
		 * (StrictMode's development double-invoke does exactly that), and the
		 * guards below then strand the dialog on "Adding…" after a real write. */
		mounted.current = true;
		return () => {
			mounted.current = false;
			operation.current += 1;
		};
	}, []);

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

				<DialogBody>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={labelId}>Name people see</FieldLabel>
							<Input
								id={labelId}
								value={label}
								autoComplete="off"
								data-1p-ignore
								disabled={working}
								onChange={(event) => setLabel(event.target.value)}
								className="h-11"
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={wireNameId}>
								Name in exports and CSV
							</FieldLabel>
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
								className="h-11"
							/>
							<FieldDescription>
								Letters, digits, and underscores; it cannot start with a digit.
								This is the heading a CSV import must use.
							</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor={typeId}>Type of value</FieldLabel>
							<Select
								value={dataType}
								disabled={working}
								onValueChange={(next) => setDataType(next as LookupDataType)}
							>
								{/* `min-h-11`, not `h-11`: the trigger's height is a
								 * `data-[size=…]` variant, which outranks a bare `h-*` from a
								 * call site and would leave it 32px beside these 44px inputs. */}
								<SelectTrigger id={typeId} className="min-h-11 w-full">
									<SelectValue>
										{(selected) =>
											COLUMN_TYPE_LABELS[selected as LookupDataType]
										}
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
						</Field>
						<FieldError>{failure}</FieldError>
					</FieldGroup>
				</DialogBody>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={working}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="default"
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
						{working ? "Adding" : "Add column"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
