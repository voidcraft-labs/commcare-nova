'use client'
import { useReducer, useCallback } from 'react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { BuilderPhase } from '@/lib/types'

interface SelectedElement {
  type: 'module' | 'form' | 'question'
  moduleIndex: number
  formIndex?: number
  questionPath?: string // dot-separated path for nested questions
}

export interface BuilderState {
  phase: BuilderPhase
  buildId: string | null
  blueprint: AppBlueprint | null
  errors: string[]
  statusMessage: string
  selected: SelectedElement | null
  sseUrl: string | null
}

type BuilderAction =
  | { type: 'START_GENERATION'; buildId: string }
  | { type: 'SET_PHASE'; phase: BuilderPhase; message?: string }
  | { type: 'SET_BLUEPRINT'; blueprint: AppBlueprint }
  | { type: 'UPDATE_BLUEPRINT'; blueprint: AppBlueprint }
  | { type: 'SET_ERRORS'; errors: string[] }
  | { type: 'SET_STATUS'; message: string }
  | { type: 'SELECT'; selected: SelectedElement | null }
  | { type: 'SCAFFOLD_RECEIVED'; data: any }
  | { type: 'MODULE_RECEIVED'; moduleIndex: number; data: any }
  | { type: 'FORM_RECEIVED'; moduleIndex: number; formIndex: number; data: any }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET' }

const initialState: BuilderState = {
  phase: 'idle',
  buildId: null,
  blueprint: null,
  errors: [],
  statusMessage: '',
  selected: null,
  sseUrl: null,
}

function reducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'START_GENERATION':
      return {
        ...state,
        phase: 'scaffolding',
        buildId: action.buildId,
        sseUrl: `/api/generate/${action.buildId}/stream`,
        errors: [],
        statusMessage: 'Planning app structure...',
      }
    case 'SET_PHASE':
      return { ...state, phase: action.phase, statusMessage: action.message || state.statusMessage }
    case 'SET_BLUEPRINT':
    case 'UPDATE_BLUEPRINT':
      return { ...state, blueprint: action.blueprint }
    case 'SET_ERRORS':
      return { ...state, errors: action.errors }
    case 'SET_STATUS':
      return { ...state, statusMessage: action.message }
    case 'SELECT':
      return { ...state, selected: action.selected }
    case 'SCAFFOLD_RECEIVED':
      return {
        ...state,
        phase: 'modules',
        statusMessage: `Scaffold complete — ${action.data.modules?.length || 0} modules`,
        // Create a partial blueprint from the scaffold data
        blueprint: state.blueprint || {
          app_name: 'Building...',
          modules: (action.data.modules || []).map((m: any) => ({
            name: m.name,
            case_type: m.case_type,
            forms: (m.forms || []).map((f: any) => ({
              name: f.name,
              type: f.type,
              questions: [],
            })),
          })),
        },
      }
    case 'MODULE_RECEIVED':
      if (!state.blueprint) return state
      return {
        ...state,
        blueprint: {
          ...state.blueprint,
          modules: state.blueprint.modules.map((m, i) =>
            i === action.moduleIndex
              ? { ...m, case_list_columns: action.data.caseListColumns }
              : m
          ),
        },
        statusMessage: `Module ${action.moduleIndex + 1} content received`,
      }
    case 'FORM_RECEIVED':
      if (!state.blueprint) return state
      return {
        ...state,
        phase: 'forms',
        blueprint: {
          ...state.blueprint,
          modules: state.blueprint.modules.map((m, mi) =>
            mi === action.moduleIndex
              ? {
                  ...m,
                  forms: m.forms.map((f, fi) =>
                    fi === action.formIndex
                      ? { ...f, questions: action.data.questions || [] }
                      : f
                  ),
                }
              : m
          ),
        },
        statusMessage: `Form content received`,
      }
    case 'COMPLETE':
      return { ...state, phase: 'done', statusMessage: 'Build complete!', sseUrl: null }
    case 'ERROR':
      return { ...state, phase: 'error', errors: [...state.errors, action.message], sseUrl: null, statusMessage: action.message }
    case 'RESET':
      return initialState
    default:
      return state
  }
}

export function useBuilder() {
  const [state, dispatch] = useReducer(reducer, initialState)

  const handleSSEEvent = useCallback((event: string, data: any) => {
    switch (event) {
      case 'tier:scaffold':
        dispatch({ type: 'SCAFFOLD_RECEIVED', data })
        break
      case 'tier:module':
        dispatch({ type: 'MODULE_RECEIVED', moduleIndex: data.moduleIndex, data })
        break
      case 'tier:form':
        dispatch({ type: 'FORM_RECEIVED', moduleIndex: data.moduleIndex, formIndex: data.formIndex, data })
        break
      case 'status':
        dispatch({ type: 'SET_STATUS', message: data.message })
        if (data.phase) {
          const phaseMap: Record<string, BuilderPhase> = {
            scaffolding: 'scaffolding',
            generating_module: 'modules',
            generating_form: 'forms',
            validating: 'validating',
            fixing: 'fixing',
            expanding: 'compiling',
            success: 'done',
            failed: 'error',
          }
          if (phaseMap[data.phase]) {
            dispatch({ type: 'SET_PHASE', phase: phaseMap[data.phase] })
          }
        }
        break
      case 'blueprint':
        dispatch({ type: 'SET_BLUEPRINT', blueprint: data.data })
        break
      case 'complete':
        dispatch({ type: 'COMPLETE' })
        break
      case 'error':
        dispatch({ type: 'ERROR', message: data.message })
        break
    }
  }, [])

  const startGeneration = useCallback(async (apiKey: string, conversation: string, appName: string) => {
    dispatch({ type: 'RESET' })

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, conversation, appName }),
      })

      if (!res.ok) throw new Error('Failed to start generation')

      const { buildId } = await res.json()
      dispatch({ type: 'START_GENERATION', buildId })
    } catch (err) {
      dispatch({ type: 'ERROR', message: err instanceof Error ? err.message : 'Failed to start' })
    }
  }, [])

  const select = useCallback((selected: SelectedElement | null) => {
    dispatch({ type: 'SELECT', selected })
  }, [])

  const updateBlueprint = useCallback((blueprint: AppBlueprint) => {
    dispatch({ type: 'UPDATE_BLUEPRINT', blueprint })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  return {
    state,
    handleSSEEvent,
    startGeneration,
    select,
    updateBlueprint,
    reset,
  }
}
