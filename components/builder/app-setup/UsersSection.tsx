/**
 * Users and personas: the first App setup section.
 *
 * Three collections on one screen, in the order they build on each other:
 * worker information is the vocabulary, a role fills it with defaults, and
 * a persona is a named worker holding a role. Keeping them visibly separate
 * is the point — a role is a template, a persona is somebody, and a
 * deployed worker (a real account on a CommCare project) is neither and
 * lives with the deployment.
 *
 * The persona rows are where the distinction becomes visible rather than
 * described: each one shows the session that persona would carry, with
 * inherited values and its own overrides told apart.
 */
"use client";

import { PersonasSubsection } from "./PersonasSubsection";
import { RolesSubsection } from "./RolesSubsection";
import { WorkerInformationSubsection } from "./WorkerInformationSubsection";

export function UsersSection() {
	return (
		<section aria-labelledby="app-setup-users-heading" className="pb-10">
			<h2
				id="app-setup-users-heading"
				className="text-base font-semibold text-nova-text"
			>
				Users and personas
			</h2>
			<p className="mt-2 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
				Describe the people who will run this app: what they carry with them,
				the roles they fill, and named workers you can preview as. Nothing here
				creates a real CommCare account: that happens when you deploy.
			</p>

			<div className="mt-8 flex flex-col gap-10">
				<WorkerInformationSubsection />
				<RolesSubsection />
				<PersonasSubsection />
			</div>
		</section>
	);
}
