/**
 * Project CRUD helpers — thin wrappers over Firestore collection/document helpers.
 *
 * Provides typed, validated read/write operations for project documents.
 * All writes extract denormalized fields from the blueprint automatically
 * so list queries never need to deserialize full blueprints.
 */
import { FieldValue } from '@google-cloud/firestore'
import type { AppBlueprint } from '../schemas/blueprint'
import type { ProjectDoc } from './types'
import { collections, docs } from './firestore'

// ── Types ──────────────────────────────────────────────────────────

/** Subset of ProjectDoc fields returned by list queries (no full blueprint). */
export interface ProjectSummary {
  id: string
  app_name: string
  connect_type: ProjectDoc['connect_type']
  module_count: number
  form_count: number
  status: ProjectDoc['status']
  created_at: Date
  updated_at: Date
}

// ── Helpers ────────────────────────────────────────────────────────

/** Extract denormalized fields from a blueprint for list display. */
function denormalize(blueprint: AppBlueprint) {
  const modules = blueprint.modules ?? []
  return {
    app_name: blueprint.app_name || 'Untitled',
    connect_type: blueprint.connect_type ?? null,
    module_count: modules.length,
    form_count: modules.reduce((sum, m) => sum + (m.forms?.length ?? 0), 0),
  }
}

// ── CRUD ───────────────────────────────────────────────────────────

/**
 * Create or overwrite a project document with a complete blueprint.
 *
 * Used on initial save (generation complete). Writes all fields including
 * both timestamps via FieldValue.serverTimestamp().
 */
export async function saveProject(
  email: string,
  projectId: string,
  blueprint: AppBlueprint,
  runId?: string,
): Promise<void> {
  await docs.project(email, projectId).set({
    ...denormalize(blueprint),
    blueprint,
    status: 'complete',
    run_id: runId ?? null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  } as any) // FieldValue types require the cast — resolved server-side
}

/**
 * Merge-update an existing project with a new blueprint snapshot.
 *
 * Used by the auto-save hook after client-side edits. Uses `set` with
 * `merge: true` instead of `update` so it succeeds even if the initial
 * fire-and-forget `saveProject` hasn't landed yet — avoids a NOT_FOUND
 * race condition under high Firestore latency.
 *
 * Only touches the blueprint, denormalized fields, and updated_at —
 * preserves created_at, run_id, and status from the original save.
 */
export async function updateProject(
  email: string,
  projectId: string,
  blueprint: AppBlueprint,
): Promise<void> {
  await docs.project(email, projectId).set({
    ...denormalize(blueprint),
    blueprint,
    updated_at: FieldValue.serverTimestamp(),
  } as any, { merge: true }) // merge: true preserves fields not specified here
}

/**
 * Load a single project document by ID.
 *
 * Returns the full ProjectDoc (including blueprint) or null if not found.
 * The Zod converter validates the document on read.
 */
export async function loadProject(
  email: string,
  projectId: string,
): Promise<ProjectDoc | null> {
  const snap = await docs.project(email, projectId).get()
  return snap.exists ? snap.data()! : null
}

/**
 * List a user's projects sorted by last modified, without full blueprints.
 *
 * Returns denormalized summaries for the project list page. Reads full
 * documents through the Zod converter (validated reads), then extracts
 * only the summary fields — Firestore's `select()` would skip the
 * converter, bypassing validation.
 */
export async function listProjects(
  email: string,
  limit = 50,
): Promise<ProjectSummary[]> {
  const snap = await collections.projects(email)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .get()

  return snap.docs.map(doc => {
    const data = doc.data()
    return {
      id: doc.id,
      app_name: data.app_name,
      connect_type: data.connect_type,
      module_count: data.module_count,
      form_count: data.form_count,
      status: data.status,
      created_at: data.created_at.toDate(),
      updated_at: data.updated_at.toDate(),
    }
  })
}

/**
 * Generate a new Firestore auto-ID for a project document.
 *
 * Purely local — no network call. The Node.js SDK generates a random
 * 20-char ID client-side via `collection.doc().id`. Used when creating
 * a project for the first time so the ID can be emitted to the client
 * before the write completes.
 */
export function generateProjectId(email: string): string {
  return collections.projects(email).doc().id
}
