import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";

const packageUrl = new URL("../../../../package.json", import.meta.url);
const repositoryUrl = new URL(".", packageUrl);
const require = createRequire(packageUrl);
const { Agent, MockAgent, setGlobalDispatcher } = require("undici");
Error.stackTraceLimit = 40;
const records = new Map();
const hook = createHook({
	init(id, type, trigger) {
		if (type === "BLOBREADER" || type === "PROMISE")
			records.set(id, {
				type,
				trigger,
				stack: new Error().stack?.replaceAll(repositoryUrl.href, "<repo>/"),
				destroyed: false,
				resolved: false,
			});
	},
	promiseResolve(id) {
		if (records.has(id)) records.get(id).resolved = true;
	},
	destroy(id) {
		if (records.has(id)) records.get(id).destroyed = true;
	},
});
hook.enable();
const peer = new MockAgent({
	agent: new Agent({ factory: (origin) => peer.get(String(origin)) }),
});
peer.disableNetConnect();
setGlobalDispatcher(peer);
peer
	.get("https://hq.test")
	.intercept({ path: "/upload", method: "POST" })
	.reply(async (opts) => {
		const chunks = [];
		for await (const chunk of opts.body) chunks.push(chunk);
		const multipart = await new Response(Buffer.concat(chunks), {
			headers: opts.headers,
		}).formData();
		await multipart.get("app_file").text();
		return { statusCode: 200, data: "{}" };
	});
const form = new FormData();
form.append(
	"app_file",
	new Blob(["some app bytes"], { type: "application/json" }),
	"app.json",
);
const response = await fetch("https://hq.test/upload", {
	method: "POST",
	body: form,
});
await response.json();
await peer.close();
process.once("beforeExit", () => {
	hook.disable();
	console.log(
		JSON.stringify(
			{
				node: process.version,
				bundledUndici: process.versions.undici,
				dispatcherUndici: require("undici/package.json").version,
				phase: "beforeExit after body consumption and transport close",
				resources: [...records].filter(([, r]) => !r.destroyed && !r.resolved),
			},
			null,
			2,
		),
	);
});
