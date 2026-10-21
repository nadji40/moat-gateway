import { L } from '../../../i18n'

interface TopbarProps {
  onSignout: () => void
}

export default function Topbar({ onSignout }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/console-assets/Moat logo.svg" alt="Moat" />
        <span>Moat</span>
      </div>
      <button className="btn btn-dark sign-out" id="signout" type="button" onClick={onSignout}>
        <img src="/console-assets/Sign_out_squre.svg" width="18" height="18" alt="" />
        <span>{L('Sign out', 'تسجيل الخروج')}</span>
      </button>
    </header>
  )
}
