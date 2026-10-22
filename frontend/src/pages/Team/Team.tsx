import { useEffect, useMemo, useRef, useState } from 'react'
import Footer from '../../components/layout/Footer'
import { L } from '../../i18n'

type Member = {
  name: string
  role: string
  roleAr: string
  line: string
  lineAr: string
  /** A photo, when there is one. Until then the node shows initials. */
  photo?: string
}

type Team = { name: string; nameAr: string; members: Member[] }

const founder: Member = {
  name: 'Khentit Nadji Sabri',
  role: 'Founder',
  roleAr: 'المؤسس',
  line: 'Started Moat. Builds the gateway, the policy engine and the infrastructure it runs on.',
  lineAr: 'أسّس Moat. يبني البوابة ومحرّك السياسات والبنية التحتية التي تعمل عليها.',
  photo: '/team/nadji.jpg',
}

/** Data has the most people, so it gets the right side of the molecule,
 *  where there is room for four branches. */
const teams: Team[] = [
  { name: 'Engineering', nameAr: 'الهندسة', members: [
    { name: 'Khawla Hammouda', role: 'Front-end engineer', roleAr: 'مهندسة واجهات أمامية', line: 'The React site you are reading', lineAr: 'موقع React الذي تقرؤه الآن', photo: '/team/khawla.jpg' },
    { name: 'Rayan Yasser Ouanoughi', role: 'Design and front-end', roleAr: 'التصميم والواجهات الأمامية', line: 'Design and front-end work across the site', lineAr: 'أعمال التصميم والواجهات الأمامية في الموقع كله', photo: '/team/rayan.jpg' },
  ] },
  { name: 'Research', nameAr: 'البحث', members: [
    { name: 'Mounya Hasni', role: 'Research analyst', roleAr: 'محلّلة أبحاث', line: 'Regulation and market research: what the rules require, and who needs this', lineAr: 'أبحاث التنظيم والسوق: ما تشترطه القواعد، ومن يحتاج إلى هذا' },
  ] },
  { name: 'Data', nameAr: 'البيانات', members: [
    { name: 'Zahra Boucheta', role: 'Data and ML', roleAr: 'البيانات وتعلّم الآلة', line: 'The intent reader: which model, how accurate, how fast', lineAr: 'قارئ النية: أي نموذج، وبأي دقة، وبأي سرعة', photo: '/team/zahra.jpg' },
    { name: 'Redwan Ben', role: 'Adversarial data', roleAr: 'بيانات الهجمات', line: 'The attack corpus: every way to get a payment past Moat, tried', lineAr: 'مجموعة الهجمات: جُرّبت كل طريقة لتمرير دفعة رغم Moat', photo: '/team/redwan.jpg' },
    { name: 'Dhoha Boumediene', role: 'Policy data', roleAr: 'بيانات السياسات', line: 'Honest payments, limits and currencies: making sure the right payments go through', lineAr: 'الدفعات السليمة والحدود والعملات: لضمان مرور الدفعات الصحيحة', photo: '/team/dhoha.jpg' },
    { name: 'Meriem Sara Aounallah', role: 'Language data', roleAr: 'بيانات اللغة', line: 'Arabic dialects, names and currencies: how Moat reads what people actually write', lineAr: 'اللهجات العربية والأسماء والعملات: كيف يقرأ Moat ما يكتبه الناس فعلًا', photo: '/team/meriem.jpg' },
  ] },
  { name: 'Security', nameAr: 'الأمن', members: [
    { name: 'Adam Belkadi', role: 'Security engineer', roleAr: 'مهندس أمن', line: 'Keys, permissions, workspace isolation and the dashboard', lineAr: 'المفاتيح والصلاحيات وعزل مساحات العمل ولوحة التحكم', photo: '/team/adam.jpg' },
    { name: 'Rofeida Imoussaine', role: 'Security engineer', roleAr: 'مهندسة أمن', line: 'Attacks on the payment checks, the reader and the evidence chain', lineAr: 'الهجمات على فحوص الدفع وقارئ النية وسلسلة الأدلة', photo: '/team/rofeida.jpg' },
  ] },
]

const teamNameAr = (name: string) => teams.find((t) => t.name === name)?.nameAr ?? name

const TEAM_ANGLE: Record<string, number> = { Engineering: 180, Research: 270, Data: 0, Security: 90 }

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')

/* ---- layout ------------------------------------------------------------- */

const C = { x: 500, y: 400 }
const R_CENTER = 56
const R_TEAM = 42
const R_MEMBER = 31
const TEAM_DIST = 190
const MEMBER_DIST = 140

/* The entrance, in order: the circles fade in (the centre, then the teams,
   then the people one by one); only once the last is fully there do the
   bonds draw in, the centre's first and the branches after; only then do
   pulses start along them. In seconds. */
const NODE_IN = 1.4
const TEAM_DELAY = 0.5
const MEMBER_DELAY = 1.1
const MEMBER_STEP = 0.09
const BOND_IN = 0.8
const BRANCH_DELAY = 0.45
const BRANCH_STEP = 0.06

type Label = { x: number; y: number; anchor: 'start' | 'middle' | 'end'; lines: 'below' | 'above' | 'side' }
type Node = {
  id: string
  kind: 'center' | 'team' | 'member'
  x: number
  y: number
  r: number
  member?: Member
  team?: string
  /** Where the label sits, pointing away from the node it branches from. */
  label?: Label
}
type Edge = { id: string; from: string; to: string }

function layout() {
  const nodes: Node[] = [{ id: 'center', kind: 'center', x: C.x, y: C.y, r: R_CENTER, member: founder }]
  const edges: Edge[] = []
  for (const t of teams) {
    const a = (TEAM_ANGLE[t.name]! * Math.PI) / 180
    const tx = C.x + TEAM_DIST * Math.cos(a)
    const ty = C.y + TEAM_DIST * Math.sin(a)
    const tid = `team:${t.name}`
    nodes.push({ id: tid, kind: 'team', x: tx, y: ty, r: R_TEAM, team: t.name })
    edges.push({ id: `e:${tid}`, from: 'center', to: tid })
    const n = t.members.length
    const step = n > 2 ? 38 : 44
    t.members.forEach((m, i) => {
      const ma = a + ((i - (n - 1) / 2) * step * Math.PI) / 180
      const ux = Math.cos(ma)
      const uy = Math.sin(ma)
      const x = tx + MEMBER_DIST * ux
      const y = ty + MEMBER_DIST * uy
      const gap = R_MEMBER + 16
      const label: Label =
        uy < -0.85 ? { x, y: y - gap, anchor: 'middle', lines: 'above' }
        : uy > 0.6 && Math.abs(ux) < 0.2 ? { x, y: y + gap, anchor: 'middle', lines: 'below' }
        : ux > 0 ? { x: x + gap, y, anchor: 'start', lines: 'side' }
        : { x: x - gap, y, anchor: 'end', lines: 'side' }
      const id = `m:${m.name}`
      nodes.push({ id, kind: 'member', x, y, r: R_MEMBER, member: m, team: t.name, label })
      edges.push({ id: `e:${id}`, from: tid, to: id })
    })
  }
  return { nodes, edges }
}

const clipId = (id: string) => `clip-${id.replace(/\W/g, '')}`

/* ---- the molecule ------------------------------------------------------- */

function Molecule({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const { nodes, edges } = useMemo(layout, [])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const nodeRefs = useRef(new Map<string, SVGGElement>())
  const edgeRefs = useRef(new Map<string, SVGLineElement>())
  const pulseRefs = useRef(new Map<string, SVGCircleElement>())

  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const members = nodes.filter((n) => n.kind === 'member').length
  const branches = edges.filter((e) => e.from !== 'center').length
  const nodesSettle = MEMBER_DELAY + (members - 1) * MEMBER_STEP + NODE_IN
  const bondsSettle = BRANCH_DELAY + (branches - 1) * BRANCH_STEP + BOND_IN
  // nodes: circles arriving, no bonds; bonds: bonds drawing in; live: pulses.
  const [phase, setPhase] = useState<'nodes' | 'bonds' | 'live'>(reduce ? 'live' : 'nodes')
  const pulseStart = useRef<number | null>(null)
  useEffect(() => {
    if (reduce) return
    const a = setTimeout(() => setPhase('bonds'), nodesSettle * 1000)
    const z = setTimeout(() => {
      setPhase('live')
      pulseStart.current = typeof performance !== 'undefined' ? performance.now() : 0
    }, (nodesSettle + bondsSettle) * 1000)
    return () => { clearTimeout(a); clearTimeout(z) }
  }, [reduce, nodesSettle, bondsSettle])

  // The bonds that lead to the selected node, so its path from the centre lights.
  const lit = useMemo(() => {
    const on = new Set<string>([selected])
    const node = byId.get(selected)
    if (node?.kind === 'member') { on.add(`team:${node.team}`); on.add('center'); on.add(`e:team:${node.team}`); on.add(`e:${node.id}`) }
    if (node?.kind === 'team') { on.add('center'); on.add(`e:${node.id}`) }
    return on
  }, [selected, byId])

  /* Every node drifts on its own slow orbit, and a pulse travels each bond
     outward from the centre. Positions are written to the DOM each frame;
     React renders the molecule once and leaves the motion alone. */
  useEffect(() => {
    if (reduce || typeof requestAnimationFrame !== 'function') return
    const seed = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7)
    const motion = new Map(nodes.map((n) => {
      const s = seed(n.id)
      const amp = n.kind === 'center' ? 3 : n.kind === 'team' ? 5 : 7
      return [n.id, { amp, px: 9000 + (s % 7) * 1100, py: 11000 + (s % 5) * 1300, ph: s }]
    }))
    const at = (n: Node, t: number) => {
      const m = motion.get(n.id)!
      return {
        x: n.x + m.amp * Math.sin((t / m.px) * 2 * Math.PI + m.ph),
        y: n.y + m.amp * Math.cos((t / m.py) * 2 * Math.PI + m.ph * 1.3),
      }
    }
    let frame = 0
    const tick = (t: number) => {
      const now = new Map(nodes.map((n) => [n.id, at(n, t)]))
      for (const [id, g] of nodeRefs.current) {
        const p = now.get(id)!
        g.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`)
      }
      edges.forEach((e, i) => {
        const a = now.get(e.from)!
        const b = now.get(e.to)!
        const line = edgeRefs.current.get(e.id)
        if (line) {
          line.setAttribute('x1', a.x.toFixed(2)); line.setAttribute('y1', a.y.toFixed(2))
          line.setAttribute('x2', b.x.toFixed(2)); line.setAttribute('y2', b.y.toFixed(2))
        }
        const dot = pulseRefs.current.get(e.id)
        const since = pulseStart.current === null ? -1 : t - pulseStart.current
        if (dot && since < 0) dot.setAttribute('opacity', '0')
        if (dot && since >= 0) {
          // Bonds from the centre fire first, the branches after them, and
          // the pulses fade in rather than appearing halfway along a bond.
          const offset = (e.from === 'center' ? 0 : 0.45) + i * 0.07
          const p = (since / 6500 + offset) % 1
          const arrive = Math.min(1, since / 1500)
          const ra = byId.get(e.from)!.r
          const rb = byId.get(e.to)!.r
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
          const s = (ra + (len - ra - rb) * p) / len
          dot.setAttribute('cx', (a.x + (b.x - a.x) * s).toFixed(2))
          dot.setAttribute('cy', (a.y + (b.y - a.y) * s).toFixed(2))
          dot.setAttribute('opacity', (Math.sin(Math.PI * p) * 0.9 * arrive).toFixed(3))
        }
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [nodes, edges, byId, reduce])

  const handlers = (id: string) => ({
    onMouseEnter: () => onSelect(id),
    onFocus: () => onSelect(id),
    onClick: () => onSelect(id),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id) } },
  })

  let order = 0
  return (
    <svg className="mol" viewBox="-110 0 1220 800" role="group" style={{ direction: 'ltr' }}
      aria-label={L('The Moat team: Khentit Nadji Sabri at the centre, connected to four teams and their members', 'فريق Moat: Khentit Nadji Sabri في المركز، متصلًا بأربعة فرق وأعضائها')}>
      <defs>
        <radialGradient id="mol-core" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#FF8A4C" />
          <stop offset="70%" stopColor="#FF5F00" />
          <stop offset="100%" stopColor="#B84400" />
        </radialGradient>
        <radialGradient id="mol-glow">
          <stop offset="0%" stopColor="rgba(255,95,0,.35)" />
          <stop offset="100%" stopColor="rgba(255,95,0,0)" />
        </radialGradient>
        {nodes.filter((n) => n.member?.photo).map((n) => (
          <clipPath id={clipId(n.id)} key={n.id}><circle r={n.r - 2} /></clipPath>
        ))}
      </defs>

      <circle className="mol-halo" cx={C.x} cy={C.y} r="330" fill="url(#mol-glow)" />

      <g className={`mol-edges${phase === 'nodes' ? '' : ' in'}`}>
        {edges.map((e, i) => {
          const a = byId.get(e.from)!
          const b = byId.get(e.to)!
          const core = e.from === 'center'
          const branch = edges.slice(0, i).filter((x) => x.from !== 'center').length
          // The reveal's delays only apply while it runs, so a highlight on
          // hover later is never held back by them.
          const delay = phase === 'bonds' ? `${core ? i * 0.05 : BRANCH_DELAY + branch * BRANCH_STEP}s` : undefined
          return <line key={e.id} ref={(el) => { if (el) edgeRefs.current.set(e.id, el) }} className={`mol-edge${core ? ' core' : ''}${lit.has(e.id) ? ' on' : ''}`} style={delay ? { transitionDelay: delay } : undefined} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        })}
      </g>
      <g className="mol-pulses" aria-hidden="true">
        {edges.map((e) => <circle key={e.id} ref={(el) => { if (el) pulseRefs.current.set(e.id, el) }} r={e.from === 'center' ? 4 : 3} opacity="0" />)}
      </g>

      {nodes.map((n) => {
        const delay = `${n.kind === 'center' ? 0 : n.kind === 'team' ? TEAM_DELAY : MEMBER_DELAY + order++ * MEMBER_STEP}s`
        const name = n.member?.name ?? n.team!
        const shown = n.member ? name : L(name, teamNameAr(name))
        const role = n.member ? L(n.member.role, n.member.roleAr) : ''
        const label = n.label
        const lines = label && (label.lines === 'below' ? [label.y + 4, label.y + 21] : label.lines === 'above' ? [label.y - 18, label.y - 1] : [label.y - 3, label.y + 14])
        return (
          <g key={n.id} ref={(el) => { if (el) nodeRefs.current.set(n.id, el) }} transform={`translate(${n.x} ${n.y})`}>
            <g className={`mol-node ${n.kind}${lit.has(n.id) ? ' on' : ''}${selected === n.id ? ' sel' : ''}`} style={{ animationDelay: delay }}
               tabIndex={0} role="button" aria-label={n.member ? L(`${name}, ${n.member.role}`, `${name}، ${role}`) : L(`${name} team`, `فريق ${shown}`)} aria-pressed={selected === n.id} {...handlers(n.id)}>
              <circle className="mol-dot" r={n.r} />
              {n.member?.photo
                ? <>
                    <image href={n.member.photo} x={-(n.r - 2)} y={-(n.r - 2)} width={(n.r - 2) * 2} height={(n.r - 2) * 2} clipPath={`url(#${clipId(n.id)})`} preserveAspectRatio="xMidYMid slice" />
                    <circle className="mol-rim" r={n.r - 1} />
                  </>
                : n.kind === 'team'
                  ? <text className="mol-team" textAnchor="middle" dy="5">{shown}</text>
                  : <text className="mol-ini" textAnchor="middle" dy={n.kind === 'center' ? 9 : 6}>{initials(name)}</text>}
              {n.kind === 'center' && (
                <>
                  <text className="mol-name" textAnchor="middle" y={n.r + 34}>{founder.name}</text>
                  <text className="mol-role" textAnchor="middle" y={n.r + 52}>{L(founder.role, founder.roleAr)}</text>
                </>
              )}
              {label && lines && (
                <>
                  <text className="mol-name" x={label.x - n.x} y={lines[0]! - n.y} textAnchor={label.anchor}>{name}</text>
                  <text className="mol-role" x={label.x - n.x} y={lines[1]! - n.y} textAnchor={label.anchor}>{role}</text>
                </>
              )}
            </g>
          </g>
        )
      })}
    </svg>
  )
}

/* ---- the page ----------------------------------------------------------- */

function Avatar({ member }: { member: Member }) {
  if (member.photo) return <img className="tm-pic" src={member.photo} alt="" loading="lazy" />
  return <span className="tm-pic tm-initials" aria-hidden="true" data-photo="pending">{initials(member.name)}</span>
}

function Card({ member }: { member: Member }) {
  return (
    <article className="tm-card glass">
      <Avatar member={member} />
      <h3>{member.name}</h3>
      <p className="tm-role">{L(member.role, member.roleAr)}</p>
      <p className="tm-line">{L(member.line, member.lineAr)}</p>
    </article>
  )
}

export default function TeamPage() {
  const [selected, setSelected] = useState('center')
  useEffect(() => { document.title = L('moat, who we are', 'moat، من نحن') }, [])

  const team = selected.startsWith('team:') ? teams.find((t) => `team:${t.name}` === selected) : undefined
  const owner = teams.find((t) => t.members.some((m) => `m:${m.name}` === selected))
  const person = selected === 'center' ? founder : owner?.members.find((m) => `m:${m.name}` === selected)

  return (
    <>
      <main className="team">
        <div className="wrap">
          <header className="hero">
            <p className="kicker">{L('Who we are', 'من نحن')}</p>
            <h1>{L(
              <>Ten people who want agents<br />to <span className="g">pay only what was asked</span></>,
              <>عشرة أشخاص يريدون للوكلاء<br />أن <span className="g">لا يدفعوا إلا ما طُلب</span></>,
            )}</h1>
          </header>

          <section className="tight mol-wrap" aria-label={L('Team structure', 'هيكل الفريق')}>
            <Molecule selected={selected} onSelect={setSelected} />
            <div className="mol-card glass" aria-live="polite">
              {person && (
                <>
                  <Avatar member={person} />
                  <div>
                    <p className="tm-role">{owner ? L(`${owner.name} team`, `فريق ${owner.nameAr}`) : L('Founder', 'المؤسس')}</p>
                    <h3>{person.name}</h3>
                    <p className="tm-sub">{L(person.role, person.roleAr)}</p>
                    <p className="tm-line">{L(person.line, person.lineAr)}</p>
                  </div>
                </>
              )}
              {team && (
                <div>
                  <p className="tm-role">{L('Team', 'الفريق')}</p>
                  <h3>{L(team.name, team.nameAr)}</h3>
                  <p className="tm-line">{team.members.map((m) => m.name).join(L(', ', '، '))}</p>
                </div>
              )}
            </div>
          </section>

          {/* On a phone the molecule is too small to read, so the same
              structure is shown as a list instead. */}
          <section className="tight tm-groups">
            <div className="tm-group">
              <h2 className="tm-h">{L('Founder', 'المؤسس')}</h2>
              <div className="tm-grid"><Card member={founder} /></div>
            </div>
            {teams.map((t) => (
              <div className="tm-group" key={t.name}>
                <h2 className="tm-h">{L(t.name, t.nameAr)}</h2>
                <div className="tm-grid">{t.members.map((m) => <Card key={m.name} member={m} />)}</div>
              </div>
            ))}
          </section>

          <section className="tight">
            <div className="tm-how">
              <div className="tm-fact glass"><b>{L('Built in Algeria', 'صُنع في الجزائر')}</b><span>{L('Part of the Thirduni programme, 2026', 'ضمن برنامج Thirduni، 2026')}</span></div>
              <div className="tm-fact glass"><b>{L('Tested by its own team', 'يختبره فريقه نفسه')}</b><span>{L('Every week, half of us attack what the other half built', 'كل أسبوع، يهاجم نصفنا ما بناه النصف الآخر')}</span></div>
              <div className="tm-fact glass"><b>{L('Measured, not promised', 'أرقام مقيسة، لا وعود')}</b><span>{L('Every number on this site comes from a run you can read the record of', 'كل رقم في هذا الموقع مصدره تشغيل يمكنك قراءة سجله')}</span></div>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  )
}
