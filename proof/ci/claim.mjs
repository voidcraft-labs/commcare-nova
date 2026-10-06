// Claims one block of the proof lane's queue for this shard:
//
//   node proof/ci/claim.mjs [--mode create | --mode steal --shard I/N] [--by LABEL]
//     [--listing-cache FILE] [--listing-age SECONDS] [--poll SECONDS] [--resolve-seconds SECONDS] NAME
//
// The lane's fork server (proof/lane/serve.py) runs it for each block it
// wants, with {block} in its claim command replaced by the block's id, and
// reads its exit status: 0 when this shard owns the block, 1 when another
// shard does, and 2 when the claim could not be settled, which stops this
// shard's claiming (it finishes what it holds and fails). NAME is the claim's
// artifact name, one per block and run attempt (proof-claim-<attempt>-<block>).
//
// Two diagnostic claim modes, each conditional on a service property.
// GitHub has violated both properties below; CI defaults to exclusive static
// bins and the aggregate gate rejects duplicates from any diagnostic run.
//
// --mode create (the default) rests on the service refusing a second
//   creation of a name the run holds (409 Conflict). The shard creates the
//   artifact NAME; a refusal means another shard holds the block. Once its
//   artifact is finalized it lists the run's artifacts and owns the block only
//   when its artifact is the one artifact of that name. Should the service
//   ever accept two creations of one name, every claimant that lists after
//   both are finalized sees both and yields, and one that listed earlier saw
//   only its own: so at most one shard runs the block (two that both yield
//   leave it unrun, which the lane's gate reports), whenever a listing taken
//   after an artifact is finalized includes it. GitHub's service does accept
//   one name several times when shards create it at once (a run of ten
//   shards held up to ten artifacts of one claim, and blocks every claimant
//   yielded). This mode remains an explicit diagnostic choice.
//
// --mode steal --shard I/N rests on that listing property alone. Each block
//   has one owner among the N shards (proof/ci/artifacts.mjs::ownerOf). A
//   shard that does not own the block declares its intent (NAME.intent-I),
//   lists, and commits (NAME.commit-I) only when the listing holds nothing
//   else of the block; otherwise it withdraws (NAME.withdraw-I). The owner
//   marks the block (NAME.owner), lists, and waits until every intent the
//   listing shows has committed or withdrawn: it owns the block unless one
//   committed. A shard that commits listed after its intent and saw no owner's
//   mark, so the owner's later listing shows that intent and waits for the
//   commit; two that both declare see each other and both withdraw, and the
//   owner then takes the block. This exclusivity argument requires the listing
//   property; GitHub has returned listings omitting finalized owner and intent
//   markers, and two shards then ran one block.
//
// --listing-cache FILE keeps the latest listing between claims (at most
// --listing-age seconds old, 5 by default): a name it holds is taken without
// asking the service, since an artifact once listed stays (claims are kept a
// day). It never decides that a block is free.
//
// Standard output carries one JSON line, the claim's record (name, mode,
// outcome, the artifact ids listed, seconds); the client's progress and the
// reason go to standard error.

import { readFile, rename, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
	create,
	EXIT,
	listAll,
	ownerOf,
	recordsOnStdout,
} from "./artifacts.mjs";

const USAGE =
	"node proof/ci/claim.mjs [--mode create | --mode steal --shard I/N] [--by LABEL] [--listing-cache FILE] [--listing-age SECONDS] [--poll SECONDS] [--resolve-seconds SECONDS] NAME";

class Refusal extends Error {}

function seconds(value, option) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Refusal(
			`${option} takes a number of seconds; got ${JSON.stringify(value)}.`,
		);
	}
	return number;
}

function options(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			mode: { type: "string", default: "create" },
			shard: { type: "string" },
			by: { type: "string" },
			"listing-cache": { type: "string" },
			"listing-age": { type: "string", default: "5" },
			poll: { type: "string", default: "0.5" },
			"resolve-seconds": { type: "string", default: "60" },
		},
	});
	if (positionals.length !== 1) {
		throw new Refusal(
			`claim.mjs takes one claim name; got ${positionals.length} (${positionals.join(" ")}).\nUsage: ${USAGE}`,
		);
	}
	const [name] = positionals;
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		throw new Refusal(
			`The claim name ${JSON.stringify(name)} holds characters an artifact name or file name cannot; claims are named proof-claim-<attempt>-<block>.`,
		);
	}
	if (values.mode !== "create" && values.mode !== "steal") {
		throw new Refusal(
			`--mode is create or steal; got ${JSON.stringify(values.mode)}.`,
		);
	}
	let shard;
	if (values.mode === "steal") {
		const match = /^(\d+)\/(\d+)$/.exec(values.shard ?? "");
		const [index, total] = match ? [Number(match[1]), Number(match[2])] : [];
		if (!match || total < 1 || index < 1 || index > total) {
			throw new Refusal(
				`--mode steal needs --shard I/N, this shard's place among the N that claim (such as 3/14); got ${JSON.stringify(values.shard)}.`,
			);
		}
		shard = { index, total };
	}
	return {
		name,
		mode: values.mode,
		shard,
		by: values.by ?? process.env.PROOF_CLAIMANT ?? "unnamed",
		cache: values["listing-cache"],
		cacheAge: seconds(values["listing-age"], "--listing-age"),
		poll: seconds(values.poll, "--poll"),
		resolve: seconds(values["resolve-seconds"], "--resolve-seconds"),
	};
}

/** The run's artifact names, as the latest listing kept in the cache saw them, if it is recent enough. */
async function cachedNames(settings) {
	if (!settings.cache) return undefined;
	try {
		const kept = JSON.parse(await readFile(settings.cache, "utf8"));
		if (Date.now() - kept.at > settings.cacheAge * 1000) return undefined;
		return new Set(kept.names);
	} catch {
		return undefined;
	}
}

/** A fresh listing of the run's artifacts, kept in the cache for the claims after this one. */
async function listed(settings, counts) {
	counts.listings += 1;
	const artifacts = await listAll();
	if (settings.cache) {
		const staged = `${settings.cache}.${process.pid}`;
		await writeFile(
			staged,
			JSON.stringify({
				at: Date.now(),
				names: artifacts.map((artifact) => artifact.name),
			}),
		);
		await rename(staged, settings.cache);
	}
	return artifacts;
}

function content(settings, name) {
	return `${JSON.stringify({ claim: settings.name, artifact: name, by: settings.by })}\n`;
}

async function created(settings, name, counts) {
	counts.creations += 1;
	return create(name, content(settings, name));
}

async function byCreation(settings, counts) {
	const { name } = settings;
	const cached = await cachedNames(settings);
	if (cached?.has(name)) {
		return {
			outcome: "taken",
			reason: `A listing of this run taken moments ago already holds the claim ${name}, so another shard owns its block.`,
		};
	}
	let id;
	try {
		id = await created(settings, name, counts);
	} catch (error) {
		if (error.status === 409) {
			return {
				outcome: "taken",
				reason: `The run already holds the claim ${name} (the service refused to create it again), so another shard owns its block.`,
			};
		}
		throw error;
	}
	const same = (await listed(settings, counts))
		.filter((artifact) => artifact.name === name)
		.map((artifact) => artifact.id);
	if (!same.includes(id)) {
		return {
			outcome: "failed",
			artifactId: id,
			listed: same,
			reason:
				`The service finalized this shard's claim ${name} as artifact ${id}, and a listing taken after that does not hold it (it holds ${JSON.stringify(same)}).\n` +
				"The claims rest on a listing showing every finalized artifact, so this shard claims nothing more; the block stays unrun, and the gate reports it.",
		};
	}
	if (same.length > 1) {
		return {
			outcome: "duplicate",
			artifactId: id,
			listed: same,
			reason:
				`The service created ${same.length} artifacts named ${name} (ids ${same.join(", ")}): it accepted a name the run already held, so a created name is not an exclusive claim here.\n` +
				"This shard yields the block. If every claimant yields it, it is left unrun and the gate reports it; claims that may run concurrently then belong to --mode steal.",
		};
	}
	return {
		outcome: "claimed",
		artifactId: id,
		listed: same,
		reason: `This shard holds the claim ${name} (artifact ${id}).`,
	};
}

/** What the run's artifact names say of one block's markers (--mode steal). */
function markers(names, name) {
	const state = {
		owner: false,
		intents: new Set(),
		commits: new Set(),
		withdrawals: new Set(),
	};
	const prefix = `${name}.`;
	for (const artifact of names) {
		if (!artifact.startsWith(prefix)) continue;
		const rest = artifact.slice(prefix.length);
		if (rest === "owner") {
			state.owner = true;
			continue;
		}
		const match = /^(intent|commit|withdraw)-(\d+)$/.exec(rest);
		if (!match) continue;
		const shard = Number(match[2]);
		({
			intent: state.intents,
			commit: state.commits,
			withdraw: state.withdrawals,
		})[match[1]].add(shard);
	}
	return state;
}

const names = (artifacts) => artifacts.map((artifact) => artifact.name);

async function byOwnership(settings, counts) {
	const { name } = settings;
	const { index, total } = settings.shard;
	const owner = ownerOf(name, total);
	const before = markers(
		(await cachedNames(settings)) ?? names(await listed(settings, counts)),
		name,
	);
	if (index === owner) {
		if (before.commits.size > 0) {
			return {
				outcome: "taken",
				owner,
				reason: `Shard ${[...before.commits].join(", ")} committed to the block of ${name} before this shard, its owner, reached it.`,
			};
		}
		await created(settings, `${name}.owner`, counts);
		const started = performance.now();
		let state = markers(names(await listed(settings, counts)), name);
		const declared = [...state.intents];
		for (;;) {
			const open = declared.filter(
				(shard) => !state.commits.has(shard) && !state.withdrawals.has(shard),
			);
			if (open.length === 0) break;
			if (performance.now() - started > settings.resolve * 1000) {
				return {
					outcome: "failed",
					owner,
					reason:
						`Shard ${open.join(", ")} declared it would take the block of ${name} and neither committed nor withdrew within ${settings.resolve} s.\n` +
						"This shard, its owner, cannot tell whether it runs the block, so it leaves the block and claims nothing more; the gate reports the block if no shard ran it.",
				};
			}
			await sleep(settings.poll * 1000);
			state = markers(names(await listed(settings, counts)), name);
		}
		if (state.commits.size > 0) {
			return {
				outcome: "taken",
				owner,
				reason: `Shard ${[...state.commits].join(", ")} committed to the block of ${name} before this shard, its owner, marked it.`,
			};
		}
		return {
			outcome: "claimed",
			owner,
			reason: `This shard owns the block of ${name}, and no other shard committed to it.`,
		};
	}
	if (before.owner || before.intents.size > 0 || before.commits.size > 0) {
		return {
			outcome: "taken",
			owner,
			reason: `The block of ${name} is already marked by its owner (shard ${owner}) or wanted by another shard.`,
		};
	}
	await created(settings, `${name}.intent-${index}`, counts);
	const state = markers(names(await listed(settings, counts)), name);
	const others =
		state.owner ||
		[...state.intents].some((shard) => shard !== index) ||
		[...state.commits].some((shard) => shard !== index);
	if (others) {
		await created(settings, `${name}.withdraw-${index}`, counts);
		return {
			outcome: "taken",
			owner,
			reason: `Another shard wanted the block of ${name} as this one did (or its owner, shard ${owner}, marked it), so this shard withdrew.`,
		};
	}
	await created(settings, `${name}.commit-${index}`, counts);
	return {
		outcome: "claimed",
		owner,
		reason: `This shard took the block of ${name} from its owner, shard ${owner}, which had not reached it.`,
	};
}

const OUTCOME_EXIT = {
	claimed: EXIT.claimed,
	taken: EXIT.taken,
	duplicate: EXIT.taken,
	failed: EXIT.failed,
};

async function main() {
	const record = recordsOnStdout();
	const started = performance.now();
	const counts = { creations: 0, listings: 0 };
	let settings;
	let result;
	try {
		settings = options(process.argv.slice(2));
		result = await (settings.mode === "create" ? byCreation : byOwnership)(
			settings,
			counts,
		);
	} catch (error) {
		result = {
			outcome: "failed",
			reason:
				error instanceof Refusal ? error.message : `${error?.message ?? error}`,
		};
	}
	await record({
		name: settings?.name,
		mode: settings?.mode,
		shard: settings?.shard && `${settings.shard.index}/${settings.shard.total}`,
		by: settings?.by,
		...result,
		...counts,
		seconds: Math.round(performance.now() - started) / 1000,
	});
	process.stderr.write(`${result.reason}\n`);
	return OUTCOME_EXIT[result.outcome];
}

process.exitCode = await main();
