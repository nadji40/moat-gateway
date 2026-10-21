import { L } from '../../i18n'
import type { Verdict, BucketData } from './types'

export const VERDICT = {
  allow: { label: L('Paid', 'مدفوعة'), cls: 'paid', c: 'var(--green-l)' },
  step_up: { label: L('Held', 'مُعلَّقة'), cls: 'held', c: 'var(--yellow-l)' },
  deny: { label: L('Refused', 'مرفوضة'), cls: 'refused', c: 'var(--red-l)' },
}

export const vmeta = (k?: string) => {
  if (k && k in VERDICT) return VERDICT[k as keyof typeof VERDICT]
  return { label: k || L('unknown', 'غير معروف'), cls: '', c: 'var(--ink-3)' }
}

export const RULES: Record<string, string> = {
  'payee-provenance': L("The payee didn't come from the user or an approval", 'لم يأتِ المستفيد من المستخدم ولا من موافقة'),
  'amount-provenance': L("The amount didn't come from the user or an approval", 'لم يأتِ المبلغ من المستخدم ولا من موافقة'),
  'payee-allowlist': L("The payee isn't on the allowlist", 'المستفيد ليس في القائمة المسموح بها'),
  'absolute-spending-cap': L('Over the spending limit', 'تتجاوز حد الإنفاق'),
  'amount-cap': L('Over the spending limit', 'تتجاوز حد الإنفاق'),
  'amount-precision': L('More decimals than the currency has', 'منازل عشرية أكثر مما في العملة'),
  'intent-currency': L('Not the currency the user named', 'ليست العملة التي ذكرها المستخدم'),
  'intent-invoice': L('Not the invoice the user named', 'ليست الفاتورة التي ذكرها المستخدم'),
  'invoice-required': L('No invoice number on the payment', 'لا رقم فاتورة على الدفعة'),
  'session-total': L("Over the session's total", 'تتجاوز إجمالي الجلسة'),
  'velocity': L("Over the session's total", 'تتجاوز إجمالي الجلسة'),
  'authorization-required': L('No approval for this payment', 'لا موافقة على هذه الدفعة'),
  'authorization-exists': L('No approval with that id', 'لا موافقة بهذا المعرّف'),
  'authorization-active': L('The approval was cancelled', 'أُلغيت الموافقة'),
  'authorization-expiry': L('The approval has expired', 'انتهت مدة الموافقة'),
  'authorization-payee': L("Payee doesn't match the approval", 'المستفيد لا يطابق الموافقة'),
  'authorization-recipient-account': L("Account doesn't match the approval", 'الحساب لا يطابق الموافقة'),
  'authorization-amount': L("Amount doesn't match the approval", 'المبلغ لا يطابق الموافقة'),
  'authorization-currency': L("Currency doesn't match the approval", 'العملة لا تطابق الموافقة'),
  'authorization-invoice': L("Invoice doesn't match the approval", 'الفاتورة لا تطابق الموافقة'),
  'authorization-network': L("Network doesn't match the approval", 'الشبكة لا تطابق الموافقة'),
  'authorization-asset-contract': L("On-chain asset doesn't match the approval", 'الأصل على السلسلة لا يطابق الموافقة'),
  'authorization-usage': L('The approval was already used', 'استُخدمت الموافقة من قبل'),
  'authorization-duplicate': L('This invoice was already paid', 'دُفعت هذه الفاتورة من قبل'),
  'authorization-invoice-content-duplicate': L('This invoice was already paid', 'دُفعت هذه الفاتورة من قبل'),
  'authorization-invoice-fingerprint': L('This invoice was already paid', 'دُفعت هذه الفاتورة من قبل'),
  'authorization-aggregate': L("Over the approval's total", 'تتجاوز إجمالي الموافقة'),
  'authorization-tenant-aggregate': L("Over the workspace's total", 'تتجاوز إجمالي مساحة العمل'),
  'authorization-reservation': L('Another payment is using this approval', 'دفعة أخرى تستخدم هذه الموافقة'),
  'authorization-quarantine': L("The provider's last answer was unclear, so the approval is on hold", 'كان آخر رد من مزوّد الدفع غير واضح، لذا عُلِّقت الموافقة'),
}

export const ruleText = (id: string) => RULES[id] || id.replace(/-/g, ' ')

export const RAIL: Record<string, string> = { card: 'بطاقة', bank: 'تحويل بنكي', crypto: 'على السلسلة' }
export const railOf = (r?: string) => (r ? L(r, RAIL[r] || r) : '')

export const ROLE: Record<string, string> = { agent: 'الوكيل', approver: 'المُوافِق', admin: 'المسؤول' }
export const roleName = (r?: string) => (r ? L(r, ROLE[r] || r) : '')

export const CALL = L('call', 'استدعاء')

export const failedOf = (v: Verdict): string[] => {
  if (Array.isArray(v.failed_rules)) return v.failed_rules
  if (typeof v.failed_rules === 'string') {
    return (v.failed_rules as string).split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

export const moneyOf = (v: Verdict) => [v.amount, v.currency].filter(Boolean).join(' ')

export function whyOf(v: Verdict) {
  const f = failedOf(v)
  if (f.length) return ruleText(f[0]) + (f.length > 1 ? ` (+${f.length - 1})` : '')
  return v.verdict === 'allow' ? L('Matched what was asked', 'طابق ما طُلب') : ''
}

const arCount = (k: number, [one, two, few, many]: [string, string, string, string]) =>
  k === 1 ? one : k === 2 ? two : k <= 10 ? `${k} ${few}` : `${k} ${many}`

/** Dates and numbers in the page's language, the same for every visitor. */
export const LOCALE = L('en-US', 'ar-DZ')

export function ago(t?: string) {
  if (!t) return ''
  const s = (Date.now() - new Date(t).getTime()) / 1000
  if (!isFinite(s)) return ''
  if (s < 60) return L('just now', 'الآن')
  const m = Math.floor(s / 60)
  const h = Math.floor(s / 3600)
  const d = Math.floor(s / 86400)
  if (s < 3600) return L(`${m} min ago`, 'منذ ' + arCount(m, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة']))
  if (s < 86400) return L(`${h} h ago`, 'منذ ' + arCount(h, ['ساعة', 'ساعتين', 'ساعات', 'ساعة']))
  if (s < 7 * 86400) return L(`${d} d ago`, 'منذ ' + arCount(d, ['يوم', 'يومين', 'أيام', 'يومًا']))
  return new Date(t).toLocaleDateString(LOCALE)
}

export function bucketize(list: Verdict[], n: number, kind: 'hours' | 'days', endMs?: number) {
  const bms = kind === 'hours' ? 3600000 : 86400000
  const endT = endMs || (Math.floor(Date.now() / bms) + 1) * bms
  const start = endT - n * bms
  const out: BucketData[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(start + (i + 1) * bms - 1)
    out.push({
      label:
        kind === 'hours'
          ? ('0' + d.getHours()).slice(-2) + ':00'
          : d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }),
      allow: 0,
      step: 0,
      deny: 0,
      total: 0,
    })
  }
  ;(list || []).forEach((v) => {
    if (!v.at) return
    const t = new Date(v.at).getTime()
    if (!(t >= start) || t >= endT) return
    const b = out[Math.min(n - 1, Math.floor((t - start) / bms))]
    const k = v.verdict === 'allow' ? 'allow' : v.verdict === 'step_up' ? 'step' : 'deny'
    b[k]++
    b.total++
  })
  return out
}
