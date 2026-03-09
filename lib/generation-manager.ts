import { v4 as uuidv4 } from 'uuid'
import { generateApp, type GenerationEvents } from './services/appGenerator'
import { saveBuild, getBuild } from './store'
import type { Build, BuilderPhase } from './types'
import type { AppBlueprint, Scaffold, ModuleContent, FormContent } from './schemas/blueprint'

type Subscriber = (event: string, data: any) => void

interface ActiveJob {
  buildId: string
  subscribers: Set<Subscriber>
  completed: boolean
}

const activeJobs = new Map<string, ActiveJob>()

// Buffer to store CCZ results in memory temporarily
const cczBuffers = new Map<string, Buffer>()

export function getCczBuffer(buildId: string): Buffer | undefined {
  return cczBuffers.get(buildId)
}

export function storeCczBuffer(buildId: string, buffer: Buffer): void {
  cczBuffers.set(buildId, buffer)
  // Auto-cleanup after 30 minutes
  setTimeout(() => cczBuffers.delete(buildId), 30 * 60 * 1000)
}

export async function startGeneration(
  apiKey: string,
  conversation: string,
  appName: string
): Promise<string> {
  const buildId = uuidv4()

  const build: Build = {
    id: buildId,
    name: appName,
    phase: 'scaffolding',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    conversation: [],
    errors: [],
  }
  await saveBuild(build)

  const job: ActiveJob = {
    buildId,
    subscribers: new Set(),
    completed: false,
  }
  activeJobs.set(buildId, job)

  // Run generation in background
  runGeneration(apiKey, conversation, appName, buildId, job).catch(console.error)

  return buildId
}

async function runGeneration(
  apiKey: string,
  conversation: string,
  appName: string,
  buildId: string,
  job: ActiveJob
) {
  const broadcast = (event: string, data: any) => {
    for (const sub of job.subscribers) {
      try { sub(event, data) } catch { /* subscriber error */ }
    }
  }

  const events: GenerationEvents = {
    onScaffold(scaffold: Scaffold) {
      broadcast('tier:scaffold', { modules: scaffold.modules, caseTypes: scaffold.case_types })
      updateBuildPhase(buildId, 'modules')
    },
    onModule(moduleIndex: number, content: ModuleContent) {
      broadcast('tier:module', { moduleIndex, caseListColumns: content.case_list_columns })
    },
    onForm(moduleIndex: number, formIndex: number, content: FormContent) {
      broadcast('tier:form', { moduleIndex, formIndex, questions: content.questions })
    },
    onStatus(phase: string, message: string) {
      broadcast('status', { phase, message })
    },
    onBlueprint(blueprint: AppBlueprint) {
      broadcast('blueprint', { data: blueprint })
      updateBuildPhase(buildId, 'done')
    },
    onError(message: string, recoverable: boolean) {
      broadcast('error', { message, recoverable })
      if (!recoverable) {
        updateBuildPhase(buildId, 'error')
      }
    },
  }

  try {
    const result = await generateApp(apiKey, conversation, appName, events)

    if (result.success && result.blueprint) {
      const build = await getBuild(buildId)
      if (build) {
        build.blueprint = result.blueprint
        build.phase = 'done'
        build.updatedAt = Date.now()
        await saveBuild(build)
      }
      broadcast('blueprint', { data: result.blueprint })
      broadcast('complete', { buildId })
    } else {
      const build = await getBuild(buildId)
      if (build) {
        build.phase = 'error'
        build.errors = result.errors || ['Generation failed']
        build.updatedAt = Date.now()
        await saveBuild(build)
      }
      broadcast('error', { message: result.errors?.[0] || 'Generation failed', recoverable: false })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    broadcast('error', { message, recoverable: false })
    updateBuildPhase(buildId, 'error')
  } finally {
    job.completed = true
    // Clean up after 5 minutes
    setTimeout(() => activeJobs.delete(buildId), 5 * 60 * 1000)
  }
}

async function updateBuildPhase(buildId: string, phase: BuilderPhase) {
  const build = await getBuild(buildId)
  if (build) {
    build.phase = phase
    build.updatedAt = Date.now()
    await saveBuild(build)
  }
}

export function subscribe(buildId: string, subscriber: Subscriber): () => void {
  const job = activeJobs.get(buildId)
  if (!job) return () => {}

  job.subscribers.add(subscriber)

  // If already completed, immediately notify
  if (job.completed) {
    subscriber('complete', { buildId })
  }

  return () => {
    job.subscribers.delete(subscriber)
  }
}

export function getJob(buildId: string): ActiveJob | undefined {
  return activeJobs.get(buildId)
}
