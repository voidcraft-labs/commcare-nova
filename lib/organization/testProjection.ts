import "server-only";
import { sql, type Selectable } from "kysely";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { type AppLocationsTable, withAppTx } from "@/lib/db/pg";
import { assignedLocationUuids, type BlueprintDoc, type Uuid } from "@/lib/domain";
import { organizationNotFound } from "./errors";
import { parseOrganizationRevision } from "./schema";
import { toPublicLocation } from "./storedLocation";
import { workerFootprintIds } from "./workerFootprint";
import { workerCaseOwnerPaths } from "./workerPlaces";
import type { OrganizationScope } from "./types";

interface TestPlace { uuid:Uuid; levelUuid:Uuid; parentUuid?:Uuid; name:string }

/** A retained test permits switching to any of its app's personas. Select the
 * union of their simulated restore and case-owner paths, the directly named
 * places and their ancestors. Test-only branches participate in native
 * reach calculations without ever becoming saved places. */
export function readAppTestPlaces(scope:OrganizationScope, doc:BlueprintDoc, tests:readonly TestPlace[], ownerIds:readonly Uuid[]) {
	const synthetic = new Map(tests.map(place => [place.uuid,place]));
	if(synthetic.size !== tests.length) throw Error("Each test place needs a distinct identity, separate from saved places.");
	for(const place of tests) {
		const chain=new Set<Uuid>();
		let ancestor:TestPlace|undefined=place;
		while(ancestor) {
			if(chain.has(ancestor.uuid)) throw Error("A test place cannot be its own ancestor. Choose another parent.");
			chain.add(ancestor.uuid);
			ancestor=ancestor.parentUuid ? synthetic.get(ancestor.parentUuid) : undefined;
		}
	}
	return withAppTx(async tx=>{
		const access=await resolveAppScopeInTransaction(tx,scope.appId,scope.actorUserId,"view");
		if(access.projectId!==scope.projectId) throw organizationNotFound();
		const state=await tx.selectFrom("app_organization_state").select("revision").where("app_id","=",scope.appId).executeTakeFirst();
		const revision=parseOrganizationRevision(state?.revision ?? "0");
		const collision=tests.length && await tx.selectFrom("app_locations").select("id").where("app_id","=",scope.appId)
			.where("id","in",tests.map(row=>row.uuid)).executeTakeFirst();
		if(collision) throw Error("Each test place needs a distinct identity, separate from saved places.");
		const assignments=[...new Set(Object.values(doc.personas ?? {}).flatMap(persona=>assignedLocationUuids(persona.locations)))];
		const persona={locations:assignments.length ? {primaryUuid:assignments[0],additionalUuids:assignments.slice(1)} : undefined};
		const source=sql.table("test_places");
		const seeds=[...assignments,...ownerIds,...tests.flatMap(place=>place.parentUuid?[place.parentUuid]:[])];
		const rows=await sql<Selectable<AppLocationsTable>>`
			WITH RECURSIVE test_places AS NOT MATERIALIZED (
				SELECT app_id,id,parent_id,level_uuid,archived_at,name FROM app_locations WHERE app_id=${scope.appId}
				UNION ALL SELECT ${scope.appId}::text,uuid,"parentUuid","levelUuid",NULL::timestamptz,name
					FROM jsonb_to_recordset(${JSON.stringify(tests.map(({uuid,levelUuid,parentUuid,name})=>({uuid,levelUuid,parentUuid,name})))}::jsonb)
					AS t(uuid uuid,"parentUuid" uuid,"levelUuid" uuid,name text)
			), needed(id) AS (
				SELECT * FROM (${workerFootprintIds(scope.appId,doc,persona,source)}) fixture
				UNION SELECT place_id FROM (${workerCaseOwnerPaths(scope.appId,doc,persona,source)}) owners
				UNION SELECT unnest(${seeds}::uuid[])
				UNION SELECT location_id FROM app_location_references WHERE app_id=${scope.appId}
			), included(id,parent_id) AS (
				SELECT p.id,p.parent_id FROM needed n JOIN test_places p ON p.id=n.id
				UNION SELECT p.id,p.parent_id FROM included i JOIN test_places p ON p.id=i.parent_id
			), ordered(id,depth) AS (
				SELECT id,0 FROM included WHERE parent_id IS NULL
				UNION ALL SELECT i.id,o.depth+1 FROM ordered o JOIN included i ON i.parent_id=o.id
			) SELECT p.* FROM ordered o JOIN app_locations p ON p.id=o.id AND p.app_id=${scope.appId}
			ORDER BY o.depth,p.parent_id,p.order_key,p.id
		`.execute(tx);
		return {revision,locations:rows.rows.map(toPublicLocation)};
	},{isolationLevel:"repeatable read"});
}
