/** Editable model display data; no legacy settings store dependency. */
export interface ProviderModel {
  id: string
  contextWindow: string
  maxOutput: string
  inputTypes: Array<'image' | 'video' | 'pdf'>
  reasoningLevels: string[]
}

/** Acknowledged configuration status supplied by the application. */
export interface ModelSettingsFeedbackData {
  revision: number
  enabled: boolean
  callsEnabled: boolean
}
