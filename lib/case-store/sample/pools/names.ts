// lib/case-store/sample/pools/names.ts
//
// Static name pools, globally varied so a sample-data demo
// doesn't read as monocultural. Static (not an external API)
// because the determinism contract is per `(app, caseType, seed)`
// — a live API would break determinism, add a network dependency,
// and gate CI on a third-party uptime SLO.
//
// Append to add: insertion-ordered + seeded-index selection means
// an insert shifts every downstream selection, which is desired —
// determinism tests pin the seeded sequence and a pool change
// should produce a visible diff.

import type { SeededPrng } from "../prng";

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

/** ~1880-combo cross product across the two pools — repetition is rare at default 30-row counts. */
export function pickFullName(prng: SeededPrng): string {
	const given = GIVEN_NAMES[prng.pickIndex(GIVEN_NAMES.length)] ?? "Unknown";
	const family = FAMILY_NAMES[prng.pickIndex(FAMILY_NAMES.length)] ?? "Unknown";
	return `${given} ${family}`;
}

/** Used when the property name suggests a given name only ("first_name" / "given_name"). */
export function pickGivenName(prng: SeededPrng): string {
	return GIVEN_NAMES[prng.pickIndex(GIVEN_NAMES.length)] ?? "Unknown";
}
