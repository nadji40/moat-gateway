import { L, isAr, setLang } from '../../../i18n'

interface TopbarProps {
  onSignout: () => void
  theme: 'dark' | 'light'
  onTheme: () => void
  onTour: () => void
  /** The signed-in key's label, shown here on a phone, where there is no sidebar. */
  keyLabel?: string
}

/** The workspace's own header. The site navigation is hidden while signed in,
 *  so the way home and the language switch live here. */
export default function Topbar({ onSignout, keyLabel, theme, onTheme, onTour }: TopbarProps) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label={L('Moat home', 'الصفحة الرئيسية لـ Moat')}>
        <img src="/console-assets/moat-logo.svg" alt="" />
      </a>
      {keyLabel && (
        <span className="topbar-key" title={L('Signed in with', 'مسجّل الدخول باستخدام')}>
          <img src="/console-assets/Key.svg" width="12" height="12" alt="" />
          <span>{keyLabel}</span>
        </span>
      )}
      <div className="topbar-actions">
        <button type="button" className="icon-btn tour-btn" onClick={onTour}
          aria-label={L('Show me around', 'جولة في لوحة التحكم')} title={L('Tour', 'جولة')}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.4" />
            <path d="M12 16.8h.01" strokeWidth="2.6" />
          </svg>
        </button>
        <button type="button" className="icon-btn theme-btn" onClick={onTheme}
          aria-label={theme === 'dark' ? L('Light mode', 'الوضع الفاتح') : L('Dark mode', 'الوضع الداكن')}
          title={theme === 'dark' ? L('Light mode', 'الوضع الفاتح') : L('Dark mode', 'الوضع الداكن')}>
          {theme === 'dark' ? (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
            </svg>
          )}
        </button>
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
