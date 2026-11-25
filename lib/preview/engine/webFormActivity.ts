// The notice a Web Apps worker sees when another worker has recently opened
// or submitted the same form for the same record. A restore watermark belongs
// to the person reading the notice, not the worker who left the record.
export interface WebFormActivity {
	readonly workerId: string;
	readonly workerName: string;
	readonly title: string | null;
	readonly windowSeconds: number;
	readonly kind: "opened" | "submitted";
	readonly at: number;
}

export interface WebFormActivityNotice {
	readonly workerName: string;
	readonly title: string | null;
	readonly kind: "opened" | "submitted";
	readonly at: number;
	readonly dataMayHaveChanged: boolean;
}

// Integer.parseInt reads individual UTF-16 chars, including decimal digits
// in the BMP. Each contiguous run of decimal digits starts at zero.
function decimalDigit(character: string): number {
	const code = character.charCodeAt(0);
	if (code >= 48 && code <= 57) return code - 48;
	if (!/\p{Decimal_Number}/u.test(character)) return -1;
	let start = code;
	while (/\p{Decimal_Number}/u.test(String.fromCharCode(start - 1))) start--;
	return (code - start) % 10;
}

export function webFormActivityWindow(text: string | null): number {
	if (!text) return 300;
	const negative = text[0] === "-";
	const start = negative || text[0] === "+" ? 1 : 0;
	if (start === text.length) return 300;
	const limit = negative ? 2147483648 : 2147483647;
	let value = 0;
	for (let index = start; index < text.length; index++) {
		const digit = decimalDigit(text.charAt(index));
		if (digit < 0) return 300;
		value = value * 10 + digit;
		if (value > limit) return 300;
	}
	return negative ? -value : Math.min(value, 3600);
}

/** Read the previous event and decide what to write while holding the key.
 * Keeping a submission on open must also leave its original expiry intact. */
export function nextWebFormActivity(
	prior: WebFormActivity | null,
	event: WebFormActivity,
	lastRestore: number,
): { write: WebFormActivity | null; notice: WebFormActivityNotice | null } {
	const existing =
		prior && prior.at + prior.windowSeconds * 1000 > event.at ? prior : null;
	const otherWorker = existing !== null && existing.workerId !== event.workerId;
	let write: WebFormActivity | null = event;
	let notice: WebFormActivityNotice | null = null;
	if (event.kind === "opened") {
		if (existing?.kind === "submitted") write = null;
		if (
			otherWorker &&
			(existing.kind === "opened" || existing.at >= lastRestore)
		) {
			notice = {
				workerName: existing.workerName,
				title: existing.title,
				kind: existing.kind,
				at: existing.at,
				dataMayHaveChanged:
					existing.kind === "submitted" && existing.at > lastRestore,
			};
		}
	} else if (existing && !otherWorker) {
		write = {
			...event,
			title: existing.title,
			windowSeconds: existing.windowSeconds,
		};
	}
	if (write && write.windowSeconds <= 0) {
		throw new Error(
			"The activity notice needs a time window greater than zero seconds. Change the window for this form and try again.",
		);
	}
	return { write, notice };
}
