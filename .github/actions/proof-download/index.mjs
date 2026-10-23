import { client } from "../../../proof/ci/artifacts.mjs";
import { downloadNamed } from "../../../proof/ci/download.mjs";

try {
	await downloadNamed(await client(), {
		prefix: process.env.INPUT_PREFIX,
		suffix: process.env.INPUT_SUFFIX,
		directory: process.env.INPUT_PATH,
	});
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
