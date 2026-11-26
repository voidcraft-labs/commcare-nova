import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {ordinaryInstallationBuild} from "@/__tests__/helpers/retainedHqReads";
import {serveWorkingInstallationInventory} from "@/__tests__/helpers/workingInstallationInventory";
import {readInstallationBuild} from "../hq/installationBuild";

const host="https://eu.commcarehq.org";
const creds={server:"eu",username:"account",apiKey:"fixture"} as const;
const form=(i:number)=>"modules-0/forms-"+i+".xml";
const release={id:"release",version:3,isReleased:true};
const profile={id:"team",name:"Field team",langs:["en"]};
it.each([
	{title:"both files omit an enabled form",listed:[0],stored:[],slots:1,counter:3,verdict:"incomplete"},
	{title:"both include a nonexistent form",listed:[0],stored:[0,2],slots:1,counter:3,verdict:"different"},
	{title:"suite points outside its release",listed:[2],stored:[2],slots:1,counter:3,verdict:null},
	{title:"zero enabled forms",listed:[],stored:[],slots:0,counter:3,verdict:"prepared"},
	{title:"shadow and disabled release form absent, enabled release form present",listed:[0,3],stored:[0,3],slots:4,counter:3,verdict:"prepared"},
	{title:"working form inventory changed since release",listed:[],stored:[],slots:1,counter:4,verdict:null},
])("checks the independent enabled form inventory when $title",async ({listed,stored,slots,counter,verdict})=>{
	await withHttpPeer(async peer=>{
		const metadata=ordinaryInstallationBuild("working",release.id,"clinic",release.version);
		const paths=Object.keys(metadata.external_blobs).filter(p=>!p.startsWith("files/modules-")).map(p=>p.slice(6));
		paths.push(...stored.map(form));
		const blobs=Object.fromEntries(paths.flatMap(p=>[["files/"+p,{content_length:24}],["files/team/"+p,{content_length:12}]]));
		peer.get(host).intercept({path:"/a/clinic/api/application/v1/release/?extras=true",method:"GET"}).reply(200,{
			...metadata,modules:[{forms:Array.from({length:slots},(_,i)=>({unique_id:"form-"+i}))}],external_blobs:blobs,build_profiles:{team:{name:profile.name,langs:profile.langs}},
		});
		serveWorkingInstallationInventory(peer,host,"working",counter,{paths:listed.map(form),releaseNote:form(3)});
		const answer=await readInstallationBuild(creds,"clinic","working",release,[profile]);
		expect(answer?.ordinary ?? null).toBe(verdict);
		expect(answer?.profiles.get(profile.id) ?? null).toBe(verdict);
		expect(peer.getCallHistory()?.calls().map(call=>new URL(call.fullUrl).pathname)).toEqual([
			"/a/clinic/api/application/v1/release/","/a/clinic/apps/download/working/suite.xml","/a/clinic/apps/view/working/current_version/",
		]);
	});
});
