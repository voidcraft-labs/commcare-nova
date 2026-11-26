import "server-only";
import { type QueryExecutorProvider, sql } from "kysely";
import {
	type DeploymentRecord,
	deploymentPhaseSchema,
	deploymentStateSchema,
	isDeploymentServer,
} from "./types";

export async function readPreviewDeploymentRecordsIn(
	db: QueryExecutorProvider,
	scope: { appId: string; projectId: string },
): Promise<
	readonly Pick<
		DeploymentRecord,
		"state" | "resumePhase" | "server" | "domain"
	>[]
> {
	/* A deployment whose live app mapping is released still displays as
	 * uploaded, but no publish goes there until a settle takes the HQ app
	 * back, so Preview does not name its project space. */
	const { rows } = await sql<{
		state: string;
		resume_phase: string | null;
		server: string;
		domain: string;
	}>`
		SELECT d.state, d.resume_phase, d.server, d.domain
		FROM app_deployments d
		WHERE d.app_id = ${scope.appId} AND d.project_id = ${scope.projectId}
		  AND NOT EXISTS (
		     SELECT 1 FROM app_deployment_resources r WHERE r.deployment_id = d.id
		     AND r.kind = 'app' AND r.superseded_at IS NULL AND r.released_at IS NOT NULL
		  )
		ORDER BY d.server, d.domain
	`.execute(db);
	return rows.map((row) => {
		const state = deploymentStateSchema.safeParse(row.state);
		const resumePhase =
			row.resume_phase === null
				? null
				: deploymentPhaseSchema.safeParse(row.resume_phase);
		if (!state.success || (resumePhase !== null && !resumePhase.success)) {
			throw new Error(
				`A deployment of app ${scope.appId} is stored in a state Nova does not know.`,
			);
		}
		if (!isDeploymentServer(row.server)) {
			throw new Error(
				`A deployment of app ${scope.appId} names CommCare server "${row.server}", which Nova does not know.`,
			);
		}
		return {
			state: state.data,
			resumePhase: resumePhase === null ? null : resumePhase.data,
			server: row.server,
			domain: row.domain,
		};
	});
}
