import Footer from '../../components/layout/Footer'
import { L } from '../../i18n'

/* The team page, laid out as the pitch deck lays it out: two rows of five,
   the founder's tile larger in the middle of the first row, every portrait
   on the deck's warm gradient with the corner bitten out. */

type Member = {
  /** The warm word of the name, as the deck sets the given name. */
  first: string
  rest: string
  role: string
  roleAr: string
  line: string
  lineAr: string
  photo: string
  founder?: boolean
}

export const members: Member[] = [
  { first: 'Redwan', rest: 'Benmoussa', role: 'Adversarial data', roleAr: 'بيانات الهجمات',
    line: 'Develops the attack corpus, testing every way a malicious payment could get past Moat.',
    lineAr: 'يبني مجموعة الهجمات، ويجرّب كل طريقة لتمرير دفعة خبيثة رغم Moat.', photo: '/team/redwan.jpg' },
  { first: 'Meriem Sara', rest: 'Aounallah', role: 'Language data', roleAr: 'بيانات اللغة',
    line: 'Arabic dialects, names and currencies, so Moat understands what people actually write.',
    lineAr: 'اللهجات العربية والأسماء والعملات، ليفهم Moat ما يكتبه الناس فعلًا.', photo: '/team/meriem.jpg' },
  { first: 'Khentit', rest: 'Nadji Sabri', role: 'Founder & general manager', roleAr: 'المؤسس والمدير العام',
    line: 'Started Moat. Builds the gateway, the policy engine and the infrastructure it runs on.',
    lineAr: 'أسّس Moat. يبني البوابة ومحرّك السياسات والبنية التحتية التي تعمل عليها.', photo: '/team/nadji.jpg', founder: true },
  { first: 'Dhoha', rest: 'Boumediene', role: 'Policy data', roleAr: 'بيانات السياسات',
    line: 'Legitimate payments, limits and currencies: making sure the right payments go through.',
    lineAr: 'الدفعات السليمة والحدود والعملات: لضمان مرور الدفعات الصحيحة.', photo: '/team/dhoha.jpg' },
  { first: 'Zahra', rest: 'Boucheta', role: 'Data / ML engineer', roleAr: 'مهندسة بيانات وتعلّم آلة',
    line: 'The intent reader: which model, how accurate, how fast.',
    lineAr: 'قارئ النية: أي نموذج، وبأي دقة، وبأي سرعة.', photo: '/team/zahra.jpg' },
  { first: 'Rayan Yasser', rest: 'Ouanoughi', role: 'Design and front-end', roleAr: 'التصميم والواجهات الأمامية',
    line: 'Design and front-end work across the site, the dashboard included.',
    lineAr: 'أعمال التصميم والواجهات الأمامية في الموقع كله، ولوحة التحكم معه.', photo: '/team/rayan.jpg' },
  { first: 'Khawla', rest: 'Hammouda', role: 'Front-end engineer', roleAr: 'مهندسة واجهات أمامية',
    line: 'The React site you are reading.',
    lineAr: 'موقع React الذي تقرؤه الآن.', photo: '/team/khawla.jpg' },
  { first: 'Mounya', rest: 'Hasni', role: 'Research analyst', roleAr: 'محلّلة أبحاث',
    line: 'Regulatory and market research: what the rules require, and who needs Moat.',
    lineAr: 'أبحاث التنظيم والسوق: ما تشترطه القواعد، ومن يحتاج إلى Moat.', photo: '/team/mounya.jpg' },
  { first: 'Rofeida', rest: 'Imoussaine', role: 'Security engineer', roleAr: 'مهندسة أمن',
    line: 'Attacks on the payment checks, the intent reader and the evidence chain.',
    lineAr: 'الهجمات على فحوص الدفع وقارئ النية وسلسلة الأدلة.', photo: '/team/rofeida.jpg' },
  { first: 'Adam', rest: 'Belkadi', role: 'Security engineer', roleAr: 'مهندس أمن',
    line: 'Keys, permissions, workspace isolation and the dashboard.',
    lineAr: 'المفاتيح والصلاحيات وعزل مساحات العمل ولوحة التحكم.', photo: '/team/adam.jpg' },
]

function Tile({ m }: { m: Member }) {
  const name = `${m.first} ${m.rest}`
  return (
    <li className={m.founder ? 'tm-tile founder' : 'tm-tile'}>
      <div className="tm-photo gl-notch">
        <img src={m.photo} alt={name} loading="lazy" width={435} height={326} />
      </div>
      <h3 className="tm-name gl-name"><b>{m.first}</b> {m.rest}</h3>
      <p className="tm-role">{L(m.role, m.roleAr)}</p>
      <p className="tm-line">{L(m.line, m.lineAr)}</p>
    </li>
  )
}

export default function Team() {
  return (
    <>
      <div className="wrap team gl-glow top">
        <header className="hero">
          <div>
            <p className="kicker">{L('The team', 'الفريق')}</p>
            <h1>{L(<>An Algerian team <span className="gl-grad">with a global dream</span></>, <>فريق جزائري <span className="gl-grad">بحلم عالمي</span></>)}</h1>
            <p className="lede">{L(
              'Ten people who want agents to pay only what was asked. Half of us build Moat; the other half spend their week trying to get a payment past it.',
              'عشرة أشخاص يريدون للوكلاء ألّا يدفعوا إلا ما طُلب. نصفنا يبني Moat، والنصف الآخر يقضي أسبوعه محاولًا تمرير دفعة رغمه.',
            )}</p>
          </div>
        </header>

        <section className="tight" aria-label={L('The people', 'الأشخاص')}>
          <ul className="tm-deck">
            {members.map((m) => <Tile key={m.photo} m={m} />)}
          </ul>
        </section>

        <section className="tight">
          <div className="tm-how">
            <div className="tm-fact gl-card"><b>{L('Built in Algeria', 'صُنع في الجزائر')}</b><span>{L('Part of the Thirduni programme, 2026', 'ضمن برنامج Thirduni، 2026')}</span></div>
            <div className="tm-fact gl-card"><b>{L('Tested by its own team', 'يختبره فريقه نفسه')}</b><span>{L('Every week, half of us attack what the other half built', 'كل أسبوع، يهاجم نصفنا ما بناه النصف الآخر')}</span></div>
            <div className="tm-fact gl-card"><b>{L('Measured, not promised', 'أرقام مقيسة، لا وعود')}</b><span>{L('Every number on this site comes from a run you can read the record of', 'كل رقم في هذا الموقع مصدره تشغيل يمكنك قراءة سجله')}</span></div>
          </div>
        </section>
      </div>
      <Footer />
    </>
  )
}
