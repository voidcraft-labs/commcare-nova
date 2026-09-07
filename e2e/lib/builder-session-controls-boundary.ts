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
