"use client";

import { useState } from "react";
import { ExpressionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/shadcn/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useCaseFormContextMenus } from "@/lib/doc/hooks/useCaseFormContextMenus";
import type {
	CaseListConfig,
	CaseType,
	UserProperty,
	Uuid,
} from "@/lib/domain";
import {
	type CaseFormContextChoice,
	caseContextLine,
	presentFormContext,
} from "@/lib/domain/caseFormContext";
import { prop, toExpression } from "@/lib/domain/expression";

interface Props {
	moduleUuid: Uuid;
	caseTypes: readonly CaseType[];
	currentCaseType: string;
	userProperties: readonly UserProperty[];
	config: CaseListConfig;
	canEdit: boolean;
	onSave: (choice: CaseFormContextChoice | null) => string | undefined;
}

export function CaseFormContextEditor({
	moduleUuid,
	caseTypes,
	currentCaseType,
	userProperties,
	config,
	canEdit,
	onSave,
}: Props) {
	const sources = useCaseFormContextMenus(moduleUuid);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState("");
	const [draft, setDraft] = useState<CaseFormContextChoice | null>(null);
	const current = presentFormContext(config);
	const choices = [
		{ id: "none", label: "No case context" },
		{ id: "line", label: "One line from this case" },
		...(config.tile
			? [{ id: "own-tile", label: "This menu’s Results tile" }]
			: []),
		...sources.map((menu) => ({
			id: menu.uuid,
			label: `Results tile from ${menu.name}`,
		})),
	];
	const key = (choice: typeof draft) =>
		choice?.kind === "menu-tile" ? choice.moduleUuid : (choice?.kind ?? "none");
	const summary =
		choices.find((choice) => choice.id === key(current))?.label ??
		"The source menu is unavailable";
	const makeLine = () => toExpression(prop(currentCaseType, "case_name"));
	const expression =
		draft && "expression" in draft ? draft.expression : undefined;
	const expandSource =
		draft?.kind === "own-tile"
			? config
			: draft?.kind === "menu-tile"
				? sources.find((menu) => menu.uuid === draft.moduleUuid)?.caseListConfig
				: undefined;
	const canExpand =
		expandSource?.columns.some((col) => col.visibleInDetail !== false) ||
		(draft?.kind === "menu-tile" &&
			config.tile?.persistOnForms &&
			config.columns.some((col) => col.visibleInDetail !== false));
	return (
		<section className="mb-6" aria-label="Case context above forms">
			<h2 className="font-display font-semibold text-nova-text">
				Case context above forms
			</h2>
			<p className="my-2 text-sm text-nova-text-muted">{summary}</p>
			{canEdit && (
				<Dialog
					open={open}
					onOpenChange={(value) => {
						if (value) {
							setDraft(current);
							setError("");
						}
						setOpen(value);
					}}
				>
					<DialogTrigger render={<Button variant="outline" />}>
						Edit case context
					</DialogTrigger>
					<DialogContent className="sm:max-w-2xl">
						<DialogHeader>
							<DialogTitle>Case context above forms</DialogTitle>
							<DialogDescription>
								Keep information about the selected case in view as a worker
								continues.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="space-y-4">
							<div className="grid gap-1 text-sm">
								Information to show
								<Select<string>
									value={key(draft)}
									onValueChange={(id) => {
										if (!id) return;
										if (id === "none") setDraft(null);
										else if (id === "line")
											setDraft({
												kind: "line",
												expression:
													expression ??
													caseContextLine(config.contextAboveForm) ??
													makeLine(),
											});
										else if (id === "own-tile") setDraft({ kind: "own-tile" });
										else {
											const menu = sources.find((item) => item.uuid === id);
											if (menu)
												setDraft({ kind: "menu-tile", moduleUuid: menu.uuid });
										}
									}}
								>
									<SelectTrigger aria-label="Information to show">
										<SelectValue>
											{choices.find((item) => item.id === key(draft))?.label}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{choices.map((item) => (
											<SelectItem key={item.id} value={item.id}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							{draft?.kind === "menu-tile" && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={!!expression}
										onChange={(event) => {
											const { expression: old, ...rest } = draft;
											setDraft(
												event.target.checked
													? { ...rest, expression: makeLine() }
													: rest,
											);
										}}
									/>
									Use a one-line fallback
								</label>
							)}
							{expression && draft && draft.kind !== "own-tile" && (
								<ExpressionSlotEditor
									slot={{
										entity: "module",
										uuid: moduleUuid,
										slot: "case_form_context_line",
									}}
									value={expression}
									onChange={(value) =>
										setDraft({ ...draft, expression: value })
									}
									caseTypes={caseTypes}
									currentCaseType={currentCaseType}
									userProperties={userProperties}
								/>
							)}
							{draft && draft.kind !== "line" && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={draft.expandDetails === true}
										disabled={!canExpand && !draft.expandDetails}
										onChange={(event) => {
											const { expandDetails: old, ...rest } = draft;
											setDraft(
												event.target.checked
													? { ...rest, expandDetails: true }
													: rest,
											);
										}}
									/>
									Let workers expand the tile to see Details
								</label>
							)}
							{error && (
								<p role="alert" className="text-sm text-nova-danger">
									{error}
								</p>
							)}
						</DialogBody>
						<DialogFooter>
							<Button variant="outline" onClick={() => setOpen(false)}>
								Cancel
							</Button>
							<Button
								onClick={() => {
									const issue = onSave(draft);
									if (issue) setError(issue);
									else setOpen(false);
								}}
							>
								Save context
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</section>
	);
}
