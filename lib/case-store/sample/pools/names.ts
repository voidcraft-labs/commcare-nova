// lib/case-store/sample/pools/names.ts
//
// Static name pools the heuristic generator picks from for `text`-typed
// properties whose name shape suggests a person. The pools are
// representative across regions so a sample-data demo doesn't read as
// monocultural; the generator's property-name heuristic (e.g. "name",
// "given_name", "household_head") chooses an arm of the pool when it
// can infer a more specific shape.
//
// Why static arrays, not an external API: the spec pins
// "deterministic per `(app, case-type, seed)`" — every pool the
// generator reads must produce the same sequence given the same seed.
// A live API breaks determinism, adds a network dependency, and gates
// CI on a third-party uptime SLO. The pools below are large enough
// that a 30-row default count exhibits good variety without
// perceptible repetition.
//
// Adding a name: append to the matching pool. The arrays are
// insertion-ordered and the seeded PRNG selects by index, so an
// inserted entry shifts every downstream selection — that is desired
// behavior because deterministic-output tests pin the seeded sequence
// and a pool change should produce a visible diff.

/**
 * Given names pulled from a globally varied set so a 30-row sample
 * exhibits visible variety. The pool intentionally mixes regional
 * origins; the generator does not infer locale from app context in
 * the current shape, so the global pool is what every text-shaped
 * "name" property reads from.
 */
export const GIVEN_NAMES: readonly string[] = [
	"Alice",
	"Aarav",
	"Adaeze",
	"Ahmed",
	"Amara",
	"Anh",
	"Ananya",
	"Beatriz",
	"Carlos",
	"Chen",
	"Chidinma",
	"Dilnoza",
	"Diego",
	"Elena",
	"Fatima",
	"Felipe",
	"Gita",
	"Hana",
	"Hiroshi",
	"Ibrahim",
	"Imani",
	"Jamil",
	"Jin",
	"Khadija",
	"Kofi",
	"Layla",
	"Linh",
	"Maya",
	"Mei",
	"Mwangi",
	"Naledi",
	"Niamh",
	"Omar",
	"Priya",
	"Quincy",
	"Rashid",
	"Rosa",
	"Saanvi",
	"Sofia",
	"Tariq",
	"Thandi",
	"Uchechi",
	"Valentina",
	"Wen",
	"Xiomara",
	"Yusuf",
	"Zara",
];

/**
 * Family names paired with the given-names pool. Same shape concerns
 * apply: globally varied, large enough for visible variety at the
 * default 30-row count.
 */
export const FAMILY_NAMES: readonly string[] = [
	"Adeyemi",
	"Akande",
	"Almeida",
	"Banerjee",
	"Cardoso",
	"Chakraborty",
	"Chen",
	"Diallo",
	"Eze",
	"Fernandes",
	"Garcia",
	"Gomez",
	"Hassan",
	"Hernandez",
	"Ibrahim",
	"Iyer",
	"Khan",
	"Kim",
	"Kone",
	"Mendoza",
	"Mohammed",
	"Mukherjee",
	"Nair",
	"Nguyen",
	"Okafor",
	"Okonkwo",
	"Oliveira",
	"Otieno",
	"Patel",
	"Perez",
	"Reddy",
	"Rodriguez",
	"Santos",
	"Singh",
	"Suzuki",
	"Tanaka",
	"Tran",
	"Wang",
	"Yamamoto",
	"Zhang",
];

/**
 * Compose a full name from the seeded PRNG. The two pools index
 * independently so a 30-row sample produces a wide cross-product
 * (47 × 40 = 1880 unique combinations), keeping repetition rare at
 * the default count.
 */
export function pickFullName(pickIndex: (max: number) => number): string {
	const given = GIVEN_NAMES[pickIndex(GIVEN_NAMES.length)] ?? "Unknown";
	const family = FAMILY_NAMES[pickIndex(FAMILY_NAMES.length)] ?? "Unknown";
	return `${given} ${family}`;
}

/**
 * A single-token first name. Used when a property's name strongly
 * suggests a given name only (e.g. "first_name", "given_name") rather
 * than a full name.
 */
export function pickGivenName(pickIndex: (max: number) => number): string {
	return GIVEN_NAMES[pickIndex(GIVEN_NAMES.length)] ?? "Unknown";
}
