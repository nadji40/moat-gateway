export interface Verdict {
  payee?: string
  amount?: number | string
  currency?: string
  verdict?: 'allow' | 'step_up' | 'deny'
  rail?: string
  failed_rules?: string[]
  payee_source?: string
  tool?: string
  session_id?: string
  evidence_id?: string
  at?: string
  [key: string]: unknown
}

export interface ApiKey {
  id: string
  label?: string
  access_role?: string
  scopes?: string[]
  active?: boolean
  created_at?: string
  last_used_at?: string
  current?: boolean
  expired?: boolean
  expires_at?: string
  secret?: string
}

export interface UsageData {
  total?: number
  week?: number
  sessions?: number
  allow?: number
  step_up?: number
  deny?: number
  other?: number
  last_at?: string
}

export interface BucketData {
  label: string
  allow: number
  step: number
  deny: number
  total: number
}
