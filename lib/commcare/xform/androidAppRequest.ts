/** Android IntentCallout.generate evaluates each sent value at the invoking
 * question. Its compound switch is the only boolean. IntentWidget adds the
 * question's previous answer last when it is nonempty. */
export function androidAppRequest(
	args: readonly {
		readonly name: string;
		readonly text: string;
		readonly truth: boolean;
	}[],
	currentAnswer: string,
): ReadonlyMap<string, string | boolean> {
	const values = new Map<string, string | boolean>();
	for (const arg of args) {
		if (arg.name === "cc:compound_include") values.set(arg.name, arg.truth);
		else if (arg.text !== "") values.set(arg.name, arg.text);
	}
	if (currentAnswer !== "") values.set("odk_intent_data", currentAnswer);
	return values;
}
