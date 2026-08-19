import "server-only";

/**
 * The one place a worker's password comes from.
 *
 * Its own module, small as it is, because the rule that matters about it
 * is not how it is built but where it may go: into the answer of the call
 * that made the account, once, and nowhere else. It is never written to
 * Postgres, never handed to `log.*` or the run's `LogWriter`, and never
 * put in a request Nova logs the body of. A test pins that
 * (`__tests__/workerCredentials.test.ts`); this comment is the reason.
 *
 * Nova generates one because it must. CommCare HQ's two-stage
 * account-confirmation branch, which lets a person set their own password
 * from an email, fires only when the create asks for it AND the project
 * space holds the `TWO_STAGE_MOBILE_WORKER_ACCOUNT_CREATION` privilege
 * (`api/resources/v0_5.py::CommCareUserResource.obj_create`). Nova asks
 * for neither, so the plain branch applies and refuses a create without a
 * password: `"Password or connect username required"`.
 */

/**
 * How long a generated password is.
 *
 * CommCare HQ's own `users/forms.py::generate_strong_password` uses
 * twelve. This uses twenty for the same work, which costs the person
 * nothing — they copy it once and CommCare asks them to change it — and
 * leaves room for the alphabet below to be the readable one rather than
 * the dense one.
 */
const PASSWORD_LENGTH = 20;

/**
 * The alphabet, minus every pair a person can mistake for each other when
 * they read a password off a screen and type it into a phone: no `l` or
 * `1` or `I`, no `O` or `0`. A password that cannot be typed is a support
 * call, and the entropy given up is a rounding error at this length.
 *
 * The four groups are separate so the result can be GUARANTEED to carry
 * one of each, which is the shape CommCare HQ's own generator promises
 * and what its `strong_mobile_passwords` rule
 * (`domain/extension_points.py::validate_password_rules`) scores well.
 */
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
/** Punctuation every mobile keyboard reaches without a second page. */
const PUNCTUATION = "!@#$%&*?-+=";
const ALPHABET = LOWER + UPPER + DIGITS + PUNCTUATION;

/**
 * A password for one new worker.
 *
 * Uniform over the alphabet through `crypto.getRandomValues` with the
 * modulo bias rejected rather than ignored, then guaranteed to carry one
 * character from each group by placing four at random positions. The
 * guarantee is what stops a run of twenty lowercase letters from being
 * refused by a project space that scores passwords.
 */
export function generateWorkerPassword(): string {
	const characters = Array.from({ length: PASSWORD_LENGTH }, () =>
		pick(ALPHABET),
	);
	/* Four distinct positions, so seeding one group cannot overwrite
	 * another and undo its own guarantee. */
	const positions = distinctPositions(4, PASSWORD_LENGTH);
	const groups = [LOWER, UPPER, DIGITS, PUNCTUATION];
	for (const [index, position] of positions.entries()) {
		const group = groups[index];
		if (group !== undefined) characters[position] = pick(group);
	}
	return characters.join("");
}

/** One character, uniformly, with the modulo bias rejected. */
function pick(alphabet: string): string {
	const limit = Math.floor(256 / alphabet.length) * alphabet.length;
	const byte = new Uint8Array(1);
	let value = limit;
	while (value >= limit) {
		crypto.getRandomValues(byte);
		value = byte[0] as number;
	}
	return alphabet[value % alphabet.length] as string;
}

/** `count` different indexes into a string of `length`. */
function distinctPositions(count: number, length: number): readonly number[] {
	const positions = new Set<number>();
	while (positions.size < count) {
		positions.add(pickIndex(length));
	}
	return [...positions];
}

function pickIndex(length: number): number {
	const limit = Math.floor(256 / length) * length;
	const byte = new Uint8Array(1);
	let value = limit;
	while (value >= limit) {
		crypto.getRandomValues(byte);
		value = byte[0] as number;
	}
	return value % length;
}
