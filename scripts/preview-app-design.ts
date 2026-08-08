/**
 * Preview the design pipeline's EXACT artifacts for a described app — the
 * author's Design Contract, the independent review, the reviser's
 * dispositions, and the build plan — without a chat run, an app, or a
 * database row.
 *
 * Drives the REAL calls (`runDesignAuthor` / `runDesignReviewer` /
 * `runDesignReviser` / `runDesignPlanner`: same prompts, same schemas, same
 * provider options the pipeline uses) over a synthetic in-memory source
 * package built from the request text you pass, then prints stage summaries
 * and writes each full artifact as JSON beside your output directory.
 * Nothing persists to Postgres — this previews artifact QUALITY, not the
 * durable pipeline (`lib/agent/design/pipeline.ts` owns that).
 *
 * Usage:
 *   npx tsx --conditions=react-server scripts/preview-app-design.ts \
 *     --out /tmp/design "Track CHW home visits..."
 *
 * The `--conditions=react-server` flag is required, exactly as it is for
 * `npm run test:schema`: the capability catalog imports the shared tool
 * registry, whose graph reaches `server-only` — under plain Node its bare
 * default export throws before this script prints anything, while the
 * condition resolves it to the package's own no-op.
 *
 * Reads OPENAI_API_KEY from .env.
 * ⚠️ Cost: 2–4 live gpt-5.6-sol calls at high/xhigh reasoning — this is the
 * expensive half of a build. Ask before running it on a shared key.
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDesignAuthor } from "../lib/agent/design/author";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "../lib/agent/design/capabilityCatalog";
import { DesignGenerationContext } from "../lib/agent/design/designGenerationContext";
import { runDesignPlanner } from "../lib/agent/design/planner";
import { PLATFORM_CONSTRAINTS } from "../lib/agent/design/platformConstraints";
import { runDesignReviewer } from "../lib/agent/design/reviewer";
import { runDesignReviser } from "../lib/agent/design/reviser";
import {
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "../lib/agent/design/sourcePackage";

function usage(): never {
	console.log(
		"Usage: npx tsx --conditions=react-server scripts/preview-app-design.ts " +
			'[--out <dir>] "<request text>"\n' +
			"(--conditions=react-server is required — the tool-registry import " +
			"graph reaches server-only)\n" +
			"⚠️ Sends 2–4 live gpt-5.6-sol calls (the design half of a build).",
	);
	process.exit(1);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.length === 0) usage();
	let outDir = "design-preview";
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--out") {
			outDir = argv[i + 1] ?? usage();
			i += 1;
		} else {
			rest.push(argv[i] as string);
		}
	}
	const request = rest.join(" ").trim();
	if (!request) usage();
	if (!process.env.OPENAI_API_KEY) {
		console.error("OPENAI_API_KEY is not set — nothing was sent.");
		process.exit(1);
	}

	mkdirSync(outDir, { recursive: true });
	const write = (name: string, value: unknown) => {
		const path = join(outDir, name);
		writeFileSync(path, JSON.stringify(value, null, 2));
		console.log(`  wrote ${path}`);
	};

	const sessionId = crypto.randomUUID();
	const threadId = crypto.randomUUID();
	const usageTotals = { inputTokens: 0, outputTokens: 0 };
	const ctx = new DesignGenerationContext({
		apiKey: process.env.OPENAI_API_KEY,
		userId: "preview",
		projectId: "preview",
		runId: `preview-${sessionId.slice(0, 8)}`,
		designSessionId: sessionId,
		meter: {
			track(u) {
				usageTotals.inputTokens += u.inputTokens;
				usageTotals.outputTokens += u.outputTokens;
			},
		},
	});
	const unsealed: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: sessionId,
		projectId: "preview",
		request: {
			blocks: [
				{
					ref: {
						kind: "message",
						threadId,
						messageId: "preview-request",
						partIndex: 0,
					},
					text: request,
					truncated: false,
				},
			],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: Object.values(PLATFORM_CONSTRAINTS),
		sources: [
			{
				ref: {
					kind: "message",
					threadId,
					messageId: "preview-request",
					partIndex: 0,
				},
			},
		],
	};
	const pkg: DesignSourcePackage = {
		...unsealed,
		packageDigest: computeSourcePackageDigest(unsealed),
	};
	const signal = new AbortController().signal;
	const catalogText = renderCapabilityCatalog(buildCapabilityCatalog());

	console.log("Authoring the Design Contract (xhigh reasoning — minutes)…");
	const authored = await runDesignAuthor(ctx, pkg, catalogText, signal);
	if (authored.kind !== "produced") {
		console.error(`Author produced nothing: ${authored.reason}`);
		process.exit(1);
	}
	let contract = authored.artifact;
	write("contract-draft.json", contract);
	console.log(
		`  ${contract.actors.length} actors, ${contract.tasks.length} tasks, ${contract.records.length} records, ${contract.facts.length} facts, ${contract.openQuestions.length} open questions`,
	);

	console.log("Reviewing (independent fresh context)…");
	const reviewed = await runDesignReviewer(
		ctx,
		{ pkg, contract, catalogText },
		signal,
	);
	if (reviewed.kind !== "produced") {
		console.error(`Reviewer produced nothing: ${reviewed.reason}`);
		process.exit(1);
	}
	write("review.json", reviewed.artifact);
	const gated = reviewed.artifact.findings.filter(
		(f) => f.severity !== "advisory",
	);
	console.log(
		`  ${reviewed.artifact.findings.length} findings (${gated.length} critical/important)`,
	);

	if (gated.length > 0) {
		console.log("Revising with dispositions…");
		const revised = await runDesignReviser(
			ctx,
			{ pkg, contract, reviews: [reviewed.artifact], catalogText },
			signal,
		);
		if (revised.kind !== "produced") {
			console.error(`Reviser produced nothing: ${revised.reason}`);
			process.exit(1);
		}
		contract = revised.artifact.contract;
		write("contract-revised.json", contract);
		write("dispositions.json", revised.artifact.dispositions);
	}

	const blocking = contract.openQuestions.filter((q) => q.blocking);
	if (blocking.length > 0) {
		console.log(
			`Stopping before the plan: ${blocking.length} blocking question(s) —`,
		);
		for (const q of blocking) console.log(`  - ${q.question}`);
	} else {
		console.log("Planning build slices…");
		const planned = await runDesignPlanner(
			ctx,
			{ contract, catalogText },
			signal,
		);
		if (planned.kind !== "produced") {
			console.error(`Planner produced nothing: ${planned.reason}`);
			process.exit(1);
		}
		write("build-plan-draft.json", planned.artifact);
		console.log(`  ${planned.artifact.slices.length} slices`);
	}

	console.log(
		`Done. Tokens: ${usageTotals.inputTokens.toLocaleString()} in / ${usageTotals.outputTokens.toLocaleString()} out.`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
