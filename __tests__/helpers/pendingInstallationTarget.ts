import {sql} from "kysely";
import type {AppStateTestDb} from "@/lib/db/__tests__/appStateTestDb";
import {foldDeploymentAttempt,type DeploymentScope,type DeploymentTargetKey} from "@/lib/deployment/store";

/** Another editor's private review can outlive the last named profile.
 * The caller cannot read that checkpoint. Its existence protects this target. */
export async function pendingInstallationTarget(fixture:AppStateTestDb,scope:DeploymentScope,target:DeploymentTargetKey){
 const view=await foldDeploymentAttempt(scope,target,"preflight",{status:"succeeded",at:new Date().toISOString()},{ensure:true,expectedEndings:0});
 await sql`INSERT INTO app_deployment_installation_reviews(deployment_id,actor_id,checkpoint) VALUES (${view.deployment.id},'separate-editor','{"previousKeys":[]}'::jsonb)`.execute(fixture.db());
 return view.deployment.id;
}
