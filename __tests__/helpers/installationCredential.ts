import {randomUUID} from "node:crypto";
import {type Kysely,sql} from "kysely";
import type {ToolContext} from "@/lib/mcp/types";

/** A verified synthetic credential with a durable row like Better Auth's.
 * Emit no bearer material. Unknown actors remain absent for access tests. */
export async function installationCredential<DB>(db:Kysely<DB>,userId:string,scopes:readonly string[]):Promise<ToolContext> {
 const keyId=randomUUID();
 await sql`INSERT INTO public.auth_apikey(id,"referenceId","configId",key,permissions,enabled,"createdAt","updatedAt")
 SELECT ${keyId},id,'default',${keyId},${JSON.stringify({scope:scopes})},true,now(),now() FROM public.auth_user WHERE id=${userId}`.execute(db);
 return {userId,scopes,authKind:"api-key",grant:{kind:"api-key",keyId}};
}
