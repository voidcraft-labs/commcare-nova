// lib/case-store/sample/pools/addresses.ts
//
// Static address pool for the heuristic generator's `text`
// properties matching `address` / `street` / `village` etc.
// Curated real-world lines (rather than synthesized shapes)
// preserve format quirks — postal codes, comma placement,
// "Apt 3B" suffixes — that make sample data feel like real
// authoring rather than fixture noise.

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

import type { SeededPrng } from "../prng";

export function pickAddressLine(prng: SeededPrng): string {
	return ADDRESS_LINES[prng.pickIndex(ADDRESS_LINES.length)] ?? "Unknown";
}
