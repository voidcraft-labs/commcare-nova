import type { AndroidAppAction } from "@/lib/domain/fields/androidApp";
import type { Uuid } from "@/lib/domain/uuid";

type MatchStrength =
	| "five_stars"
	| "four_stars"
	| "three_stars"
	| "two_stars"
	| "one_star";
export interface AndroidAppMatch {
	readonly guid: string;
	readonly confidence: number;
	readonly strength: MatchStrength;
}

/** A local capture accompanies a text value only if the worker chose its
 * bytes. A returned URI is never fetched by the browser or server. */
export interface AndroidAppResultValue {
	readonly value: string | null;
	readonly file?: File;
}
type NamedValues = ReadonlyMap<string, AndroidAppResultValue>;

/** The parcel enums supply these names; organization-specific names only
 * belong to ordinary named results. Simprints returns empty bytes for every
 * finger it did not scan (libsimprints 2024.2.2 Registration.getTemplate). */
export const IDENTITY_TEMPLATE_NAMES: readonly string[] = [
	...["right", "left"].flatMap((side) =>
		[
			"thumb",
			"index_finger",
			"middle_finger",
			"ring_finger",
			"pinky_finger",
		].map((finger) => `${side}_${finger}_template`),
	),
	"face_template",
];
export const SIMPRINTS_TEMPLATE_NAMES: readonly string[] = [
	"RIGHT_5TH_FINGER",
	"RIGHT_4TH_FINGER",
	"RIGHT_3RD_FINGER",
	"RIGHT_INDEX_FINGER",
	"RIGHT_THUMB",
	"LEFT_THUMB",
	"LEFT_INDEX_FINGER",
	"LEFT_3RD_FINGER",
	"LEFT_4TH_FINGER",
	"LEFT_5TH_FINGER",
];
interface Registration {
	readonly guid: string | null;
	readonly templates: ReadonlyMap<string, Uint8Array>;
}

/** These are independent returned parcels. Android checks for a recognized
 * parcel before interpreting an ordinary primary answer or result bundle. */
export interface AndroidAppReturn {
	readonly registration?: Registration;
	readonly verification?: AndroidAppMatch;
	readonly identification?: readonly AndroidAppMatch[];
	readonly simprintsRegistration?: Registration;
	readonly primary?: string | null;
	readonly extras?: NamedValues;
	readonly bundle?: NamedValues;
}

export interface AndroidAppWrite {
	readonly question: Uuid;
	readonly value: string;
	/** A generic named result targeting a capture copies the chosen file. */
	readonly capture?: { readonly file?: File };
}

export interface AndroidAppWrites {
	readonly writes: readonly AndroidAppWrite[];
	readonly reportedSuccess: boolean;
}

const STARS: Record<MatchStrength, string> = {
	five_stars: "★★★★★",
	four_stars: "★★★★",
	three_stars: "★★★",
	two_stars: "★★",
	one_star: "★",
};

function templateText(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	// Android Base64.DEFAULT terminates every nonempty 76-character line.
	return btoa(binary).replace(/.{1,76}/g, "$&\n");
}

export interface AndroidAppMessages {
	registration: (outcome: "success" | "partial" | "failed") => string;
	scanned: (count: number) => string;
}

/** IntentCallout walks the form's response Hashtable, independently of the
 * order extras arrived in. A freshly parsed form on Android 15 uses libcore’s
 * default Hashtable, with String hashes,
 * prepended bucket chains and descending bucket enumeration. Order becomes
 * observable when two distinct returned names fill the same answer. */
function androidResponseNames(names: Iterable<string>): string[] {
	let buckets: string[][] = Array.from({ length: 11 }, () => []);
	const add = (name: string) => {
		let hash = 0;
		for (let i = 0; i < name.length; i++)
			hash = (Math.imul(hash, 31) + name.charCodeAt(i)) | 0;
		buckets[(hash & 0x7fffffff) % buckets.length]?.push(name);
	};
	let size = 0;
	for (const name of names) {
		if (size >= Math.floor(buckets.length * 0.75)) {
			const old = buckets;
			buckets = Array.from({ length: 2 * old.length + 1 }, () => []);
			for (let i = old.length - 1; i >= 0; i--)
				for (const entry of old[i]?.reverse() ?? []) add(entry);
		}
		add(name);
		size++;
	}
	return buckets.reverse().flatMap((bucket) => bucket.reverse());
}

/** Native result order matters when an input is also a mapped destination.
 * No writes take place for a cancelled, missing or unreadable result. */
export function androidAppWrites(
	invoking: Uuid,
	action: AndroidAppAction,
	result: AndroidAppReturn | null,
	messages: AndroidAppMessages,
): AndroidAppWrites {
	const writes: AndroidAppWrite[] = [];
	const primary = (value: string) => writes.push({ question: invoking, value });
	const destinationsByName = new Map<string, Uuid[]>();
	for (const { name, question } of action.receive) {
		const destinations = destinationsByName.get(name);
		if (destinations) destinations.push(question);
		else destinationsByName.set(name, [question]);
	}
	const named = (
		name: string,
		value: string | null,
		capture?: AndroidAppWrite["capture"],
	) => {
		if (value === null) return false;
		const destinations = destinationsByName.get(name);
		if (!destinations) return false;
		for (const question of destinations)
			writes.push({ question, value, ...(capture && { capture }) });
		return destinations.length > 0;
	};
	const match = (item: AndroidAppMatch) => {
		named("match_guid", item.guid);
		named("match_confidence", String(item.confidence));
		named("match_strength", item.strength);
	};
	if (result === null) return { writes, reportedSuccess: false };
	if (result.registration) {
		const { guid, templates } = result.registration;
		named("guid", guid);
		let saved = 0;
		for (const [name, bytes] of templates)
			if (named(name, templateText(bytes))) saved++;
		const outcome =
			saved === templates.size ? "success" : saved ? "partial" : "failed";
		primary(messages.registration(outcome));
		for (const key of ["match_guid", "match_confidence", "match_strength"])
			named(key, "");
		return { writes, reportedSuccess: Boolean(guid) };
	}
	if (result.verification) {
		match(result.verification);
		primary(STARS[result.verification.strength]);
		return { writes, reportedSuccess: Boolean(result.verification.guid) };
	}
	if (result.identification) {
		// IdentificationMatch orders by descending confidence and keeps ties in input order.
		const best = result.identification.reduce<AndroidAppMatch | undefined>(
			(current, item) =>
				!current || item.confidence > current.confidence ? item : current,
			undefined,
		);
		if (best) {
			match(best);
			named("guid", "");
		}
		return { writes, reportedSuccess: best !== undefined };
	}
	if (result.simprintsRegistration) {
		const { guid, templates } = result.simprintsRegistration;
		let count = 0;
		for (const name of SIMPRINTS_TEMPLATE_NAMES) {
			const bytes = templates.get(name);
			if (named(name, bytes ? templateText(bytes) : "") && bytes?.length)
				count++;
		}
		named("guid", guid);
		primary(messages.scanned(count));
		return { writes, reportedSuccess: guid !== null || count > 0 };
	}
	// The primary is itself one of the direct Android extras. It may
	// simultaneously be named as a destination (e.g. a typed copy).
	const direct = new Map(result.extras);
	if (result.primary !== undefined)
		direct.set("odk_intent_data", { value: result.primary });
	const response = direct.get("odk_intent_data")?.value;
	primary(response ?? "");
	let mapped = false;
	const values = result.bundle ?? direct;
	for (const key of androidResponseNames(destinationsByName.keys())) {
		const returned = values.get(key);
		if (!returned) continue;
		if (
			named(key, returned.value ?? "", {
				...(returned.file && { file: returned.file }),
			})
		)
			mapped = true;
	}
	return {
		writes,
		reportedSuccess:
			response != null || (result.bundle === undefined && mapped),
	};
}
