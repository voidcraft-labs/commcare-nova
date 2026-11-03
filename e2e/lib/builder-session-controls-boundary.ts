/** Controlled Next Server Action serialization; the actual persona component,
 * document mutations and session remain mounted in the native browser. */
export async function countCasesOwnedByAction(args: unknown) {
	const response = await fetch("/persona-count", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	if (!response.ok) throw new Error("Persona count transport unavailable");
	return response.json();
}

// These component scenarios do not open journey history. Its real action and
// database path are exercised by the production-build app-tests smoke test.
export async function listAppTestsAction() {
	throw new Error("Unexpected journey read in session controls scenario");
}
export async function readAppTestAction() {
	throw new Error("Unexpected journey read in session controls scenario");
}

/** The running worker's claims, counted and released through the same
 * controlled transport, so the test owns what the menu reads and observes
 * what it sends. */
export async function countClaimedCasesAction(args: unknown) {
	const response = await fetch("/claimed-cases/count", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	if (!response.ok) throw new Error("Claim count transport unavailable");
	return response.json();
}
export async function releaseClaimedCasesAction(args: unknown) {
	const response = await fetch("/claimed-cases/release", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	if (!response.ok) throw new Error("Claim release transport unavailable");
	return response.json();
}
