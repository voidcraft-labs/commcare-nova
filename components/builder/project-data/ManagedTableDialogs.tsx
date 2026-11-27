/**
 * The two confirmations in front of a change of who manages a table that came
 * from CommCare HQ.
 *
 * Manage in Nova changes what every later publish to the table's project
 * space does, and the hand-back replaces whatever Nova holds that was never
 * published there, so each one says what happens and names the apps that read
 * the table before anything changes. Both are the alert dialog
 * `DestructiveChangeDialog` is: a refusal lands beside the action that
 * produced it and the dialog stays open, and Base UI owns focus entry,
 * containment and return.
 */
"use client";

import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Spinner } from "@/components/shadcn/spinner";

import type { LookupReferencingAppSummary } from "@/lib/lookup/types";
import {
	appsThatReadIt,
	columnsBecomeText,
	KEEP_IN_HQ,
	KEEP_MANAGING_IN_NOVA,
	LET_HQ_MANAGE_CONFIRM,
	LOOKUP_DISCARD_NOTE,
	letHqManageBody,
	letHqManageTitle,
	MANAGE_IN_NOVA_CONFIRM,
	manageInNovaBody,
	manageInNovaTitle,
} from "@/lib/publish/managedData";

/** Resolves `null` once the change landed, or the sentence of the refusal that stopped it. */
type Confirm = () => Promise<string | null>;

const TRANSPORT_FAILURE =
	"Nova couldn't reach this data table. Check your connection and try again.";

function ManagedTableConfirmation({
	open,
	title,
	paragraphs,
	confirmLabel,
	cancelLabel,
	destructive,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	title: string;
	paragraphs: readonly string[];
	confirmLabel: string;
	cancelLabel: string;
	destructive: boolean;
	onCancel: () => void;
	onConfirm: Confirm;
}) {
	const [working, setWorking] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [first, ...rest] = paragraphs;
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => !next && !working && onCancel()}
		>
			<AlertDialogContent data-managed-table-dialog>
				<AlertDialogHeader>
					<AlertDialogTitle className="[overflow-wrap:anywhere]">
						{title}
					</AlertDialogTitle>
					<AlertDialogDescription>{first}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogBody className="space-y-3">
					{rest.map((paragraph) => (
						<p
							key={paragraph}
							className="text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
						>
							{paragraph}
						</p>
					))}
					{refusal !== null && (
						<p
							role="alert"
							className="text-[13px] leading-relaxed text-nova-rose"
						>
							{refusal}
						</p>
					)}
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={working} onClick={onCancel}>
						{cancelLabel}
					</AlertDialogCancel>
					<AlertDialogAction
						variant={destructive ? "destructive" : "default"}
						disabled={working}
						onClick={async (event) => {
							/* A refusal keeps the dialog open so its sentence lands beside
							 * the action; a change that landed closes it from the caller. */
							event.preventDefault();
							setWorking(true);
							setRefusal(null);
							try {
								setRefusal(await onConfirm());
							} catch {
								setRefusal(TRANSPORT_FAILURE);
							} finally {
								setWorking(false);
							}
						}}
					>
						{working && <Spinner className="size-4" />}
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** Manage in Nova: from now on the table is changed in Nova, and each publish replaces CommCare HQ's. */
export function ManageInNovaDialog({
	open,
	tableName,
	domain,
	apps,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	tableName: string;
	domain: string;
	apps: readonly LookupReferencingAppSummary[];
	onCancel: () => void;
	onConfirm: Confirm;
}) {
	const readers = appsThatReadIt(apps);
	return (
		<ManagedTableConfirmation
			open={open}
			title={manageInNovaTitle(tableName)}
			paragraphs={[
				...manageInNovaBody(domain),
				LOOKUP_DISCARD_NOTE,
				...(readers === null ? [] : [readers]),
			]}
			confirmLabel={MANAGE_IN_NOVA_CONFIRM}
			cancelLabel={KEEP_IN_HQ}
			destructive={false}
			onCancel={onCancel}
			onConfirm={onConfirm}
		/>
	);
}

/**
 * Let CommCare HQ manage it again: Nova takes CommCare HQ's columns and rows
 * as they are now. `typedColumns` are the labels of the columns that hold
 * numbers or dates in Nova, which become text.
 */
export function LetHqManageDialog({
	open,
	tableName,
	domain,
	typedColumns,
	apps,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	tableName: string;
	domain: string;
	typedColumns: readonly string[];
	apps: readonly LookupReferencingAppSummary[];
	onCancel: () => void;
	onConfirm: Confirm;
}) {
	const becomeText = columnsBecomeText(typedColumns);
	const readers = appsThatReadIt(apps);
	return (
		<ManagedTableConfirmation
			open={open}
			title={letHqManageTitle(tableName)}
			paragraphs={[
				letHqManageBody(domain),
				...(becomeText === null ? [] : [becomeText]),
				...(readers === null ? [] : [readers]),
			]}
			confirmLabel={LET_HQ_MANAGE_CONFIRM}
			cancelLabel={KEEP_MANAGING_IN_NOVA}
			destructive
			onCancel={onCancel}
			onConfirm={onConfirm}
		/>
	);
}
