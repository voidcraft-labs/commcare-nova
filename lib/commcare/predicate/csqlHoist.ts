// Compatibility shim while relation-read normalization lives in the domain.
// Consumers should import the shared transform from @/lib/domain/predicate.
// Keep this as a concrete binding instead of a re-export alias: Turbopack's
// app-route analyzer follows the target export name and otherwise reports that
// `liftPropertyVias` does not exist on the domain module.
import { normalizeRelationPropertyReads } from "@/lib/domain/predicate/normalizeRelationReads";

export const liftPropertyVias = normalizeRelationPropertyReads;
