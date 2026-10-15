// Gives a lone proof shard's output the directory every shard's output lands
// in when the run holds more than one, right after the step that downloads
// them by pattern:
//
//   node proof/ci/shard-outputs.mjs --dir DIR --name NAME
//
// actions/download-artifact@v8 (src/download-artifact.ts, lines 185-194)
// extracts each artifact into a directory named for it under `path` only when
// the download names no artifact, merges nothing, and its pattern matches more
// than one artifact. A lane sized to one shard uploads one output, so the
// pattern matches that one alone and its contents land loose in DIR, where the
// consumers' glob (DIR/proof-out-*) finds nothing to read. NAME is the
// artifact's own name (proof-out-...-1, the lane's first and only shard), and
// the loose contents move into DIR/NAME, so the glob holds for one shard as it
// does for many.
//
// It changes nothing when DIR is missing or empty, or already holds a
// proof-out-* directory (the outputs of two shards or more). It prints what it
// did. Exit status 0 when DIR holds the outputs as the glob reads them, 2 when
// it could not put them there.

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const USAGE = "node proof/ci/shard-outputs.mjs --dir DIR --name NAME";
const OUTPUT = "proof-out-";

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: "string" },
		name: { type: "string" },
	},
});
if (positionals.length > 0 || !values.dir || !values.name) {
	fail(
		`shard-outputs.mjs takes the directory the outputs were downloaded into and the lone output's artifact name, and nothing else.\nUsage: ${USAGE}`,
	);
}
if (!values.name.startsWith(OUTPUT) || values.name.includes("/")) {
	fail(
		`--name is a shard output's artifact name, ${OUTPUT}<...>, which the consumers' glob reads; got ${JSON.stringify(values.name)}.`,
	);
}

let entries;
try {
	entries = await readdir(values.dir, { withFileTypes: true });
} catch (error) {
	if (error.code !== "ENOENT") {
		fail(
			`${values.dir} could not be read (${error.message}), so the shard outputs downloaded into it cannot be found.`,
		);
	}
	entries = [];
}
if (entries.length === 0) {
	process.stdout.write(
		`${values.dir} holds no shard output; nothing to place.\n`,
	);
	process.exit(0);
}
if (
	entries.some((entry) => entry.isDirectory() && entry.name.startsWith(OUTPUT))
) {
	process.stdout.write(
		`${values.dir} already holds each shard's output in its own directory.\n`,
	);
	process.exit(0);
}

const target = join(values.dir, values.name);
try {
	await mkdir(target);
	for (const entry of entries) {
		await rename(join(values.dir, entry.name), join(target, entry.name));
	}
} catch (error) {
	fail(
		`The lone shard output in ${values.dir} could not be moved into ${target} (${error.message}), so the steps that read ${values.dir}/${OUTPUT}* would find nothing.`,
	);
}
process.stdout.write(
	`${values.dir} held one shard's output loose; it is now ${target}.\n`,
);
