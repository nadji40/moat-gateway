import { useEffect } from 'react'
import Footer from '../../components/layout/Footer'

type Member = {
  name: string
  role: string
  line: string
  /** A photo, when there is one. Until then the card shows initials. */
  photo?: string
}

type Group = { title: string; members: Member[] }

/** In the order the work flows: who started it, who builds it, who makes it
 *  read, who attacks it, who checks it lets the right payments through, and
 *  who studies the market it goes into. */
const groups: Group[] = [
  { title: 'Leadership', members: [
    { name: 'Nadji Sabri', role: 'Founder', line: 'Started Moat. Builds the gateway, the policy engine and the infrastructure it runs on.' },
  ] },
  { title: 'Engineering', members: [
    { name: 'Khawla Hammouda', role: 'Front-end engineer', line: 'The React site you are reading.' },
    { name: 'Rayan Yasser Ouanes', role: 'Design and front-end', line: 'Design and front-end work across the site.' },
  ] },
  { title: 'Data and ML', members: [
    { name: 'Zahra Boucheta', role: 'Data and ML', line: 'The intent reader: which model, how accurate, how fast.' },
  ] },
  { title: 'Security', members: [
    { name: 'Adam Belkadi', role: 'Security engineer', line: 'Keys, permissions, workspace isolation and the dashboard.' },
    { name: 'Rofeida Imoussaine', role: 'Security engineer', line: 'Attacks on the payment checks, the reader and the evidence chain.' },
  ] },
  { title: 'Testing', members: [
    { name: 'Redwan Ben', role: 'Adversarial testing', line: 'The attack corpus: every way to get a payment past Moat, tried.' },
    { name: 'Dhoha Boumediene', role: 'Policy testing', line: 'Honest payments, limits and currencies: making sure the right payments go through.' },
    { name: 'Meriem Sara Aounallah', role: 'Language testing', line: 'Arabic dialects, names and currencies: how Moat reads what people actually write.' },
  ] },
  { title: 'Research', members: [
    { name: 'Mounya Hasni', role: 'Research analyst', line: 'Regulation and market research: what the rules require, and who needs this.' },
  ] },
]

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')

function Avatar({ member }: { member: Member }) {
  if (member.photo) return <img className="tm-pic" src={member.photo} alt="" loading="lazy" />
  return <span className="tm-pic tm-initials" aria-hidden="true" data-photo="pending">{initials(member.name)}</span>
}

export default function Team() {
  useEffect(() => { document.title = 'moat, who we are' }, [])

  return (
    <>
      <main className="team">
        <div className="wrap">
          <header className="hero">
            <p className="kicker">Who we are</p>
            <h1>Ten people who want agents<br />to <span className="g">pay only what was asked.</span></h1>
            <p className="lede">Moat started in 2026 as one question: when an AI agent pays the wrong company, who could have stopped it? The answer was a gateway that checks every payment against the user's own words. We build it, and we spend most of our time trying to break it.</p>
          </header>

          <section className="tight tm-groups">
            {groups.map((g) => (
              <div className="tm-group" key={g.title}>
                <h2 className="tm-h">{g.title}</h2>
                <div className="tm-grid">
                  {g.members.map((m) => (
                    <article className="tm-card glass" key={m.name}>
                      <Avatar member={m} />
                      <h3>{m.name}</h3>
                      <p className="tm-role">{m.role}</p>
                      <p className="tm-line">{m.line}</p>
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="tight">
            <div className="tm-how">
              <div className="tm-fact glass"><b>Built in Algeria</b><span>Part of the Thirduni programme, 2026.</span></div>
              <div className="tm-fact glass"><b>Tested by its own team</b><span>Every week, half of us attack what the other half built.</span></div>
              <div className="tm-fact glass"><b>Measured, not promised</b><span>Every number on this site comes from a run you can read the record of.</span></div>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  )
}
