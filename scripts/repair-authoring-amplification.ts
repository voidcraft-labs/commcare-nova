/** Writes only with --apply; requires exact scan evidence and a private snapshot. */
import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	inspectAuthoringAmplification,
	repairAuthoringAmplification,
} from "./lib/authoringAmplificationStore";
import { requireArg, runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.argument("<thread-id>")
	.requiredOption("--guard-digest <sha256>")
	.requiredOption("--transcript-digest <sha256>")
	.option("--apply", "apply the guarded repair; default only verifies")
	.option(
		"--evidence-file <path>",
		"new private JSON snapshot file; required with --apply",
	)
	.option("--prod", "target production through the operator IAM connection")
	.parse();
const options = program.opts<{
	guardDigest: string;
	transcriptDigest: string;
	apply?: boolean;
	evidenceFile?: string;
	prod?: boolean;
}>();
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const threadId = requireArg(program.args, 0, "thread-id");
		if (options.apply) {
			if (!options.evidenceFile)
				throw new Error(
					"--apply requires --evidence-file with a new private snapshot path.",
				);
			const evidence = await inspectAuthoringAmplification(threadId);
			if (
				!evidence ||
				evidence.guardDigest !== options.guardDigest ||
				evidence.transcriptDigest !== options.transcriptDigest
			)
				throw new Error("Scan evidence changed. Scan again.");
			await writeFile(
				options.evidenceFile,
				JSON.stringify(evidence.snapshot, null, 2),
				{ flag: "wx", mode: 0o600 },
			);
		}
		console.log(
			JSON.stringify(
				await repairAuthoringAmplification({
					threadId,
					guardDigest: options.guardDigest,
					transcriptDigest: options.transcriptDigest,
					apply: options.apply === true,
				}),
			),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
