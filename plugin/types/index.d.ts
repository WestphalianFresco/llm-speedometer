/** `at`: when the reading was measured, ms; 0 when nobody knows. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string; at: number }
export type Turn = { at: number; output: number; tokens: number }
export type Trip = { tokens: number; turns: number }

declare module 'claude-code' {
  interface PluginState {
    'llm-speedometer': {
      limits: Shaped<Limit[]>
      turns: Shaped<Turn[]>
      trip: Shaped<Trip>
      tick: number
      measuredAt: number
    }
  }
}
