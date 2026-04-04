/**
 * Async server component for the project list.
 *
 * Separated from the builds page so it can be wrapped in a Suspense boundary.
 * The data fetch (Firestore query) happens here while the page shell — header,
 * title, "New Build" button — renders and streams to the client immediately.
 */

import Link from "next/link";
import { ReplayableProjectList } from "@/components/ui/ReplayableProjectList";
import { listProjects } from "@/lib/db/projects";

interface ProjectListProps {
	/** User email for the Firestore query. */
	email: string;
	/** Whether to show replay buttons (admin-only feature). */
	isAdmin: boolean;
}

export async function ProjectList({ email, isAdmin }: ProjectListProps) {
	const projects = await listProjects(email);

	return (
		<ReplayableProjectList
			projects={projects}
			logsUrlPrefix="/api/projects"
			linkToProjects
			showReplay={isAdmin}
			emptyState={
				<div className="text-center py-20">
					<p className="text-nova-text-secondary mb-4">No projects yet</p>
					<Link
						href="/build/new"
						className="inline-flex items-center gap-2 px-4 py-2.5 text-sm leading-6 font-medium rounded-lg bg-nova-violet text-white border border-transparent hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] transition-all duration-200"
					>
						Create your first app
					</Link>
				</div>
			}
		/>
	);
}
