/**
 * Users and personas: the first App setup section.
 *
 * Three collections on one screen, in the order they build on each other:
 * worker information is the vocabulary, a role fills it with defaults, and
 * a persona is a named worker holding a role. Keeping them visibly separate
 * is the point: a role is a template, a persona is somebody, and a
 * deployed worker (a real account on a CommCare project) is neither and
 * lives with the deployment.
 *
 * The persona rows are where the distinction becomes visible rather than
 * described: each one shows the session that persona would carry, with
 * inherited values and its own overrides told apart.
 */
"use client";

import { useBuilderLookupCatalog } from "@/components/builder/lookup/BuilderLookupCatalogProvider";
import { Button } from "@/components/shadcn/button";
import { builderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import { useCanEdit } from "@/lib/session/hooks";
import { PersonasSubsection } from "./PersonasSubsection";
import { RolesSubsection } from "./RolesSubsection";
import { WorkerInformationSubsection } from "./WorkerInformationSubsection";

export function UsersSection() {
	const canEdit = useCanEdit();
	const lookupCommitState = useLookupCommitState();
	const admission = builderWriteAdmission({ canEdit, lookupCommitState });
	const catalog = useBuilderLookupCatalog();
	return (
		<section aria-labelledby="app-setup-users-heading" className="pb-10">
			{/* Named by the breadcrumb and the selected tab already, both within
			    135px and near-identical in colour and weight. Kept as the
			    section's accessible name, dropped from the eye, matching every
			    other App setup section. */}
			<h2 id="app-setup-users-heading" className="sr-only">
				Users and personas
			</h2>
			<p className="mt-2 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
				Describe the people who will use this app, the information they carry,
				and the roles they fill. Add personas to try those choices in Preview.
				Worker accounts are created when you deploy.
			</p>

			{canEdit && !admission.ok && (
				<div
					role={catalog.kind === "error" ? "alert" : "status"}
					className="mt-4 space-y-2 text-sm text-nova-text-secondary"
				>
					<p>{admission.messages.join(" ")}</p>
					{catalog.kind === "error" && (
						<Button variant="outline" onClick={() => void catalog.retry()}>
							Try again
						</Button>
					)}
				</div>
			)}

			<div className="mt-8 flex flex-col gap-10">
				<WorkerInformationSubsection />
				<RolesSubsection />
				<PersonasSubsection />
			</div>
		</section>
	);
}
