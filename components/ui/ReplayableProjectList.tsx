"use client";
import { useReplay } from "@/hooks/useReplay";
import type { ProjectSummary } from "@/lib/db/projects";
import { ProjectCard } from "./ProjectCard";

interface ReplayableProjectListProps {
	projects: ProjectSummary[];
	/** URL prefix for the replay logs endpoint — `${prefix}/${projectId}/logs`. */
	logsUrlPrefix: string;
	/** When true, non-error projects link to `/build/{id}`. Defaults to false. */
	linkToProjects?: boolean;
	/** When false, replay buttons are hidden. Defaults to true. */
	showReplay?: boolean;
	/** Content to show when the project list is empty. */
	emptyState?: React.ReactNode;
}

/**
 * Project list with integrated replay support.
 *
 * Client component because useReplay manages state and the replay callback
 * is an event handler passed to ProjectCard. Shared between the builds page
 * (user's own projects) and admin user detail page (admin viewing any user's projects).
 *
 * Props are all serializable (no functions) so this component can be rendered
 * from a Server Component parent.
 */
export function ReplayableProjectList({
	projects,
	logsUrlPrefix,
	linkToProjects = false,
	showReplay = true,
	emptyState,
}: ReplayableProjectListProps) {
	const buildUrl = (id: string) => `${logsUrlPrefix}/${id}/logs`;
	const { handleReplay, replayingId, replayError } = useReplay({ buildUrl });

	if (projects.length === 0 && emptyState) {
		return <>{emptyState}</>;
	}

	return (
		<>
			{replayError && (
				<div className="text-center py-4" role="alert">
					<p className="text-nova-rose">{replayError}</p>
				</div>
			)}

			<div className="grid gap-3">
				{projects.map((project, i) => (
					<ProjectCard
						key={project.id}
						project={project}
						index={i}
						href={
							linkToProjects && project.status !== "error"
								? `/build/${project.id}`
								: undefined
						}
						onReplay={showReplay ? handleReplay : undefined}
						replayingId={replayingId}
					/>
				))}
			</div>
		</>
	);
}
