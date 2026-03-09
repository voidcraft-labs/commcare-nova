// Types matching the built-in AskUserQuestion tool format

export interface QuestionOption {
  label: string
  description: string
}

export interface ClarifyingQuestion {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}
