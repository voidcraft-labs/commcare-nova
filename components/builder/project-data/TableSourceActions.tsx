/**
 * The two actions that change where a table's content comes from, without
 * changing anything in CommCare HQ: Use the table from CommCare HQ, for a
 * table made in Nova that a publish put in a project space, and Create a
 * separate table, for a table every worker receives.
 *
 * Each opens a confirmation that reads the change as it stands on the server
 * (what it does to the table, the apps that read it, and the digest the
 * change is held to) and sends that digest back, so the change is made only
 * over what the person read; where the table, its readers or CommCare HQ's
 * table moved, the confirmation reads it again and shows the refusal beside
 * the action. A control a person can't use stays on screen and says who can.
 */
"use client";

import { type ReactNode, useEffect, useState } from "react";
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
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import { Spinner } from "@/components/shadcn/spinner";
import {
	reviewSeparateTableAction,
	reviewUseHqTableAction,
	separateTableAction,
	takeHqTableAction,
} from "@/lib/deployment/managedDataActions";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import {
	KEEP_NOVA_TABLE,
	KEEP_ONE_TABLE,
	MANAGEMENT_NEEDS_ADMIN,
	REFRESH_NEEDS_EDITOR,
	SEPARATE_TABLE,
	SEPARATE_TABLE_CONFIRM,
	USE_HQ_TABLE,
	USE_HQ_TABLE_CONFIRM,
} from "@/lib/publish/managedData";
import { useCanDelete, useProjectCanEdit } from "@/lib/session/hooks";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import { useHqTableSourcesView, useManifestEntry } from "./useProjectData";

const TRANSPORT_FAILURE =
	"Nova couldn't reach this data table. Check your connection and try again.";

type Review = {
	readonly title: string;
	readonly lines: readonly string[];
	readonly reviewDigest: string;
};

export function TableSourceActions({
	table,
	workspace,
}: {
	table: LookupTableSnapshot;
	workspace: ProjectDataWorkspace;
}) {
	const hq = useManifestEntry(table.id)?.hq ?? table.hq;
	const sources = useHqTableSourcesView(table);
	const canEdit = useProjectCanEdit();
	const canDelete = useCanDelete();
	const [dialog, setDialog] = useState<"use" | "separate" | null>(null);
	const loaded = sources.state.kind === "data" ? sources.state.value : null;
	const assigned =
		table.workerAccess === "assigned" ||
		hq?.source?.distribution === "assigned";
	const offerUse = hq === undefined && (loaded?.sources.length ?? 0) > 0;
	const offerSeparate = !assigned;
	if (!offerUse && !offerSeparate) return null;

	const landed = async () => {
		setDialog(null);
		await Promise.all([
			workspace.reload(),
			workspace.reloadManifest(),
			sources.reload(),
		]);
	};

	return (
		<div
			data-table-source-actions
			className="mt-3 flex max-w-prose flex-col gap-1"
		>
			<div className="flex flex-wrap items-center gap-2">
				{offerUse && (
					<Button
						type="button"
						variant="outline"
						disabled={!canDelete}
						onClick={() => setDialog("use")}
					>
						{USE_HQ_TABLE}
					</Button>
				)}
				{offerSeparate && (
					<Button
						type="button"
						variant="outline"
						disabled={!canEdit}
						onClick={() => setDialog("separate")}
					>
						{SEPARATE_TABLE}
					</Button>
				)}
			</div>
			{offerUse && !canDelete && (
				<p className="text-[12px] leading-snug text-nova-text-muted">
					{MANAGEMENT_NEEDS_ADMIN}
				</p>
			)}
			{offerSeparate && !canEdit && (
				<p className="text-[12px] leading-snug text-nova-text-muted">
					{REFRESH_NEEDS_EDITOR}
				</p>
			)}
			{dialog === "use" && loaded !== null && (
				<UseHqTableDialog
					table={table}
					sources={loaded.sources}
					onCancel={() => setDialog(null)}
					onLanded={landed}
				/>
			)}
			{dialog === "separate" && (
				<SeparateTableDialog
					table={table}
					onCancel={() => setDialog(null)}
					onLanded={landed}
				/>
			)}
		</div>
	);
}

/** One confirmation's frame: the title, the lines, the refusal and the two buttons. */
function Confirmation({
	review,
	loadingTitle,
	confirmLabel,
	cancelLabel,
	working,
	refusal,
	canConfirm,
	onCancel,
	onConfirm,
	children,
}: {
	review: Review | null;
	loadingTitle: string;
	confirmLabel: string;
	cancelLabel: string;
	working: boolean;
	refusal: string | null;
	canConfirm: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	children?: ReactNode;
}) {
	const [first, ...rest] = review?.lines ?? [];
	return (
		<AlertDialog open onOpenChange={(next) => !next && !working && onCancel()}>
			<AlertDialogContent data-table-source-dialog>
				<AlertDialogHeader>
					<AlertDialogTitle className="[overflow-wrap:anywhere]">
						{review?.title ?? loadingTitle}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{first ?? (refusal === null ? "Reading the table" : "")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogBody className="space-y-3">
					{children}
					{rest.map((line) => (
						<p
							key={line}
							className="text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
						>
							{line}
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
						disabled={working || review === null || !canConfirm}
						onClick={(event) => {
							/* A refusal keeps the dialog open so its sentence lands
							 * beside the action; a change that landed closes it. */
							event.preventDefault();
							onConfirm();
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

function UseHqTableDialog({
	table,
	sources,
	onCancel,
	onLanded,
}: {
	table: LookupTableSnapshot;
	sources: readonly {
		readonly server: string;
		readonly serverLabel: string;
		readonly domain: string;
		readonly connected: boolean;
	}[];
	onCancel: () => void;
	onLanded: () => Promise<void>;
}) {
	const [chosen, setChosen] = useState<string | null>(null);
	const [review, setReview] = useState<Review | null>(null);
	const [working, setWorking] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const keyOf = (source: { server: string; domain: string }) =>
		`${source.server}\u0000${source.domain}`;
	const choiceOf = (key: string) =>
		sources.find((source) => keyOf(source) === key);

	const read = async (key: string) => {
		const source = choiceOf(key);
		if (source === undefined) return;
		setWorking(true);
		setRefusal(null);
		setReview(null);
		try {
			const answer = await reviewUseHqTableAction(
				table.projectId,
				table.id,
				source.server,
				source.domain,
			);
			if (answer.ok) setReview(answer.review);
			else setRefusal(answer.message);
		} catch {
			setRefusal(TRANSPORT_FAILURE);
		} finally {
			setWorking(false);
		}
	};

	const confirm = async () => {
		const source = chosen === null ? undefined : choiceOf(chosen);
		if (source === undefined || review === null) return;
		setWorking(true);
		setRefusal(null);
		try {
			const answer = await takeHqTableAction(
				table.projectId,
				table.id,
				source.server,
				source.domain,
				review.reviewDigest,
			);
			if (answer.ok) {
				await onLanded();
				return;
			}
			setRefusal(answer.message);
			if (answer.reason === "review-moved") {
				const again = await reviewUseHqTableAction(
					table.projectId,
					table.id,
					source.server,
					source.domain,
				);
				setReview(again.ok ? again.review : null);
			}
		} catch {
			setRefusal(TRANSPORT_FAILURE);
		} finally {
			setWorking(false);
		}
	};

	return (
		<Confirmation
			review={review}
			loadingTitle={USE_HQ_TABLE}
			confirmLabel={USE_HQ_TABLE_CONFIRM}
			cancelLabel={KEEP_NOVA_TABLE}
			working={working}
			refusal={refusal}
			canConfirm={chosen !== null}
			onCancel={onCancel}
			onConfirm={() => void confirm()}
		>
			<RadioGroup<string>
				aria-label="Project space"
				onValueChange={(value) => {
					setChosen(value);
					void read(value);
				}}
			>
				{sources.map((source) => (
					<RadioGroupItem<string>
						key={keyOf(source)}
						value={keyOf(source)}
						description={source.serverLabel}
						{...(source.connected
							? {}
							: {
									unavailableReason:
										"Connect to CommCare HQ on this server in Settings to read its table.",
								})}
					>
						{source.domain}
					</RadioGroupItem>
				))}
			</RadioGroup>
		</Confirmation>
	);
}

function SeparateTableDialog({
	table,
	onCancel,
	onLanded,
}: {
	table: LookupTableSnapshot;
	onCancel: () => void;
	onLanded: () => Promise<void>;
}) {
	const [state, setState] = useState<
		| { readonly kind: "unread" }
		| {
				readonly kind: "read";
				readonly review: Review & {
					readonly apps: readonly {
						readonly appId: string;
						readonly appName: string;
						readonly deleted: boolean;
					}[];
					readonly suggested: { readonly name: string; readonly tag: string };
				};
		  }
	>({ kind: "unread" });
	const [name, setName] = useState("");
	const [tag, setTag] = useState("");
	const [apps, setApps] = useState<readonly string[]>([]);
	const [working, setWorking] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		reviewSeparateTableAction(table.projectId, table.id).then(
			(answer) => {
				if (!live) return;
				if (!answer.ok) {
					setRefusal(answer.message);
					return;
				}
				setState({ kind: "read", review: answer.review });
				setName(answer.review.suggested.name);
				setTag(answer.review.suggested.tag);
			},
			() => {
				if (live) setRefusal(TRANSPORT_FAILURE);
			},
		);
		return () => {
			live = false;
		};
	}, [table.projectId, table.id]);

	const review = state.kind === "read" ? state.review : null;
	const confirm = async () => {
		if (review === null) return;
		setWorking(true);
		setRefusal(null);
		try {
			const answer = await separateTableAction(table.projectId, table.id, {
				name,
				tag,
				appIds: apps,
				reviewDigest: review.reviewDigest,
			});
			if (answer.ok) {
				await onLanded();
				return;
			}
			setRefusal(answer.message);
			if (answer.reason === "review-moved") {
				const again = await reviewSeparateTableAction(
					table.projectId,
					table.id,
				);
				if (again.ok) setState({ kind: "read", review: again.review });
			}
		} catch {
			setRefusal(TRANSPORT_FAILURE);
		} finally {
			setWorking(false);
		}
	};

	return (
		<Confirmation
			review={review}
			loadingTitle={SEPARATE_TABLE}
			confirmLabel={SEPARATE_TABLE_CONFIRM}
			cancelLabel={KEEP_ONE_TABLE}
			working={working}
			refusal={refusal}
			canConfirm={apps.length > 0 && name.trim() !== "" && tag.trim() !== ""}
			onCancel={onCancel}
			onConfirm={() => void confirm()}
		>
			{review !== null && (
				<>
					<div className="space-y-1">
						<Label htmlFor="separate-table-name">New table's name</Label>
						<Input
							id="separate-table-name"
							value={name}
							disabled={working}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="separate-table-tag">New export name</Label>
						<Input
							id="separate-table-tag"
							value={tag}
							disabled={working}
							onChange={(event) => setTag(event.target.value)}
						/>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-[13px] font-medium text-nova-text">
							Apps that read the new table
						</legend>
						{review.apps.map((app) => (
							<Label
								key={app.appId}
								className="flex min-h-11 items-center gap-2 text-[13px] font-normal"
							>
								<Checkbox
									checked={apps.includes(app.appId)}
									disabled={working}
									onCheckedChange={(checked) =>
										setApps((current) =>
											checked
												? [...current, app.appId]
												: current.filter((id) => id !== app.appId),
										)
									}
								/>
								{app.deleted ? `${app.appName} (in the trash)` : app.appName}
							</Label>
						))}
					</fieldset>
				</>
			)}
		</Confirmation>
	);
}
