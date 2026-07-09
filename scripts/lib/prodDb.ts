/**
 * `--prod` target resolution for the inspect scripts.
 *
 * Points the shared connection layer (`lib/case-store/postgres/connection.ts`)
 * at the production Cloud SQL instance over its PUBLIC IP. The instance has no
 * authorized networks, so the only way in is the Cloud SQL connector's
 * IAM-authenticated TLS path — the same connector Cloud Run rides over the
 * private IP, here carrying your gcloud identity instead of the runtime SA.
 *
 * Prerequisites, per developer (provisioned by
 * `scripts/infra/provision-cloud-sql.sh` Phases 4–5 for the dogfooding team):
 *
 *   - your account is a `CLOUD_IAM_USER` on the instance and holds
 *     `roles/cloudsql.client` + `roles/cloudsql.instanceUser` on the project
 *   - your database user is a member of `pg_read_all_data` (the inspect
 *     scripts are read-only; nothing here grants writes)
 *   - `gcloud auth application-default login` on the SAME account as
 *     `gcloud auth login` — IAM database auth presents your ADC identity,
 *     and the database user derived below must match it
 *
 * Every value is an env-level DEFAULT (`NOVA_DB_*` set in the shell wins),
 * except `NOVA_DB_LOCAL_URL`, which `--prod` unconditionally clears: the
 * local-dev opt-in wins inside `initialize()`, and the whole point of the
 * flag is "not the compose container".
 */

import { execFileSync } from "node:child_process";

const PROD_DB_NAME = "nova_cases";
const PROD_INSTANCE_CONNECTION_NAME = "commcare-nova:us-central1:nova-cases";

/** Assign only when the var is absent or empty — explicit env wins. */
function defaultEnv(name: string, value: string): void {
	const current = process.env[name];
	if (current === undefined || current.length === 0) {
		process.env[name] = value;
	}
}

/**
 * Resolve the caller's IAM database user from the active gcloud account.
 * A human's Cloud SQL IAM username is their full account email.
 */
function gcloudAccount(): string {
	let account = "";
	try {
		account = execFileSync("gcloud", ["config", "get-value", "account"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// Fall through to the shared throw — same remedy either way.
	}
	if (account.length > 0 && account !== "(unset)") {
		return account;
	}
	throw new Error(
		[
			"Could not derive the IAM database user for --prod.",
			"",
			"    tried: gcloud config get-value account",
			"",
			"The --prod flag connects to production Cloud SQL as YOUR gcloud",
			"identity, so it needs an active gcloud account to derive the",
			"database username from.",
			"",
			"Hint: run `gcloud auth login`, or set NOVA_DB_USER to your Cloud SQL",
			"IAM username explicitly.",
		].join("\n"),
	);
}

/**
 * Point `process.env` at the production instance. Call after
 * `program.parse()` and before the first database access — the connection
 * layer is a lazy singleton, so env set here is env it reads.
 */
export function targetProdDb(): void {
	delete process.env.NOVA_DB_LOCAL_URL;
	defaultEnv("NOVA_DB_IP_TYPE", "PUBLIC");
	defaultEnv("NOVA_DB_NAME", PROD_DB_NAME);
	defaultEnv("NOVA_DB_INSTANCE_CONNECTION_NAME", PROD_INSTANCE_CONNECTION_NAME);
	defaultEnv("NOVA_DB_USER", gcloudAccount());
}
