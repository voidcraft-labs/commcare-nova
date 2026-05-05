// lib/case-store/sample/pools/addresses.ts
//
// Static address pool the heuristic generator picks from for
// `text`-typed properties whose name shape suggests an address (e.g.
// "address", "street", "village"). One self-contained address line
// per entry — the generator returns the line as a single string, not
// a structured record, because the case-property surface stores
// addresses as text under a single key.
//
// Why static lines, not a synth-from-parts approach: a synthesized
// shape (`<number> <street>, <city>`) reads as obviously generated;
// curated lines from real-world places preserve the format quirks
// (postal-code shape, comma placement, "Apt 3B"-style suffixes) that
// make a sample-data demo feel like real authoring rather than
// fixture noise.

/**
 * Address line pool. Mixes urban, suburban, and rural shapes across
 * regions so the generator output exhibits visible variety at the
 * default 30-row count. Lines are intentionally inconsistent in
 * format (some carry postal codes, some don't; some carry unit
 * numbers, some don't) — case-property `text` storage carries no
 * format constraint, and the variety reflects what authoring against
 * real data tends to look like.
 */
export const ADDRESS_LINES: readonly string[] = [
	"42 Mosi Street, Lagos",
	"118 Brigade Road, Bangalore 560001",
	"7-2 Shibuya, Tokyo 150-0002",
	"Rua das Flores 250, São Paulo",
	"Calle 12 No. 4-21, Bogotá",
	"45 Mwakio Lane, Nairobi",
	"3rd Cross, Banjara Hills, Hyderabad",
	"22B Ring Road, Accra",
	"Block 14, Sector 17, Chandigarh 160017",
	"Plot 9, Bole Subcity, Addis Ababa",
	"15 Phan Đình Phùng, Hà Nội",
	"Ulitsa Tverskaya 8, Moscow 125009",
	"Carrera 13 No. 85-32, Bogotá",
	"189 Mile End Road, London E1 4UN",
	"6 Ahmadu Bello Way, Abuja",
	"33 Karama St, Dubai",
	"112 Boulevard Saint-Germain, Paris",
	"58 Tahrir Square, Cairo",
	"Avenida Insurgentes Sur 1500, Mexico City",
	"Manzana 4, Lote 7, Comas, Lima",
	"Building 9, Apt 3B, Karachi",
	"Calle Mayor 23, Madrid 28013",
	"95 Connaught Road, Hong Kong",
	"Parikrama Road, Pune 411001",
	"180 Marina Bay Drive, Singapore",
	"Gulshan Avenue 17, Dhaka",
	"Cheb 4, Yerevan",
	"42 Strand Street, Cape Town",
	"203 Mahatma Gandhi Marg, New Delhi",
	"Vía España 45, Panama City",
];

/**
 * Pick one address line via the seeded PRNG. Returns the full line
 * as a single string — the case-property surface stores addresses
 * under one text key, not as a structured record, so no parts split
 * is needed at this layer.
 */
export function pickAddressLine(pickIndex: (max: number) => number): string {
	return ADDRESS_LINES[pickIndex(ADDRESS_LINES.length)] ?? "Unknown";
}
