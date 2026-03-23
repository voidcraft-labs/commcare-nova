'use client'
import { motion } from 'motion/react'
import { modelSupportsReasoning, modelSupportsMaxReasoning } from '@/lib/models'
import type { PipelineConfig, PipelineStageConfig, ReasoningEffort } from '@/lib/types/settings'

interface ModelInfo {
  id: string
  display_name: string
  created_at: string
}

/** Metadata for a pipeline stage (key, display label, description). */
export interface StageInfo {
  key: keyof PipelineConfig
  label: string
  description: string
}

/** Max output token limits per model (with extended thinking). Hardcoded for now. */
export const MODEL_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6': 128000,
  'claude-sonnet-4-6': 64000,
  'claude-haiku-4-5-20251001': 64000,
}
const DEFAULT_MAX_TOKENS = 64000

const ALL_TOKEN_OPTIONS = [
  { value: 0, label: 'No limit' },
  { value: 4096, label: '4,096' },
  { value: 8192, label: '8,192' },
  { value: 16384, label: '16,384' },
  { value: 32768, label: '32,768' },
  { value: 64000, label: '64,000' },
  { value: 128000, label: '128,000' },
]

function getTokenOptions(model: string) {
  const cap = MODEL_MAX_TOKENS[model] ?? DEFAULT_MAX_TOKENS
  return ALL_TOKEN_OPTIONS.filter(opt => opt.value === 0 || opt.value <= cap)
}

export const EFFORT_LEVELS: { value: ReasoningEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

/** The top-level SA agent stage. */
export const AGENT_STAGE: StageInfo = {
  key: 'solutionsArchitect', label: 'Solutions Architect', description: 'Conversational agent that designs and builds apps',
}


interface StageCardProps {
  stage: StageInfo
  index: number
  settings: { apiKey: string; pipeline: PipelineConfig }
  models: ModelInfo[]
  updatePipelineStage: (stage: keyof PipelineConfig, updates: Partial<PipelineStageConfig>) => void
}

/**
 * Card for configuring a single pipeline stage: model selection, max tokens, and reasoning toggle.
 * Used in the settings page for both the agent and tool stages.
 */
export function StageCard({ stage, index, settings, models, updatePipelineStage }: StageCardProps) {
  const cfg = settings.pipeline[stage.key]
  const supportsMax = modelSupportsMaxReasoning(cfg.model)
  const effortLevels = supportsMax ? EFFORT_LEVELS : EFFORT_LEVELS.filter(e => e.value !== 'max')

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.05 * index, ease: [0.16, 1, 0.3, 1] }}
      className="p-4 bg-nova-surface border border-nova-border rounded-lg"
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-nova-text">{stage.label}</h3>
          <p className="text-xs text-nova-text-muted mt-0.5">{stage.description}</p>
        </div>
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-[11px] text-nova-text-muted uppercase tracking-wider mb-1.5 block">
            Model
          </label>
          {models.length > 0 ? (
            <select
              value={cfg.model}
              onChange={(e) => {
                const newModel = e.target.value
                const cap = MODEL_MAX_TOKENS[newModel] ?? DEFAULT_MAX_TOKENS
                const updates: Partial<PipelineStageConfig> = { model: newModel }
                if (cfg.maxOutputTokens > 0 && cfg.maxOutputTokens > cap) updates.maxOutputTokens = cap
                if (!modelSupportsReasoning(newModel)) updates.reasoning = false
                if (cfg.reasoningEffort === 'max' && !modelSupportsMaxReasoning(newModel)) updates.reasoningEffort = 'high'
                updatePipelineStage(stage.key, updates)
              }}
              className="w-full px-3 py-2 bg-nova-void border border-nova-border rounded-lg text-sm text-nova-text focus:outline-none focus:border-nova-violet transition-colors appearance-none cursor-pointer"
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.display_name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={cfg.model}
              onChange={(e) => updatePipelineStage(stage.key, { model: e.target.value })}
              placeholder={!settings.apiKey ? 'Enter API key first' : 'Model ID...'}
              disabled={!settings.apiKey}
              autoComplete="off"
              data-1p-ignore
              className="w-full px-3 py-2 bg-nova-void border border-nova-border rounded-lg text-sm text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet transition-colors disabled:opacity-40"
            />
          )}
        </div>
        <div className="w-36">
          <label className="text-[11px] text-nova-text-muted uppercase tracking-wider mb-1.5 block">
            Max Tokens
          </label>
          <select
            value={cfg.maxOutputTokens}
            onChange={(e) =>
              updatePipelineStage(stage.key, {
                maxOutputTokens: parseInt(e.target.value),
              })
            }
            className="w-full px-3 py-2 bg-nova-void border border-nova-border rounded-lg text-sm text-nova-text focus:outline-none focus:border-nova-violet transition-colors appearance-none cursor-pointer"
          >
            {getTokenOptions(cfg.model).map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>
      {settings.apiKey && modelSupportsReasoning(cfg.model) && (
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-nova-border/40">
          <button
            type="button"
            role="switch"
            aria-checked={cfg.reasoning}
            onClick={() => updatePipelineStage(stage.key, { reasoning: !cfg.reasoning })}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
              cfg.reasoning ? 'bg-nova-violet' : 'bg-nova-border'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                cfg.reasoning ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
          <span className="text-xs text-nova-text-secondary select-none">Reasoning</span>
          {cfg.reasoning && (
            <div className="ml-auto flex items-center gap-1.5">
              {effortLevels.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => updatePipelineStage(stage.key, { reasoningEffort: value })}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    cfg.reasoningEffort === value
                      ? 'bg-nova-violet/20 text-nova-violet-bright border border-nova-violet/40'
                      : 'text-nova-text-muted hover:text-nova-text-secondary hover:bg-nova-void border border-transparent'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}
