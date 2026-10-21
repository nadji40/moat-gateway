import { L, isAr, setLang } from '../../../i18n'

interface TopbarProps {
  onSignout: () => void
  /** The signed-in key's label, shown here on a phone, where there is no sidebar. */
  keyLabel?: string
}

/** The workspace's own header. The site navigation is hidden while signed in,
 *  so the way home and the language switch live here. */
export default function Topbar({ onSignout, keyLabel }: TopbarProps) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label={L('Moat home', 'الصفحة الرئيسية لـ Moat')}>
        <img src="/console-assets/moat-logo.svg" alt="" />
        <span>Moat</span>
      </a>
      {keyLabel && (
        <span className="topbar-key" title={L('Signed in with', 'مسجّل الدخول باستخدام')}>
          <img src="/console-assets/Key.svg" width="12" height="12" alt="" />
          <span>{keyLabel}</span>
        </span>
      )}
      <div className="topbar-actions">
        <button
          type="button"
          className="langbtn"
          lang={isAr() ? 'en' : 'ar'}
          aria-label={isAr() ? 'Switch to English' : 'التبديل إلى العربية'}
          title={isAr() ? 'English' : 'العربية'}
          onClick={() => setLang(isAr() ? 'en' : 'ar')}
        >
          {isAr()
            ? <img src="https://flagcdn.com/us.svg" width={22} height={16} alt="" />
            : <img src="https://flagcdn.com/dz.svg" width={22} height={16} alt="" />}
        </button>
        <button className="btn btn-dark sign-out" id="signout" type="button" onClick={onSignout}
          aria-label={L('Sign out', 'تسجيل الخروج')}>
          <img src="/console-assets/Sign_out_squre.svg" width="18" height="18" alt="" />
          <span className="signout-label">{L('Sign out', 'تسجيل الخروج')}</span>
        </button>
      </div>
    </header>
  )
}
