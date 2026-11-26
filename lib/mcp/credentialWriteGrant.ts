import "server-only";
import type {Transaction} from "kysely";
import {lockCurrentProjectGrant} from "@/lib/auth/dataGrant";
import {NOVA_MCP_FLOOR_SCOPES} from "@/lib/auth-public";
import {withAppTx,type AppDatabase} from "@/lib/db/pg";
import {assertScope,McpCredentialInactiveError,McpScopeError,type Scope} from "./scopes";
import type {ToolContext} from "./types";

/** Check the request before remote work and its durable credential again in
 * the transaction that authorizes the write. The operation receives no bearer. */
export function credentialWriteGrant(ctx:ToolContext,toolName:string,required:readonly Scope[]) {
 const scopes=[...required,...NOVA_MCP_FLOOR_SCOPES];
 const check=async (tx:Transaction<AppDatabase>)=>{
  for(const scope of scopes) assertScope(ctx,scope,toolName);
  if (!ctx.grant || ctx.grant.kind!==ctx.authKind ||
      !(await lockCurrentProjectGrant(tx,ctx.userId,ctx.grant,scopes)))
    throw new McpCredentialInactiveError(ctx.authKind);
 };
 return async(tx?:Transaction<AppDatabase>,afterInstallationImport=false)=>{
  try{ if(tx)await check(tx);else await withAppTx(check); }
  catch(error){
   if(afterInstallationImport && (error instanceof McpScopeError || error instanceof McpCredentialInactiveError)) error.message="CommCare HQ received the app. Nova needs your publishing access to finish confirming the installation. "+error.message;
   throw error;
  }
 };
}
