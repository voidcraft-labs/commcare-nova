'use client'
import { useReducer, useCallback } from 'react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { BuilderPhase } from '@/lib/types'

interface SelectedElement {
  type: 'module' | 'form' | 'question'
  moduleIndex: number
  formIndex?: number
  questionPath?: string
}

export interface BuilderState {
  phase: BuilderPhase
  blueprint: AppBlueprint | null
  errors: string[]
  statusMessage: string
  selected: SelectedElement | null
}

type BuilderAction =
  | { type: 'START_GENERATION' }
  | { type: 'SET_BLUEPRINT'; blueprint: AppBlueprint }
  | { type: 'UPDATE_BLUEPRINT'; blueprint: AppBlueprint }
  | { type: 'SELECT'; selected: SelectedElement | null }
  | { type: 'COMPLETE'; blueprint: AppBlueprint }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET' }

const initialState: BuilderState = {
  phase: 'idle',
  blueprint: null,
  errors: [],
  statusMessage: '',
  selected: null,
}

function reducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'START_GENERATION':
      return {
        ...initialState,
        phase: 'scaffolding',
        statusMessage: 'Generating app...',
      }
    case 'SET_BLUEPRINT':
    case 'UPDATE_BLUEPRINT':
      return { ...state, blueprint: action.blueprint }
    case 'SELECT':
      return { ...state, selected: action.selected }
    case 'COMPLETE':
      return { ...state, phase: 'done', blueprint: action.blueprint, statusMessage: 'Build complete!' }
    case 'ERROR':
      return { ...state, phase: 'error', errors: [...state.errors, action.message], statusMessage: action.message }
    case 'RESET':
      return initialState
    default:
      return state
  }
}

export function useBuilder() {
  const [state, dispatch] = useReducer(reducer, initialState)

  const startGeneration = useCallback(async (apiKey: string, conversation: string, appName: string) => {
    dispatch({ type: 'START_GENERATION' })

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, conversation, appName }),
      })

      const result = await res.json()

      if (!res.ok || !result.success) {
        dispatch({ type: 'ERROR', message: result.errors?.[0] || 'Generation failed' })
        return
      }

      dispatch({ type: 'COMPLETE', blueprint: result.blueprint })
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
    startGeneration,
    select,
    updateBlueprint,
    reset,
  }
}
