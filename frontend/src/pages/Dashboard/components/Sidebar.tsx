import { L } from '../../../i18n'
import type { PaneId } from '../types'

interface SidebarProps {
  activePane: PaneId
  onPaneChange: (pane: PaneId) => void
  keyLabel: string
  keyId?: string
  keysCount?: number
  verdictsCount?: number
  collapsed: boolean
  onToggleCollapse: () => void
}

export const TABS: { pane: PaneId; icon: string; label: string; count?: 'keys' | 'verdicts' }[] = [
  { pane: 'pane-usage', icon: 'Usage.svg', label: L('Usage', 'الاستخدام') },
  { pane: 'pane-keys', icon: 'Key.svg', label: L('API keys', 'مفاتيح API'), count: 'keys' },
  { pane: 'pane-connect', icon: 'connect.svg', label: L('Connect', 'الربط') },
  { pane: 'pane-playground', icon: 'playground.svg', label: L('Playground', 'ساحة التجربة') },
  { pane: 'pane-verdicts', icon: 'Verdicts.svg', label: L('Verdicts', 'الأحكام'), count: 'verdicts' },
]

export default function Sidebar({
  activePane,
  onPaneChange,
  keyLabel,
  keyId,
  keysCount = 0,
  verdictsCount = 0,
  collapsed,
  onToggleCollapse,
}: SidebarProps) {
  return (
    <div className="sidebar" role="navigation" aria-label={L('Workspace', 'مساحة العمل')}>
      <div className="sidebar-head">
        <div className="sidebar-heading">{L('WORKSPACE', 'مساحة العمل')}</div>
        <button type="button" className="collapse-btn" onClick={onToggleCollapse} aria-expanded={!collapsed}
          aria-label={collapsed ? L('Expand the sidebar', 'وسّع الشريط الجانبي') : L('Collapse the sidebar', 'اطوِ الشريط الجانبي')}
          title={collapsed ? L('Expand', 'وسّع') : L('Collapse', 'اطوِ')}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M9 4v16" />
            <path d={collapsed ? 'M13 10l2 2-2 2' : 'M16 10l-2 2 2 2'} />
          </svg>
        </button>
      </div>
      <div className="nav" role="tablist">
        {TABS.map((t) => {
          const n = t.count === 'keys' ? keysCount : t.count === 'verdicts' ? verdictsCount : 0
          return (
            <button
              key={t.pane}
              className={`nav-btn tab ${activePane === t.pane ? 'active' : ''}`}
              type="button"
              role="tab"
              data-pane={t.pane}
              aria-selected={activePane === t.pane}
              onClick={() => onPaneChange(t.pane)}
              title={collapsed ? t.label : undefined}
            >
              <img src={`/console-assets/${t.icon}`} alt="" />
              <span className="nav-label">{t.label}</span>
              {n > 0 && <span className="tab-n">{n}</span>}
            </button>
          )
        })}
      </div>

      {/* Which key this browser is signed in with: its label and id, never any
          part of the secret itself. */}
      <div className="signin-card">
        <div className="signin-label">{L('Signed in with', 'مسجّل الدخول باستخدام')}</div>
        <div className="signin-key">
          <img src="/console-assets/Key.svg" width="14" height="14" alt="" />
          <span className="signin-name" id="ws-key">{keyLabel}</span>
        </div>
        {keyId && <div className="signin-mask" id="ws-mask" dir="ltr">{keyId}</div>}
      </div>
    </div>
  )
}

interface TabbarProps {
  activePane: PaneId
  onPaneChange: (pane: PaneId) => void
  keysCount?: number
  verdictsCount?: number
}

/** On a phone the sidebar becomes a tab bar along the bottom of the screen,
 *  where a thumb reaches it. The same four places, in the same order. */
export function Tabbar({ activePane, onPaneChange, keysCount = 0, verdictsCount = 0 }: TabbarProps) {
  return (
    // A div with the navigation role rather than a <nav>: the site styles every
    // <nav> as its own top bar, which is not what this is.
    <div className="tabbar" role="navigation" aria-label={L('Workspace', 'مساحة العمل')}>
      {TABS.map((t) => {
        const n = t.count === 'keys' ? keysCount : t.count === 'verdicts' ? verdictsCount : 0
        const on = activePane === t.pane
        return (
          <button
            key={t.pane}
            type="button"
            className={`tabbar-btn ${on ? 'active' : ''}`}
            aria-current={on ? 'page' : undefined}
            onClick={() => onPaneChange(t.pane)}
          >
            <span className="tabbar-ico">
              <img src={`/console-assets/${t.icon}`} alt="" />
              {n > 0 && <span className="tabbar-n">{n > 99 ? '99+' : n}</span>}
            </span>
            <span className="tabbar-label">{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}
