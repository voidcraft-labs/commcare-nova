import type { MockAgent } from "undici";

/** Serve only the working suite and its counter; no form or restore body is read. */
export function serveWorkingInstallationInventory(peer:MockAgent,host:string,app:string,version:number,options:{paths?: readonly string[]; counterAlreadyServed?:boolean; releaseNote?:string}={}) {
	const paths=options.paths ?? ["modules-0/forms-0.xml"];
	const resources=paths.map(path=>{
		const tag=path===options.releaseNote ? "xform-update-info":"xform";
		return `<${tag}><resource><location authority="local">./${path}</location><location authority="remote">./${path}</location></resource></${tag}>`;
	});
	peer.get(host).intercept({method:"GET",path:`/a/clinic/apps/download/${app}/suite.xml`}).reply(200,`<suite>${resources.join("")}</suite>`);
	if(!options.counterAlreadyServed) peer.get(host).intercept({method:"GET",path:`/a/clinic/apps/view/${app}/current_version/`}).reply(200,{currentVersion:version,latestBuild:version,latestReleasedBuild:version});
}
