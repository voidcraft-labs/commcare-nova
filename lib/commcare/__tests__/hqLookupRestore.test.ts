import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { readVerifiedGlobalLookupRows } from "../hq/lookupCoverage";
import {readWorkerGroupsRestore, readLookupWorkerRestore } from "../hq/lookupRestore";
import { toHqLookupTable } from "../hq/lookupTables";

const creds = {
	server: "india",
	username: "editor@example.org",
	apiKey: "key",
} as const;
const self = { username: creds.username };
const mobile = { username: "ana@sample.commcarehq.org", userId: "mobile-123" };
const options = { binding: "selected-project-table-editor" };
const definition = {
	id: "1".repeat(32),
	tag: "clinics",
	is_global: true,
	fields: [{ field_name: "name", properties: ["lang"] }],
	item_attributes: [],
};
const table = toHqLookupTable(definition);
assert(table);
const item = '<clinics><name lang="sw">A</name><name></name></clinics>';
function native(
	user = "ana",
	principal = "commcare",
	token = "first",
	fixture = true,
	rows = item + item,
) {
	const id = principal === "commcare" ? mobile.userId : "web-123";
	return `<OpenRosaResponse xmlns="http://openrosa.org/http/response"><message nature="ota_restore_success">ok</message>
 <Sync xmlns="http://commcarehq.org/sync"><restore_id>${token}</restore_id></Sync>
 <Registration xmlns="http://openrosa.org/user/registration"><username>${user}</username><password>unrelated secret</password><uuid>${id}</uuid>
 <user_data><data key="commcare_project">sample</data><data key="commcare_user_type">${principal}</data></user_data></Registration>
 <fixture id="item-list:other" user_id="${id}"><other_list><other>unrelated row</other></other_list></fixture>
 ${fixture ? `<schema id="item-list:clinics"><indices><index>name</index></indices></schema><fixture indexed="true" id="item-list:clinics" user_id="${id}"><clinics_list>${rows}</clinics_list></fixture>` : ""}</OpenRosaResponse>`;
}
const restore = (as: boolean, since?: string) =>
	"/a/sample/phone/restore/?" +
	new URLSearchParams({
		...(as ? { as: mobile.username } : {}),
		overwrite_cache: "true",
		...(since ? { since } : {}),
	}).toString();
const scope = "https://india.commcarehq.org";
it("selects only the named fixture for the authenticated principal and keeps duplicate-visible rows and exact occurrences", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(scope)
			.intercept({ path: restore(true), method: "GET" })
			.reply(200, native());
		const result = await readLookupWorkerRestore(
			creds,
			"sample",
			{ ...table, isGlobal: false },
			mobile,
			options,
		);
		expect(result).toMatchObject({
			workerId: mobile.userId,
			read: "full",
			principal: "commcare",
			indexedFields: ["name"],
			baseToken: "first",
			rows: Array.from({ length: 2 }, () => ({
				attributes: {},
				fields: [
					{ name: "name", text: "A", properties: { lang: "sw" } },
					{ name: "name", text: "", properties: {} },
				],
			})),
		});
		expect(JSON.stringify(result)).not.toMatch(/unrelated|remoteId|password/);
	});
});
it("inherits an omitted fixture only on a continuous verified chain, and reacquires a full restore after a binding change", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(scope)
			.intercept({ path: restore(true), method: "GET" })
			.reply(200, native());
		const previous = await readLookupWorkerRestore(
			creds,
			"sample",
			table,
			mobile,
			options,
		);
		if ("success" in previous) throw Error("missing base");
		peer
			.get(scope)
			.intercept({ path: restore(true, "first"), method: "GET" })
			.reply(200, native("ana", "commcare", "next", false));
		const continued = await readLookupWorkerRestore(
			creds,
			"sample",
			table,
			mobile,
			{ ...options, previous },
		);
		expect(continued).toMatchObject({
			read: "continuous-delta",
			rows: previous.rows,
			baseToken: "first",
			continuationToken: "next",
		});
		peer
			.get(scope)
			.intercept({ path: restore(true), method: "GET" })
			.reply(200, native("ana", "commcare", "fresh", false));
		const refused = await readLookupWorkerRestore(
			creds,
			"sample",
			table,
			mobile,
			{ binding: "different", previous },
		);
		expect(refused).toMatchObject({ success: false, cause: "malformed" });
	});
});
it("refuses the web principal as proof of assigned-row visibility and rejects a revoked impersonation grant", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(scope)
			.intercept({ path: restore(false), method: "GET" })
			.reply(200, native(self.username, "web"));
		expect(
			await readLookupWorkerRestore(
				creds,
				"sample",
				{ ...table, isGlobal: false },
				self,
				options,
			),
		).toMatchObject({ success: false });
		peer
			.get(scope)
			.intercept({ path: restore(false), method: "GET" })
			.reply(200, native(self.username, "web", "empty", true, ""));
		expect(
			await readLookupWorkerRestore(
				creds,
				"sample",
				{ ...table, isGlobal: false },
				self,
				options,
			),
		).toMatchObject({ principal: "web", rows: [] });
		peer
			.get(scope)
			.intercept({ path: restore(true), method: "GET" })
			.reply(403, "Refused");
		expect(
			await readLookupWorkerRestore(creds, "sample", table, mobile, options),
		).toMatchObject({ success: false, status: 403 });
	});
});
it.each(["match", "missing", "foreign", "changed", "assigned"] as const)(
	"checks full global cardinality and exact distinct scoped details including absent occurrences (%s)",
	async (fault) => {
		await withHttpPeer(async (peer) => {
			const id = "2".repeat(32),
				api = "/a/sample/api";
			const defPath = `${api}/lookup_table/v1/${table.id}/`;
			const data = {
				id,
				data_type_id: fault === "foreign" ? "3".repeat(32) : table.id,
				sort_key: 2,
				item_attributes: {},
				fields: { name: { field_list: [] } },
			};
			const selected =
				fault === "assigned" ? { ...table, isGlobal: false } : table;
			if (fault !== "assigned") {
				peer
					.get(scope)
					.intercept({ path: defPath, method: "GET" })
					.reply(200, definition)
					.persist();
				peer
					.get(scope)
					.intercept({ path: restore(false), method: "GET" })
					.reply(
						200,
						native(
							self.username,
							"web",
							"observed",
							true,
							fault === "changed" ? item : "<clinics/>",
						),
					)
					.persist();
				if (fault !== "missing")
					peer
						.get(scope)
						.intercept({
							path: `${api}/lookup_table_item/v1/${id}/`,
							method: "GET",
						})
						.reply(200, data)
						.persist();
			}
			const result = await readVerifiedGlobalLookupRows(
				creds,
				"sample",
				selected,
				{
					binding: options.binding,
					candidates: fault === "missing" ? [] : [id],
					maxBytes: 20_000,
				},
			);
			if (fault === "match")
				expect(result).toMatchObject({
					totalCount: 1,
					rows: [{ id, fields: { name: [] }, sortKey: 2 }],
				});
			else expect(result).toMatchObject({ success: false });
			expect(
				peer
					.getCallHistory()
					?.calls()
					.every((call) => !call.fullUrl.includes("/lookup_table_item/v1/?")) ??
					true,
			).toBe(true);
		});
	},
);

it("verifies the native group fixture against registration and preserves order, duplicates, and detail values",async()=>{
 const xml=(fixtureId:string,container:string)=>native("ana","commcare","first",false).replace("</OpenRosaResponse>",`<fixture id="user-groups" user_id="${fixtureId}">${container}</fixture></OpenRosaResponse>`);
 const one='<group id="g"><name>Clinic</name><group_data><data key="level"> 2 </data></group_data></group>';
 await withHttpPeer(async peer=>{
  const send=(body:string)=>peer.get(scope).intercept({path:restore(true),method:"GET"}).reply(200,body);
  send(xml(mobile.userId,`<groups>${one}${one}</groups>`));
  const actual=await readWorkerGroupsRestore(creds,"sample",mobile,"scope");
  if("success" in actual)throw Error("Missing authenticated worker group fixture");
  const group={id:"g",name:"Clinic",details:[{key:"level",value:" 2 "}]};
  expect(actual.groups).toEqual([group,group]);
  send(xml(mobile.userId,"<groups/>"));
  expect(await readWorkerGroupsRestore(creds,"sample",mobile,"scope")).toMatchObject({workerId:mobile.userId,groups:[]});
  for(const body of [xml("other-worker","<groups/>"),native("ana","commcare","first",false),xml(mobile.userId,"<groups><group id='g'/></groups>")]){
    send(body);
    expect(await readWorkerGroupsRestore(creds,"sample",mobile,"scope")).toMatchObject({success:false});
  }
 });
});
