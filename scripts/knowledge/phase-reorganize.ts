/** Phase 4: Reorganize — two-pass Opus reorganization of distilled knowledge files */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { streamText, Output } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { PipelineConfig } from './types.js'
import { log, logCost, logSummary } from './log.js'

const DISTILL_DIR = '.data/confluence-cache/distilled'
const KNOWLEDGE_DIR = 'lib/services/commcare/knowledge'
const CACHE_DIR = '.data/confluence-cache'
const PLAN_PATH = path.join(CACHE_DIR, 'reorg-plan.json')
const OPUS_MODEL = 'claude-opus-4-6'
const OPUS_INPUT_COST = 15   // $/M tokens
const OPUS_OUTPUT_COST = 75  // $/M tokens

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(`${message} (y/N) `, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

// --- Schemas ---

const reorgPlanSchema = z.object({
  files: z.array(z.object({
    filename: z.string().describe('Kebab-case filename without .md extension'),
    title: z.string().describe('Human-readable title for the knowledge file'),
    description: z.string().describe('1-2 sentence summary of what this file covers'),
    sources: z.array(z.object({
      sourceFile: z.string().describe('Filename of the source knowledge file (with .md extension)'),
      sections: z.array(z.string()).describe('Section headings or descriptions of which parts to pull from this source file. Use "all" if the entire file is relevant.'),
    })),
    contentGuidance: z.string().describe('Specific instructions for what to include, exclude, combine, or restructure when writing this file'),
  })),
  cuts: z.array(z.object({
    sourceFile: z.string().describe('Filename of the source knowledge file (with .md extension)'),
    what: z.string().describe('Description of content being cut'),
    why: z.string(),
  })),
})

type ReorgPlan = z.infer<typeof reorgPlanSchema>

// --- Pass 1: Plan ---

function loadDistilledFiles(): Map<string, string> {
  if (!fs.existsSync(DISTILL_DIR)) {
    throw new Error(`No distilled files found at ${DISTILL_DIR}. Run --phase distill first.`)
  }
  const files = new Map<string, string>()
  const entries = fs.readdirSync(DISTILL_DIR).filter(f => f.endsWith('.md') && f !== 'index.md')
  for (const filename of entries) {
    const content = fs.readFileSync(path.join(DISTILL_DIR, filename), 'utf-8')
    files.set(filename, content)
  }
  return files
}

export async function reorgPlan(config: PipelineConfig): Promise<ReorgPlan> {
  const anthropic = createAnthropic({ apiKey: config.anthropicApiKey })
  const files = loadDistilledFiles()

  log('Reorganize', `Loaded ${files.size} knowledge files`)

  // Build the combined input
  const allContent = [...files.entries()]
    .map(([filename, content]) => `=== ${filename} ===\n\n${content}`)
    .join('\n\n' + '='.repeat(80) + '\n\n')

  const inputTokens = estimateTokens(allContent.length)
  const outputTokensEst = 8000
  const estCost = (inputTokens / 1_000_000) * OPUS_INPUT_COST + (outputTokensEst / 1_000_000) * OPUS_OUTPUT_COST

  log('Reorganize', `Pass 1: Planning reorganization`)
  log('Reorganize', `  ${files.size} source files, ~${inputTokens.toLocaleString()} input tokens`)
  log('Reorganize', `  Estimated cost: ~$${estCost.toFixed(2)}`)

  if (!config.skipConfirmation) {
    const ok = await confirm(`[Reorganize] Run Pass 1 (plan)? (~$${estCost.toFixed(2)})`)
    if (!ok) {
      log('Reorganize', 'Aborted by user.')
      process.exit(0)
    }
  }

  const system = `You are reorganizing a CommCare knowledge base for an AI agent (the "Solutions Architect") that designs CommCare mobile apps from natural language. The SA generates app blueprints: modules, forms, questions (with types, labels, case properties, logic), case types, and case list columns. The SA also writes expressions — relevant conditions, calculate, constraint, default_value, and itemset configurations (nodeset, value, label, filter predicates). That is the SA's ENTIRE interface. It does not touch XML, does not use CommCare HQ's web interface, does not make API calls, does not manage users/locations/infrastructure, does not do data import/export, does not configure servers or integrations.

The SA's output is an app blueprint that gets deterministically converted into a working CommCare app by a separate pipeline. The SA never sees or writes XML, never interacts with submission endpoints, never configures case import spreadsheets, never sets up cross-domain data sharing, never manages user accounts. If a human couldn't do it while sitting in the CommCare app builder designing forms and modules, the SA can't do it either.

**The strict test for inclusion: Would this knowledge help the SA decide what question type to use, how to structure a module, how to wire case properties, or how to write an expression (relevant/calculate/constraint/default_value/itemset)?** If no, cut it entirely. Don't keep it "for context" or "for debugging" — the SA doesn't debug.

Given all source files, produce a reorganization plan that:

1. **Aggressively cuts everything outside the app builder design surface:**
   - ALL XML/XForm structure (the SA never sees XML — a deterministic pipeline handles conversion)
   - ALL CommCare HQ UI instructions (button locations, navigation, settings screens)
   - ALL API/integration/webhook/data forwarding content
   - ALL case import/export workflows (Excel import, bulk operations, data downloads)
   - ALL cross-domain/cross-project operations (data registries, cross-domain case transfer)
   - ALL server administration, deployment, user provisioning, location setup
   - ALL mobile device management, installation, connectivity handling
   - ALL reporting/dashboard configuration
   - ALL SMS/messaging configuration
   - Do NOT keep any of the above "for reference" or "for understanding" — if the SA cannot act on it in a blueprint, it does not belong.

2. **Reframes HQ-centric content into blueprint-centric content where possible**: If source material says "in the app builder, add a select question and choose the lookup table as the data source," the useful kernel is "a select question can use an itemset with instance('item-list:tablename') as its data source." Extract the concept, discard the UI instructions.

3. **Produces many small, focused files — aim for 25-40 files**: Each file should cover one specific topic narrow enough to be loaded on demand. "Case management" is too broad — split into "case-types-and-properties", "parent-child-cases", "case-sharing-and-ownership", "case-list-columns", etc. A file should be loadable when the SA needs help with one specific design decision, without pulling in unrelated content.

4. **Preserves ALL expression-level depth**: Instance URIs, XPath patterns, function references, nodeset syntax, filter predicates, common expression recipes — this is the SA's "coding" reference and must be preserved in full. This is the most important content in the entire knowledge base.

5. **Preserves design-level guidance at the blueprint abstraction**: When to use subcases vs parent cases, when to use repeat groups, how to structure modules, when to denormalize case properties, what question types are appropriate for different data collection needs. Express this in terms of blueprint concepts (question types, case properties, expressions), never in terms of HQ UI steps or XML structure.

Calibration examples:

CUT — Raw XML/XForm structure:
"A repeat group is an XForm <repeatelement containing child questions. Each iteration creates a new XML node under the repeat path."

CUT — CommCare HQ UI instructions:
"The fixture [locations] is automatically available in forms that contain at least one select question using locations as choices. If no such question exists, add a hidden dummy select question with false() as its display condition to force the fixture to load."

CUT — API and external systems:
"CommCare's integration architecture has three distinct layers: 1. Data in/out via REST APIs 2. MOTECH repeaters (push) 3. External app callouts (mobile)"

CUT — Case import workflows:
"Excel case import column semantics, matching logic (case_id vs external_id), parent-child import patterns"

CUT — Cross-domain operations:
"Data registry case updates across project spaces, cross-domain case transfer patterns"

CUT — Form submission XML:
"The three-component XForm model (instance, bindings, controls), case transaction XML blocks, meta block structure, namespace requirements"

KEEP — Instance declarations:
"Instance ID: locations, Instance URI: jr://fixture/locations"

KEEP — XPath expression patterns:
"#form/question_id → shorthand for /data/question_id; #case/case_property_name → load from current case; In validation conditions, . (dot) refers to the current question's value."

KEEP — Blueprint-level design guidance:
"A case list has a case type. Each column can be a case property or a calculate condition. In calculate conditions, the calculation runs over each row — use current()/property_name to reference the current row. If a parent case property is needed for display or search, denormalize it."`

  log('Reorganize', `  Sending to Opus...`)

  const stream = streamText({
    model: anthropic(OPUS_MODEL),
    output: Output.object({ schema: reorgPlanSchema }),
    system,
    prompt: allContent,
  })

  // Stream progress — show files as they appear
  let lastLineCount = 0
  for await (const partial of stream.partialOutputStream) {
    const plan = partial as ReorgPlan
    if (!plan?.files?.length) continue

    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`)
    }

    const lines: string[] = []
    for (let i = 0; i < plan.files.length; i++) {
      const f = plan.files[i]
      const name = f?.filename ?? '...'
      const sourceCount = f?.sources?.length ?? 0
      const status = i < plan.files.length - 1 ? '\x1b[32m✓\x1b[0m' : '\x1b[33m⟳\x1b[0m'
      lines.push(`  ${status} ${(i + 1).toString().padStart(2)}. ${(name + '.md').padEnd(40).slice(0, 40)} ${String(sourceCount).padStart(2)} sources`)
    }

    const cutCount = plan.cuts?.length ?? 0
    if (cutCount > 0) {
      lines.push(`  \x1b[31m✂\x1b[0m  ${cutCount} cuts identified`)
    }

    for (const line of lines) {
      process.stdout.write(`\x1b[2K${line}\n`)
    }
    lastLineCount = lines.length
  }
  process.stdout.write('\n')

  const finalOutput = await stream.output
  const plan = finalOutput!
  const usage = await stream.usage
  const cost = logCost('Reorganize', '  Pass 1 done', usage.inputTokens ?? 0, usage.outputTokens ?? 0, OPUS_INPUT_COST, OPUS_OUTPUT_COST)

  // Save plan
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2))
  log('Reorganize', `  Plan saved to ${PLAN_PATH}`)

  // Print the plan
  printPlan(plan)

  return plan
}

function printPlan(plan: ReorgPlan): void {
  console.log('\n' + '='.repeat(70))
  console.log('  REORGANIZATION PLAN')
  console.log('='.repeat(70))

  console.log(`\n  ${plan.files.length} output files:\n`)
  for (let i = 0; i < plan.files.length; i++) {
    const f = plan.files[i]
    console.log(`  ${(i + 1).toString().padStart(2)}. \x1b[36m${f.filename}.md\x1b[0m — ${f.title}`)
    console.log(`      ${f.description}`)
    console.log(`      Sources:`)
    for (const s of f.sources) {
      const sections = s.sections.join(', ')
      console.log(`        - ${s.sourceFile} [${sections}]`)
    }
    console.log(`      Guidance: ${f.contentGuidance}`)
    console.log()
  }

  if (plan.cuts.length > 0) {
    console.log(`  ${plan.cuts.length} cuts:\n`)
    for (const cut of plan.cuts) {
      console.log(`  \x1b[31m✂\x1b[0m  ${cut.sourceFile}: ${cut.what}`)
      console.log(`      Why: ${cut.why}`)
    }
    console.log()
  }

  console.log('='.repeat(70))
}

// --- Pass 2: Execute ---

export async function reorgExecute(config: PipelineConfig): Promise<void> {
  const anthropic = createAnthropic({ apiKey: config.anthropicApiKey })

  // Load the plan
  if (!fs.existsSync(PLAN_PATH)) {
    throw new Error(`No reorganization plan found at ${PLAN_PATH}. Run --phase reorg-plan first.`)
  }
  const plan: ReorgPlan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8'))

  log('Reorganize', `Pass 2: Writing ${plan.files.length} files`)

  // Load all source knowledge files
  const sourceFiles = loadDistilledFiles()

  // Estimate cost
  let totalSourceChars = 0
  for (const file of plan.files) {
    for (const src of file.sources) {
      const content = sourceFiles.get(src.sourceFile)
      if (content) totalSourceChars += content.length
    }
  }
  const inputTokensEst = estimateTokens(totalSourceChars) + plan.files.length * 500 // system prompt overhead per call
  const outputTokensEst = estimateTokens(totalSourceChars * 0.7) // output ~70% of input size
  const estCost = (inputTokensEst / 1_000_000) * OPUS_INPUT_COST + (outputTokensEst / 1_000_000) * OPUS_OUTPUT_COST

  log('Reorganize', `  ~${inputTokensEst.toLocaleString()} input tokens across ${plan.files.length} calls`)
  log('Reorganize', `  Estimated cost: ~$${estCost.toFixed(2)}`)

  if (!config.skipConfirmation) {
    const ok = await confirm(`[Reorganize] Run Pass 2 (write ${plan.files.length} files)? (~$${estCost.toFixed(2)})`)
    if (!ok) {
      log('Reorganize', 'Aborted by user.')
      process.exit(0)
    }
  }

  const system = `You are writing one file of a CommCare knowledge base for an AI agent (the "Solutions Architect") that designs CommCare mobile apps from natural language.

The SA generates app blueprints: modules, forms, questions (with types, labels, case properties, logic), case types, and case list columns. The SA's "coding" surface is expressions — relevant, calculate, constraint, default_value, and itemset configurations (nodeset, value, label, filter predicates). That is the SA's ENTIRE interface.

The SA does NOT:
- See, write, or reason about XML/XForm structure
- Use CommCare HQ's web interface
- Make API calls or configure integrations/webhooks/data forwarding
- Do case import/export or bulk operations
- Set up cross-domain/cross-project data sharing
- Manage users, locations, servers, devices, or deployment
- Configure reporting, dashboards, or SMS/messaging

A deterministic pipeline converts the SA's blueprint into a working CommCare app. The SA never touches anything below or outside the blueprint.

## Strict Test for Inclusion

Would this knowledge help the SA decide what question type to use, how to structure a module, how to wire case properties, or how to write an expression? If no, cut it. Don't keep it "for context" or "for understanding."

## Rules

- **Cut all HQ UI instructions** — no button locations, navigation steps, settings screens, "go to the X tab and click Y"
- **Cut all raw XML/XForm structure** — no element names, no namespace declarations, no submission format, no XForm architecture explanations
- **Cut all API/integration/infrastructure content** — no endpoints, no webhooks, no MOTECH, no data forwarding
- **Cut all case import/export** — no Excel import, no bulk operations, no data downloads
- **Cut all cross-domain operations** — no data registries, no cross-project case transfer
- **Cut all reporting/SMS/device management content**
- **When source material describes HQ UI steps, extract the underlying concept** — "add a lookup table question in the builder" becomes "use a select with itemset from instance('item-list:tablename')"
- **Preserve ALL expression-level detail** — instance URIs, XPath patterns, nodeset syntax, filter predicates, function references, common expression recipes. This is the most important content.
- **Express everything at the blueprint level** — question types, case properties, case types, modules, forms, columns, and expressions. Not XML elements, not HQ settings pages.

## Calibration Examples

CUT:
"A repeat group is an XForm <repeat> element containing child questions. Each iteration creates a new XML node under the repeat path."

CUT:
"The fixture [locations] is automatically available in forms that contain at least one select question using locations as choices. If no such question exists, add a hidden dummy select question with false() as its display condition to force the fixture to load."

CUT:
"Excel case import column semantics, matching logic (case_id vs external_id), parent-child import patterns"

KEEP:
"Instance ID: locations, Instance URI: jr://fixture/locations"

KEEP:
"#form/question_id → shorthand for /data/question_id; #case/case_property_name → load from current case; In validation conditions, . (dot) refers to the current question's value."

KEEP:
"A case list has a case type. Each column can be a case property or a calculate condition. In calculate conditions, the calculation runs over each row — use current()/property_name to reference the current row. If a parent case property is needed for display or search, denormalize it."

## Writing Style

Be precise, information-dense, and structured for quick lookup. This is a reference card for an expert AI agent, not a tutorial for a human learner. Use headers and short sections for scannability. Preserve concrete details — instance URIs, XPath function signatures, property names, expression patterns.

Write the file described below using the source material provided. Follow the content guidance from the plan exactly.`

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCost = 0

  // Clear old knowledge files and write fresh
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true })
  const oldFiles = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md') && f !== 'index.md')
  for (const f of oldFiles) {
    fs.unlinkSync(path.join(KNOWLEDGE_DIR, f))
  }
  log('Reorganize', `  Cleared ${oldFiles.length} old knowledge files`)

  for (let i = 0; i < plan.files.length; i++) {
    const file = plan.files[i]
    const outputPath = path.join(KNOWLEDGE_DIR, `${file.filename}.md`)

    // Gather source content for this file
    const sourceContent = file.sources.map(src => {
      const content = sourceFiles.get(src.sourceFile)
      if (!content) {
        log('Reorganize', `    WARNING: Source file ${src.sourceFile} not found`)
        return ''
      }
      const sections = src.sections.join(', ')
      return `=== Source: ${src.sourceFile} [sections: ${sections}] ===\n\n${content}`
    }).filter(s => s.length > 0).join('\n\n' + '-'.repeat(60) + '\n\n')

    if (sourceContent.length === 0) {
      log('Reorganize', `  [${i + 1}/${plan.files.length}] ${file.filename}.md — no source content, skipping`)
      continue
    }

    const inputTokenEst = estimateTokens(sourceContent.length)
    log('Reorganize', `  [${i + 1}/${plan.files.length}] ${file.filename}.md — ${file.sources.length} sources, ~${inputTokenEst.toLocaleString()} tokens`)

    const prompt = `File: ${file.filename}.md
Title: ${file.title}
Description: ${file.description}

Content guidance: ${file.contentGuidance}

Source material:

${sourceContent}`

    try {
      const result = streamText({
        model: anthropic(OPUS_MODEL),
        system,
        prompt,
      })

      let fullText = ''
      process.stdout.write('\n')
      for await (const chunk of result.textStream) {
        fullText += chunk
        process.stdout.write(chunk)
      }
      process.stdout.write('\n\n')

      if (fullText.length > 0) {
        fs.writeFileSync(outputPath, fullText)
        log('Reorganize', `    Saved: ${outputPath} (${fullText.length.toLocaleString()} chars)`)
      }

      const usage = await result.usage
      totalInputTokens += usage.inputTokens ?? 0
      totalOutputTokens += usage.outputTokens ?? 0
      const fileCost = logCost('Reorganize', `    ${file.filename}.md`, usage.inputTokens ?? 0, usage.outputTokens ?? 0, OPUS_INPUT_COST, OPUS_OUTPUT_COST)
      totalCost += fileCost
      log('Reorganize', `    Running total: $${totalCost.toFixed(4)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('Reorganize', `    ERROR: ${msg}`)
    }
  }

  // Generate new index.md
  log('Reorganize', '')
  log('Reorganize', 'Generating index.md...')

  const indexContent = [
    '# CommCare Knowledge Base',
    '',
    'Reorganized platform knowledge for the Solutions Architect agent.',
    `Generated on ${new Date().toISOString().split('T')[0]}.`,
    '',
    '## Topics',
    '',
    ...plan.files.map(f => {
      const outputPath = path.join(KNOWLEDGE_DIR, `${f.filename}.md`)
      const exists = fs.existsSync(outputPath)
      return `- **[${f.title}](${f.filename}.md)** — ${f.description}${exists ? '' : ' *(failed to generate)*'}`
    }),
    '',
  ].join('\n')

  fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'index.md'), indexContent)
  log('Reorganize', `Written: ${path.join(KNOWLEDGE_DIR, 'index.md')}`)

  // Summary
  const generatedFiles = plan.files.filter(f => fs.existsSync(path.join(KNOWLEDGE_DIR, `${f.filename}.md`)))

  logSummary('Reorganize', [
    `Output files: ${generatedFiles.length}/${plan.files.length}`,
    `Content cuts: ${plan.cuts.length}`,
    '',
    'Files:',
    ...generatedFiles.map(f => `  ${f.filename}.md — ${f.title}`),
    '',
    `Total cost: $${totalCost.toFixed(4)} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`,
  ])
}

// --- Combined: Plan + Confirm + Execute ---

export async function reorganize(config: PipelineConfig): Promise<void> {
  const plan = await reorgPlan(config)

  if (!config.skipConfirmation) {
    const ok = await confirm(`[Reorganize] Proceed to Pass 2 (write ${plan.files.length} files with Opus)?`)
    if (!ok) {
      log('Reorganize', 'Stopped after Pass 1. Run --phase reorg-execute to continue later.')
      return
    }
  }

  await reorgExecute(config)
}
