"use client";
import { useEffect, useId, useRef, useState } from "react";
import { EntryPointPreviewLaunch } from "@/components/preview/EntryPointPreviewLaunch";
import { Button } from "@/components/shadcn/button";
import { Label } from "@/components/shadcn/label";
import { Switch } from "@/components/shadcn/switch";
import { useEntryPoints } from "@/lib/doc/hooks/useEntryPoints";
import { entryPointIdSchema } from "@/lib/domain";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { DraftCommitInput } from "./DraftCommitField";
import { EntryPointWriteNotice } from "./EntryPointWriteNotice";

export function DeepLinksSection() {
	const model = useEntryPoints();
	const location = useLocation();
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const canWrite = canEdit && model.writeAdmission.ok;
	const prefix = useId();
	const [failure, setFailure] = useState<string>();
	const [adding, setAdding] = useState(false);
	const selected =
		location.kind === "app-setup"
			? model.entries.find(
					(item) => item.entryPoint?.uuid === location.entryPointUuid,
				)
			: undefined;
	const point = selected?.entryPoint;
	const headingRef = useRef<HTMLHeadingElement>(null);
	const selectedUuid = point?.uuid;
	// biome-ignore lint/correctness/useExhaustiveDependencies: navigation changes restore keyboard focus to the workspace heading.
	useEffect(() => {
		headingRef.current?.focus();
		setFailure(undefined);
	}, [selectedUuid]);
	return (
		<section aria-labelledby={`${prefix}-heading`} className="space-y-6 pb-10">
			<h2
				ref={headingRef}
				tabIndex={-1}
				id={`${prefix}-heading`}
				className="text-lg font-semibold text-nova-text"
			>
				Deep links
			</h2>
			<p className="max-w-prose text-sm text-nova-text-secondary">
				Give a module, case list, or form a stable entry point. Test it here,
				then copy an authenticated CommCare HQ link from Publishing after
				releasing the app.
			</p>
			{canEdit && <EntryPointWriteNotice admission={model.writeAdmission} />}
			{failure && (
				<p role="alert" className="text-sm text-nova-red">
					{failure}
				</p>
			)}
			{selected && point ? (
				<div className="space-y-5" key={point.uuid}>
					<Button
						variant="ghost"
						onClick={() => {
							setFailure(undefined);
							navigate.openAppSetup("deep-links");
						}}
					>
						All deep links
					</Button>
					<h3 className="font-medium text-nova-text">{selected.label}</h3>
					<div className="space-y-2">
						<Label htmlFor={`${prefix}-id`}>Link ID</Label>
						<p
							id={`${prefix}-id-help`}
							className="text-sm text-nova-text-secondary"
						>
							Changing this ID can break links you've already shared. Renaming
							the destination keeps this ID.
						</p>
						<DraftCommitInput
							id={`${prefix}-id`}
							value={point.id}
							disabled={!canWrite}
							ariaDescribedBy={`${prefix}-id-help`}
							validate={(value) =>
								entryPointIdSchema.safeParse(value).success
									? undefined
									: "You can use lowercase letters, numbers, underscores, and hyphens"
							}
							onCommit={(id) => model.update(point, { id })}
						/>
					</div>
					{selected.target.kind === "form" && (
						<div className="space-y-2">
							<div className="flex items-center gap-3">
								<Switch
									id={`${prefix}-visibility`}
									checked={point.ignoreDisplayConditions === true}
									disabled={!canWrite}
									onCheckedChange={(checked) => {
										const outcome = model.update(point, {
											ignoreDisplayConditions: checked ? true : null,
										});
										setFailure(outcome.ok ? undefined : outcome.messages[0]);
									}}
								/>
								<Label htmlFor={`${prefix}-visibility`}>
									Open even when display conditions hide the form
								</Label>
							</div>
							<p className="text-sm text-nova-text-secondary">
								This applies only when entering through this link. Workers still
								need access to the app and its cases.
							</p>
						</div>
					)}
					<div className="rounded-lg border border-nova-border p-4 space-y-2">
						<h4 className="font-medium text-nova-text">Required cases</h4>
						{selected.requiredSelections.length === 0 ? (
							<p className="text-sm text-nova-text-secondary">
								This entry point doesn't need a case selection
							</p>
						) : (
							selected.requiredSelections.map((selection) => (
								<p
									key={selection.moduleUuid}
									className="text-sm text-nova-text-secondary"
								>
									{selection.caseType}:{" "}
									{selection.cardinality === "one"
										? "one case"
										: `up to ${selection.maximum} cases, in selection order`}
								</p>
							))
						)}
						<p className="text-sm text-nova-text-secondary">
							Changing the destination's case selections can change the inputs
							that existing links need.
						</p>
					</div>
					{selected.issue ? (
						<p role="alert" className="text-sm text-nova-red">
							{selected.issue}
						</p>
					) : (
						<EntryPointPreviewLaunch entryPointUuid={point.uuid} />
					)}
					<Button
						variant="outline"
						onClick={() => navigate.openAppSetup("publishing")}
					>
						Open Publishing
					</Button>
					{canEdit && (
						<div className="border-t border-nova-border pt-4 space-y-2">
							<p className="text-sm text-nova-text-secondary">
								Removing this entry point stops new links from being generated.
								Publish again to remove it from CommCare HQ. You can undo this
								change.
							</p>
							<Button
								variant="ghost-destructive"
								disabled={!canWrite}
								onClick={() => {
									const outcome = model.remove(point.uuid);
									if (outcome.ok) {
										setFailure(undefined);
										navigate.openAppSetup("deep-links");
									} else setFailure(outcome.messages[0]);
								}}
							>
								Remove deep link
							</Button>
						</div>
					)}
				</div>
			) : (
				<>
					{model.entries.length === 0 && (
						<p className="text-sm text-nova-text-secondary">
							No deep links yet.{" "}
							{canEdit
								? "Choose a destination to add its first entry point."
								: "A Project editor can add an entry point."}
						</p>
					)}
					<div className="space-y-3">
						{model.entries.map((item) => (
							<Button
								key={item.entryPoint?.uuid}
								variant="outline"
								className="w-full justify-start"
								onClick={() => {
									setFailure(undefined);
									navigate.openAppSetup("deep-links", item.entryPoint?.uuid);
								}}
							>
								{item.label}
							</Button>
						))}
					</div>
					{canEdit && (
						<Button
							variant="secondary"
							disabled={!canWrite && !adding}
							onClick={() => setAdding(!adding)}
							aria-expanded={adding}
						>
							{adding ? "Close destinations" : "Add deep link"}
						</Button>
					)}
					{adding && canEdit && (
						<div className="space-y-3">
							<h3 className="font-medium text-nova-text">
								Choose a destination
							</h3>
							{model.destinations
								.filter((item) => !item.entryPoint)
								.map((item) => (
									<div
										key={JSON.stringify(item.target)}
										className="rounded-lg border border-nova-border p-3"
									>
										<Button
											variant="ghost-action"
											disabled={!canWrite || Boolean(item.issue)}
											onClick={() => {
												const result = model.add(item.target);
												if (result.ok) {
													setFailure(undefined);
													setAdding(false);
													navigate.openAppSetup("deep-links", result.uuid);
												} else setFailure(result.messages[0]);
											}}
										>
											{item.label}
										</Button>
										{item.issue && (
											<p className="text-sm text-nova-text-secondary">
												{item.issue}
											</p>
										)}
									</div>
								))}
						</div>
					)}
				</>
			)}
		</section>
	);
}
