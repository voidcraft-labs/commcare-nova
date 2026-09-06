import type {
	ProvisionedWorker,
	UnconfirmedWorker,
} from "./workerProvisionPlan";

export interface WorkerCredentialRow {
	readonly key: string;
	readonly personaName: string;
	readonly username: string;
	readonly password: string | null;
	readonly uncertainty: "account" | "password" | null;
	readonly dismissKey: string | null;
}

/** Display and clipboard share every candidate. Adopting an account confirms
 * its existence, not which password a sequence of uncertain creates set. */
export function workerCredentialRows(
	workers: readonly ProvisionedWorker[],
	unconfirmed: readonly (readonly [string, UnconfirmedWorker])[],
): readonly WorkerCredentialRow[] {
	const sameAccount = (
		a: { personaUuid: string; username: string },
		b: { personaUuid: string; username: string },
	) => a.personaUuid === b.personaUuid && a.username === b.username;
	return [
		...workers
			.filter(
				(worker) =>
					worker.password !== null ||
					!unconfirmed.some(([, candidate]) => sameAccount(worker, candidate)),
			)
			.map((worker) => ({
				key: `confirmed:${worker.personaUuid}:${worker.userId}`,
				personaName: worker.personaName,
				username: worker.username,
				password: worker.password,
				uncertainty: null,
				dismissKey: null,
			})),
		...unconfirmed.map(([key, candidate]) => ({
			key: `unconfirmed:${key}`,
			personaName: candidate.personaName,
			username: candidate.username,
			password: candidate.password,
			uncertainty: workers.some((worker) => sameAccount(worker, candidate))
				? ("password" as const)
				: ("account" as const),
			dismissKey: key,
		})),
	];
}

export function workerCredentialStatus(
	row: WorkerCredentialRow,
): string | null {
	return row.uncertainty === "account"
		? "Account unconfirmed"
		: row.uncertainty === "password"
			? "Password unconfirmed"
			: null;
}

export function workerCredentialsText(
	rows: readonly WorkerCredentialRow[],
): string {
	return rows
		.filter((row) => row.password !== null)
		.map((row) =>
			[row.username, row.password, workerCredentialStatus(row)]
				.filter((part) => part !== null)
				.join("\t"),
		)
		.join("\n");
}
