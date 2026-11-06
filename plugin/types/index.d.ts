export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Turn = { at: number; output: number; tokens: number }
export type Trip = { tokens: number; turns: number }

declare module 'claude-code' {
  interface PluginState {
    'llm-speedometer': {
      limits: Shaped<Limit[]>
      turns: Shaped<Turn[]>
      trip: Shaped<Trip>
      tick: number
    }
  }
}
