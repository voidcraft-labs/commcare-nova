import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [directory, buildId] = process.argv.slice(2);
const read = (name) => readFileSync(path.join(directory, name), "utf8");
const config = JSON.parse(read("image-config.json"));
assert.equal(read("baked-build-id"), buildId);
assert.ok(config.Env.includes(`NOVA_BUILD_ID=${buildId}`));
assert.equal(config.User, "nextjs");
assert.deepEqual(config.Cmd, ["node", "server.js"]);
for (const secret of [
	"SENTRY_AUTH_TOKEN",
	"NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
]) {
	assert.ok(!config.Env.some((entry) => entry.startsWith(`${secret}=`)));
}
assert.equal(
	JSON.parse(read("required-server-files.json")).config.deploymentId,
	buildId,
);
const staticDirectory = path.join(directory, "static");
const staticFiles = readdirSync(staticDirectory, { recursive: true });
assert.ok(
	!staticFiles.some((name) => name.endsWith(".map")),
	"Public source maps must not enter the runtime image",
);
const clientFiles = staticFiles.filter((name) => name.endsWith(".js"));
assert.ok(
	clientFiles.some((name) =>
		readFileSync(path.join(staticDirectory, name), "utf8").includes(buildId),
	),
	"Client assets must carry this build's fresh release identity",
);
const actions = JSON.parse(read("actions.json"));
assert.ok(
	actions.encryptionKey ===
		(process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ||
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
	"Server Action identity must match the pinned build input",
);
console.log(
	`Verified final image identity ${buildId}, runtime configuration, and Server Action key.`,
);
