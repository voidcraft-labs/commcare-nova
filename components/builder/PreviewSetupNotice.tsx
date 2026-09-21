"use client";

import { useState } from "react";
import { AppTestHistory } from "@/components/builder/AppTestHistory";
import { usePreviewModeTransition } from "@/components/builder/usePreviewModeTransition";
import { Button } from "@/components/shadcn/button";
import { useWorkerReadiness } from "@/lib/doc/hooks/useWorkerReadiness";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useAppId,
	usePreviewPersonaUuid,
	useSetPreviewing,
} from "@/lib/session/hooks";

/** Authored setup only. Never changes worker eligibility or invents assignments. */
export function PreviewSetupNotice() {
	const readiness = useWorkerReadiness();
	const selected = usePreviewPersonaUuid();
	const appId = useAppId();
	const navigate = useNavigate();
	const setPreviewing = useSetPreviewing();
	const changePreview = usePreviewModeTransition(setPreviewing);
	const [showTests, setShowTests] = useState(false);
	const persona = readiness.personas.find((p) => p.uuid === selected);
	const asMember =
		selected === undefined &&
		(readiness.personas.length > 0 ||
			readiness.rolesWithoutPersonas.length > 0 ||
			readiness.assignmentLevels.length > 0 ||
			readiness.asMember.missingRequiredInformation.length > 0);
	const noPlace = persona?.locationContext === "no-assigned-place";
	if (!asMember && !noPlace) return null;
	return (
		<section
			aria-label="Preview identity setup"
			className="rounded-xl border border-nova-border bg-nova-surface p-4 text-sm text-nova-text-secondary"
		>
			<p className="font-medium text-nova-text-primary">
				{asMember
					? "Preview with a worker identity"
					: `${persona?.name} has no place assigned`}
			</p>
			<p className="mt-1">
				{asMember
					? readiness.personas.length > 0
						? "Preview as me starts without a worker role or assigned places. You can choose a saved identity from the Preview identity menu to explore that worker's tasks."
						: "Preview as me starts without a worker role or assigned places. Identity setup lets you add a representative worker for Preview."
					: "Place-based tasks may need an assignment. Live Preview uses real app data; Test journeys shows recorded disposable examples without changing that setup."}
			</p>
			<div className="mt-2 flex flex-wrap gap-2">
				<Button
					variant="ghost"
					onClick={() => {
						changePreview(false);
						navigate.openAppSetup("users");
					}}
				>
					Identity setup
				</Button>
				{appId && (
					<Button variant="ghost" onClick={() => setShowTests(true)}>
						Test journeys
					</Button>
				)}
			</div>
			{appId && showTests && (
				<AppTestHistory appId={appId} open onOpenChange={setShowTests} />
			)}
		</section>
	);
}
