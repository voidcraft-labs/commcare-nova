"use client";
import { useState } from "react";
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
import { updateLookupDetailsAction } from "@/lib/lookup/actions";
import type { LookupColumn, LookupTableSnapshot } from "@/lib/lookup/types";
import { sendLookupGesture } from "./lookupGesture";
import {
	ColumnOptionFields,
	editingMembers,
	MemberFields,
	memberInputs,
} from "./RichDefinitionFields";

import { TableReaderReview, useTableReaderReview } from "./TableReaderReview";

export function EditLookupDetailsDialog({
	table,
	column,
	canChangeShape,
	onClose,
	onSaved,
}: {
	table: LookupTableSnapshot;
	column?: LookupColumn;
	canChangeShape: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const [baseline] = useState(table);
	const [original] = useState(column);
	const [attributes, setAttributes] = useState(() =>
		editingMembers(baseline.attributes),
	);
	const [options, setOptions] = useState(() => ({
		repeated: !!original?.repeated,
		indexed: original?.index === "indexed",
		properties: editingMembers(original?.properties),
	}));
	const readerReview = useTableReaderReview(baseline.projectId, baseline.id);
	const apps = readerReview.apps;
	const [error, setError] = useState("");
	const [stale, setStale] = useState(false);
	const [working, setWorking] = useState(false);

	const save = async () => {
		if (working || !apps || stale) return;
		setWorking(true);
		setError("");
		try {
			const result = await sendLookupGesture(
				updateLookupDetailsAction,
				baseline.projectId,
				{
					tableId: baseline.id,
					expectedTableRevision: baseline.tableRevision,
					reviewed: {
						projectRevision: baseline.projectRevision,
						readerAppIds: apps.map((app) => app.appId),
					},
					change: original
						? {
								kind: "column",
								columnId: original.id,
								...(options.repeated !== !!original.repeated && {
									repeated: options.repeated,
								}),
								...(options.indexed !== (original.index === "indexed") && {
									indexed: options.indexed,
								}),
								properties: options.repeated
									? memberInputs(options.properties)
									: [],
							}
						: { kind: "row-details", attributes: memberInputs(attributes) },
				},
			);
			if (result.success) {
				await onSaved();
				onClose();
			} else {
				if (result.code === "conflict") {
					setStale(true);
					await onSaved();
				}
				setError(result.details?.[0]?.message ?? result.message);
			}
		} catch {
			setError("Nova couldn't save these details. You can try again.");
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
					<DialogTitle>
						{original ? `Settings for ${original.label}` : "Edit row details"}
					</DialogTitle>
					<DialogDescription>
						{original
							? "Choose how this column stores values for each row."
							: "Row details describe the entire row. A detail can hold empty text."}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="space-y-4">
						{original ? (
							<ColumnOptionFields
								canChangeShape={canChangeShape}
								options={options}
								dataType={original.dataType}
								onChange={setOptions}
								disabled={working}
							/>
						) : (
							<MemberFields
								canRemoveExisting={canChangeShape}
								members={attributes}
								onChange={setAttributes}
								title="Row details"
								disabled={working}
							/>
						)}
						<TableReaderReview review={readerReview} />
						{error && (
							<p role="alert" className="text-sm text-nova-rose">
								{error}
							</p>
						)}
						{stale && (
							<p className="text-sm">
								The table has been refreshed. You can copy your edits here and
								reopen its settings to review the changes.
							</p>
						)}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" disabled={working} onClick={onClose}>
						Cancel
					</Button>
					<Button
						disabled={working || stale || !apps}
						onClick={() => void save()}
					>
						{working ? "Saving" : "Save changes"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
