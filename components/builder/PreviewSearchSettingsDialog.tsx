"use client";

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
import { FieldGroup } from "@/components/shadcn/field";
import {
	type PreviewSearchTarget,
	previewSearchTargetKey,
} from "@/lib/preview/searchSettings";
import {
	useAppId,
	useProjectCanEdit,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { usePreviewSearchConfiguration } from "./PreviewSearchConfiguration";
import {
	PreviewSearchSettingsForm,
	SearchSettingChoice,
} from "./PreviewSearchSettingsForm";

function targetLabel(target: PreviewSearchTarget) {
	if (target.kind === "local") return "Local Preview";
	const region = { production: "US", eu: "EU", india: "India" }[target.server];
	return `${target.domain} (${region})`;
}

export function PreviewSearchSettingsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { catalog, target, select } = usePreviewSearchConfiguration();
	const appId = useAppId();
	const canEdit = useProjectCanEdit();
	const epoch = useProjectScopeEpoch();
	const automatic =
		catalog?.profiles.length === 1 &&
		catalog.profiles[0]?.target.kind === "destination"
			? catalog.profiles[0].target
			: undefined;
	const active = target ?? automatic;
	const profile = catalog?.profiles.find(
		(p) =>
			active &&
			previewSearchTargetKey(p.target) === previewSearchTargetKey(active),
	);
	const options =
		catalog?.profiles.map(
			(p) => [previewSearchTargetKey(p.target), targetLabel(p.target)] as const,
		) ?? [];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Preview search settings</DialogTitle>
					<DialogDescription>
						These settings tell Preview how your project space searches records.
						Publishing uses the settings in CommCare HQ.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{catalog && appId ? (
						<FieldGroup>
							{!automatic && (
								<SearchSettingChoice
									label="Search destination"
									value={
										profile ? previewSearchTargetKey(profile.target) : "none"
									}
									options={[["none", "Choose a destination"], ...options]}
									change={(key) =>
										select(
											catalog.profiles.find(
												(p) => previewSearchTargetKey(p.target) === key,
											)?.target,
										)
									}
								/>
							)}
							{!active && catalog.profiles[0]?.target.kind === "local" && (
								<p className="text-sm text-nova-text-muted">
									Local Preview uses{" "}
									{catalog.profiles[0].revision === "0"
										? "UTC, exact matching, and a 500-record limit."
										: "the search settings your team saved for this Project."}
								</p>
							)}
							{automatic && (
								<p className="text-sm font-medium">{targetLabel(automatic)}</p>
							)}
							{active && !profile && (
								<p>
									This destination is no longer available.{" "}
									<Button
										type="button"
										variant="outline"
										onClick={() => select(undefined)}
									>
										Use available destinations
									</Button>
								</p>
							)}
							{profile && (
								<PreviewSearchSettingsForm
									key={JSON.stringify([
										appId,
										catalog.projectId,
										epoch,
										canEdit,
										previewSearchTargetKey(profile.target),
									])}
									appId={appId}
									projectId={catalog.projectId}
									canEdit={canEdit}
									profile={profile}
									onSaved={() => onOpenChange(false)}
								/>
							)}
						</FieldGroup>
					) : (
						<p>Waiting for this Project's search settings.</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						type="button"
						onClick={() => onOpenChange(false)}
					>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
