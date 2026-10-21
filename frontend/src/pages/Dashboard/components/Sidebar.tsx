import { L } from '../../../i18n'

type PaneId = 'pane-usage' | 'pane-verdicts' | 'pane-keys' | 'pane-playground'

interface SidebarProps {
  activePane: PaneId
  onPaneChange: (pane: PaneId) => void
  keyLabel: string
  maskedKey: string
  keysCount?: number
  verdictsCount?: number
}

export default function Sidebar({
  activePane,
  onPaneChange,
  keyLabel,
  maskedKey,
  keysCount = 0,
  verdictsCount = 0,
}: SidebarProps) {
  return (
    <nav className="sidebar">
      <div className="sidebar-heading">LAYER</div>
      <div className="nav">
        <button
          className={`nav-btn tab ${activePane === 'pane-usage' ? 'active' : ''}`}
          type="button"
          data-pane="pane-usage"
          aria-selected={activePane === 'pane-usage'}
          onClick={() => onPaneChange('pane-usage')}
        >
          <img src="/console-assets/Usage.svg" alt="" />
          <span className="nav-label">Usage</span>
        </button>

        <button
          className={`nav-btn tab ${activePane === 'pane-keys' ? 'active' : ''}`}
          type="button"
          data-pane="pane-keys"
          aria-selected={activePane === 'pane-keys'}
          onClick={() => onPaneChange('pane-keys')}
        >
          <img src="/console-assets/Key.svg" alt="" />
          <span className="nav-label">Api keys</span>
          {keysCount > 0 && (
            <span className="tab-n" id="tab-keys-n">
              {keysCount}
            </span>
          )}
        </button>

        <button
          className={`nav-btn tab ${activePane === 'pane-playground' ? 'active' : ''}`}
          type="button"
          data-pane="pane-playground"
          aria-selected={activePane === 'pane-playground'}
          onClick={() => onPaneChange('pane-playground')}
        >
          <img src="/console-assets/code (playground).svg" alt="" />
          <span className="nav-label">Play ground</span>
        </button>

        <button
          className={`nav-btn tab ${activePane === 'pane-verdicts' ? 'active' : ''}`}
          type="button"
          data-pane="pane-verdicts"
          aria-selected={activePane === 'pane-verdicts'}
          onClick={() => onPaneChange('pane-verdicts')}
        >
          <img src="/console-assets/Verdicts.svg" alt="" />
          <span className="nav-label">Verdicts</span>
          {verdictsCount > 0 && (
            <span className="tab-n" id="tab-verdicts-n">
              {verdictsCount}
            </span>
          )}
        </button>
      </div>

      <div className="signin-card">
        <div className="signin-label">{L('Sign in with', 'تسجيل الدخول باستخدام')}</div>
        <div className="signin-key">
          <img src="/console-assets/Key.svg" width="14" height="14" alt="" />
          <span className="signin-name" id="ws-key">
            {keyLabel}
          </span>
        </div>
        <div className="signin-mask" id="ws-mask">
          {maskedKey || 'mk_live_...8f2a'}
        </div>
      </div>
    </nav>
  )
}
