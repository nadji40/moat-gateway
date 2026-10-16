// The playground: the compose card, driven by this workspace's own keys.
//
// It used to live on the public landing page against /v1/sandbox, which is a
// throwaway gateway with no account behind it. That proved the product to a
// stranger and proved nothing to a customer: none of it touched their tenant,
// their policy or their evidence.
//
// Here it runs the real thing. The agent side is an `agent` key on /mcp. The
// trusted side is an `approver` key on the intent API. They are two keys on
// purpose and the split is the whole design: an agent that could register its
// own intent would be an agent that authorizes itself, so the key that says
// what the user asked for is one the agent never sees.
//
// Both are minted by this page with the admin key you signed in with, held in
// this browser, and listed in the Keys tab like any other. Revoke them there
// and the playground mints a new pair.

// Everything below runs in its own scope. This file shares a page with the
// dashboard's inline script, which has a `show` of its own -- one takes a
// selector and a boolean, this one takes a slide index -- and at global scope
// the second declaration is a SyntaxError that kills the whole file. The
// helpers it borrows ($, esc, control, working, idle) are globals and reading
// them from in here is unaffected.
(() => {

/* ---------------------------------------------------------------------
   The two keys this page works with.

   Kept in localStorage because a key is shown once. Losing them costs a
   pair of revocable keys, not access to anything, so the browser is a fine
   place for them, and the alternative -- asking the operator to paste two
   keys every visit -- is worse.
   --------------------------------------------------------------------- */
const PG_KEYS = "moat.playground.keys";

function pgKeys() {
  try { return JSON.parse(localStorage.getItem(PG_KEYS) || "null"); } catch { return null; }
}
function pgHold(v) {
  try { v ? localStorage.setItem(PG_KEYS, JSON.stringify(v)) : localStorage.removeItem(PG_KEYS); } catch { /* private window */ }
}

/** Mint the pair, with exactly the scopes each side needs and no others. */
async function pgMint() {
  const mint = async (label, access_role, scopes) => {
    const r = await control("/v1/keys", {
      method: "POST",
      body: JSON.stringify({ label, access_role, scopes }),
    });
    return { id: r.id, secret: r.secret };
  };
  // The agent settles on cards and can do nothing else. The harness writes
  // intent and authorizations and cannot release a held payment, which is a
  // person's decision and not this page's.
  const agent = await mint("playground agent", "agent", ["rail:card"]);
  const approver = await mint("playground harness", "approver", ["intent:write", "authorizations:write"]);
  const keys = { agent, approver };
  pgHold(keys);
  return keys;
}

/** Call the gateway as one of the two, rather than as the admin key. */
async function asKey(secret, path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", authorization: "Bearer " + secret, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(typeof body === "string" ? body : (body && body.error) || res.statusText);
  return body;
}

/** One JSON-RPC call over the MCP endpoint, as the agent. */
async function asAgent(secret, sessionId, message) {
  const res = await fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + secret,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  if (!res.ok && !text.trim().startsWith("{")) throw new Error(text.slice(0, 200) || res.statusText);
  // A notification is answered with 202 and no body at all, so parsing
  // unconditionally turned "the agent said hello" into a JSON error.
  const body = text.trim() ? JSON.parse(text) : {};
  return { body, session: res.headers.get("mcp-session-id") };
}

/* ---------------------------------------------------------------------
   Amounts.

   Number("0.00002dcd") is NaN, and JSON.stringify turns NaN into null, so
   before this the gateway was quietly being sent a payment with no amount
   at all. Two guards: the field keeps itself to digits and one separator as
   you type, and nothing is sent unless it reads back as a positive number.
   --------------------------------------------------------------------- */
function numeric(el){
  el.setAttribute("inputmode","decimal");
  el.addEventListener("input",()=>{
    const was=el.value, at=el.selectionStart;
    let v=was.replace(/,/g,".").replace(/[^0-9.]/g,"");
    const i=v.indexOf(".");
    if(i>=0) v=v.slice(0,i+1)+v.slice(i+1).replace(/\./g,"");
    if(v!==was){ el.value=v; const p=Math.max(0,at-(was.length-v.length)); el.setSelectionRange(p,p); }
    el.removeAttribute("aria-invalid");
  });
}
function amountOf(el){
  const t=el.value.trim(), n=Number(t);
  if(t===""||!isFinite(n)||n<=0){ el.setAttribute("aria-invalid","true"); return null; }
  el.removeAttribute("aria-invalid"); return n;
}
["a-amount","p-amount","amt"].forEach(id=>numeric($("#"+id)));

/* currency pickers, writing through to the hidden field the rest reads */
function pick(id){
  const box=$("#"+id+"-pick"), field=$("#"+id);
  const sync=()=>{ for(const b of box.querySelectorAll("button")) b.setAttribute("aria-checked",String(b.dataset.v===field.value)); };
  for(const b of box.querySelectorAll("button"))
    b.addEventListener("click",()=>{ field.value=b.dataset.v; sync(); field.dispatchEvent(new Event("change",{bubbles:true})); });
  sync(); return sync;
}
const syncApproved=pick("a-currency"), syncTried=pick("p-currency");

/* ---------------------------------------------------------------------
   One verdict panel for all three sources. It stays out of the way until
   there is something in it.
   --------------------------------------------------------------------- */
function verdict(html){
  const v=$("#verdicts"); v.hidden=false;
  const el=document.createElement("div"); el.className="rec"; el.innerHTML=html;
  $("#out").prepend(el);
  sizeDeck();
}
const DECISION={allow:"مسموح بها",step_up:"مُعلَّقة",deny:"مرفوضة"};
const row=(decision,note,tag)=>`<div style="display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap">
    <span class="pill ${esc(decision)}">${esc(L(String(decision).replace("_"," "),DECISION[decision]))}</span>
    <span class="hint">${esc(note)}</span>${tag?`<span class="tag-sim">${esc(tag)}</span>`:""}</div>`;
const why=rs=>rs.length?`<ul>${rs.map(([id,m])=>`<li><strong>${esc(id)}</strong>: ${esc(m)}</li>`).join("")}</ul>`:"";

/* ---------------------------------------------------------------------
   The swiper: two rails, one card each.
   --------------------------------------------------------------------- */
// Scoped to this deck. The dashboard's sign-in gate is a deck of .slide too,
// and an unscoped selector found its hidden first slide, so sizeDeck measured
// zero and refused to set a height: the swiper rendered over empty space.
const SLIDES=[...document.querySelectorAll("#deck .slide")];
const TABS=[...document.querySelectorAll("#swiper [role=tab]")];
let active=0;

function sizeDeck(){
  const h=SLIDES[active].offsetHeight;
  if(h) $("#deck").style.height=h+"px";
}
function show(i,focus){
  active=Math.max(0,Math.min(SLIDES.length-1,i));
  SLIDES.forEach((s,n)=>{
    s.classList.toggle("on",n===active);
    // leaving slides pull back the way they came, so the motion has a direction
    s.style.setProperty("--x",n===active?"0px":(n<active?"-30px":"30px"));
  });
  TABS.forEach((t,n)=>t.setAttribute("aria-selected",String(n===active)));
  const t=TABS[active];
  $("#swiper .thumb").style.width=t.offsetWidth+"px";
  $("#swiper .thumb").style.transform="translateX("+(t.offsetLeft-4)+"px)";
  sizeDeck();
  if(focus) t.focus();
}
// In Arabic the tabs run right to left, so "next" is the arrow pointing left.
const RTL=document.documentElement.dir==="rtl";
const NEXT=RTL?"ArrowLeft":"ArrowRight";
TABS.forEach((t,i)=>{
  t.addEventListener("click",()=>show(i));
  t.addEventListener("keydown",e=>{
    if(e.key==="ArrowRight"||e.key==="ArrowLeft"){e.preventDefault();show(active+(e.key===NEXT?1:-1),true)}
  });
});

/* a real swipe, but only when the gesture starts somewhere that is not a
   control, so dragging to select text in a field still works */
let sx=0,sy=0,dragging=false;
const deck=$("#deck");
deck.addEventListener("pointerdown",e=>{
  if(e.target.closest("input,textarea,button,select,label,a")) return;
  dragging=true; sx=e.clientX; sy=e.clientY;
});
deck.addEventListener("pointerup",e=>{
  if(!dragging) return; dragging=false;
  const dx=e.clientX-sx, dy=e.clientY-sy;
  if(Math.abs(dx)<44||Math.abs(dx)<=Math.abs(dy)) return;   // a scroll, not a swipe
  show(active+((RTL?dx>0:dx<0)?1:-1));
});
deck.addEventListener("pointercancel",()=>{dragging=false});
// the cards change height as content lands in them
new ResizeObserver(sizeDeck).observe(SLIDES[0]);
new ResizeObserver(sizeDeck).observe(SLIDES[1]);
addEventListener("resize",()=>show(active));

/* ---------------------------------------------------------------------
   Off chain: a real sandbox on the gateway.
   --------------------------------------------------------------------- */
/* Nothing written in the invoice is sent anywhere, because a page is not a
   channel that confers authority: in the real thing Moat learns it from the
   tool result the agent read, not from a field. What the page can do is what
   it does in an attack, which is persuade the agent. This is the agent being
   persuaded. */
function payeeFromPage(){
  const m=$("#page").value.match(/(?:remit to|pay to|transfer to|beneficiary is|beneficiary:)\s*([^.\n]+)/i);
  return m?m[1].trim():null;
}
const PRESETS=[[L("Do what the invoice says","نفّذ ما تقوله الفاتورة"),"@page"],
  [L("Exactly what was approved","ما وُوفق عليه تمامًا"),["Monitoring Pro Inc","4.80","USD"]],
  [L("One character off","حرف واحد مختلف"),["Monitoring Pro Inc.","4.80","USD"]],
  [L("A higher price","سعر أعلى"),["Monitoring Pro Inc","9.60","USD"]],
  [L("Over the spending cap","فوق حد الإنفاق"),["Monitoring Pro Inc","501","USD"]],
  [L("Another currency","عملة أخرى"),["Monitoring Pro Inc","4.80","EUR"]]];
$("#chips").innerHTML=PRESETS.map(([l],i)=>`<button type="button" class="chip" data-i="${i}">${esc(l)}</button>`).join("");
for(const el of $("#chips").querySelectorAll(".chip"))
  el.addEventListener("click",()=>{
    const[,v]=PRESETS[+el.dataset.i];
    if(v==="@page"){
      const p=payeeFromPage();
      $("#attempt-status").textContent=p?"":L("the invoice names nobody to remit to","لا تذكر الفاتورة أحدًا للتحويل إليه");
      if(p) $("#p-payee").value=p;
      return;
    }
    $("#p-payee").value=v[0];$("#p-amount").value=v[1];$("#p-currency").value=v[2];syncTried();
    $("#p-amount").removeAttribute("aria-invalid");});

/* ---------------------------------------------------------------------
   One attempt, end to end, through the endpoints a customer uses.

     1. the agent opens an MCP session with its own key
     2. your harness registers what the user typed, with the approver key
     3. and what was approved, as a structured authorization
     4. the agent calls stripe__pay and Moat answers

   The session is rebuilt whenever anything on the trusted side changes,
   because intent is append-only within a session: editing what the user
   said and reusing the session would leave the old sentence on record
   beside the new one, and a payee approved a moment ago would still
   resolve to User.
   --------------------------------------------------------------------- */
let pgSession = null;

/** The session and the user's words: registered once, because intent is
    append-only and re-registering it would leave both sentences on record. */
async function ensureSession() {
  if (pgSession) return pgSession;
  const keys = pgKeys() || await pgMint();

  const open = await asAgent(keys.agent.secret, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "playground", version: "1" } },
  });
  if (open.body.error) throw new Error(open.body.error.message || L("the gateway refused the session","رفضت البوابة الجلسة"));
  const session = open.session;
  if (!session) throw new Error(L("the gateway returned no session id","لم تُرجع البوابة معرّف جلسة"));
  await asAgent(keys.agent.secret, session, { jsonrpc: "2.0", method: "notifications/initialized" });

  // The trusted side. Note the key: the agent never holds this one.
  await asKey(keys.approver.secret, `/v1/session/${encodeURIComponent(session)}/intent`, {
    method: "POST", body: JSON.stringify({ text: $("#intent").value }),
  });
  pgSession = session;
  return session;
}

/**
 * A fresh authorization for every attempt, single-use, as production would
 * write it.
 *
 * Reusing one mandate meant that once an attempt actually paid, every later
 * verdict also carried `authorization-duplicate: invoice already settled`.
 * True, and nothing to do with the field the visitor had just changed: they
 * altered the currency and were told about replay protection. One experiment
 * per attempt keeps the answer about the question.
 */
async function newMandate(session) {
  if (!$("#a-payee").value.trim()) return null;
  const keys = pgKeys();
  const authorization_id = "pg-" + Math.random().toString(36).slice(2, 10);
  const invoice_id = "INV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  await asKey(keys.approver.secret, `/v1/session/${encodeURIComponent(session)}/authorizations`, {
    method: "POST",
    body: JSON.stringify({
      authorization_id, invoice_id,
      payee: $("#a-payee").value,
      amount: $("#a-amount").value,
      currency: $("#a-currency").value,
      // An hour is longer than anyone will sit here, and short enough that
      // a mandate left behind expires on its own.
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      repeat_payments: false,
      max_payments: 1,
    }),
  });
  return { authorization_id, invoice_id };
}

for (const id of ["intent", "a-payee", "a-amount", "a-currency"])
  $("#" + id).addEventListener("change", () => { pgSession = null; });

$("#attempt").addEventListener("click", async () => {
  const s = $("#attempt-status");
  const amount = amountOf($("#p-amount"));
  if (amount === null) { s.textContent = L("that is not an amount", "هذا ليس مبلغًا"); $("#p-amount").focus(); return; }
  if (amountOf($("#a-amount")) === null) { s.textContent = L("the approved amount is not a number", "المبلغ الموافَق عليه ليس رقمًا"); $("#a-amount").focus(); return; }
  s.textContent = "";
  working($("#attempt"), L("Evaluating", "جارٍ التقييم"));
  const call = { payee: $("#p-payee").value, amount, currency: $("#p-currency").value };
  try {
    const session = await ensureSession();
    const mandate = await newMandate(session);
    const keys = pgKeys();
    const args = { ...call };
    if (mandate) { args.authorization_id = mandate.authorization_id; args.invoice_id = mandate.invoice_id; }
    const out = await asAgent(keys.agent.secret, session, {
      jsonrpc: "2.0", id: Date.now() % 100000, method: "tools/call",
      params: { name: "stripe__pay", arguments: args },
    });

    // A refusal arrives as a JSON-RPC error carrying Moat's own verdict; an
    // allow arrives as the provider's reply, because the call was forwarded.
    const err = out.body.error;
    const moat = err && err.data && err.data.moat;
    const decision = moat ? moat.verdict : "allow";
    // Only the provider can say whether anyone was paid, so its own words are
    // what the panel shows rather than a claim of ours.
    const said = !err && out.body.result
      ? String((out.body.result.content || [{}])[0].text || "").slice(0, 220)
      : "";
    const paidNote = err ? L("the provider was never called", "لم يُستدعَ مزوّد الدفع")
      : (said || L("forwarded to the provider", "أُحيلت إلى مزوّد الدفع"));

    const reasons = moat && moat.reasons ? moat.reasons.map((r) => [r.id, r.message]) : [];
    verdict(row(decision, paidNote) +
      `<div class="call mono">${esc(JSON.stringify(call))}</div>` +
      why(reasons) +
      (moat && moat.prompt && !reasons.length ? `<p class="hint">${esc(moat.prompt)}</p>` : "") +
      (moat && moat.evidence_id ? `<div class="call mono dim">${L("evidence", "الأدلة")} ${esc(moat.evidence_id)}</div>` : ""));
    s.textContent = "";
  } catch (e) {
    // A revoked playground key is the common case, and minting a new pair is
    // cheaper than explaining. Anything else is reported as it came.
    if (String(e.message || e).includes("token")) { pgHold(null); pgSession = null; }
    s.textContent = String(e.message || e);
  }
  idle($("#attempt"));
});

/* ---------------------------------------------------------------------
   The simulator.

   These are synthetic testnet addresses, valid in format and belonging to
   nobody. The poisoned one shares the first six and last four characters
   with the approved one, which is how address poisoning works in practice:
   wallets abbreviate the middle, so the two look identical in a list.
   --------------------------------------------------------------------- */
const PAYEE="Northwind Cloud Co";
/* drawn rather than fetched, so the page ships no third-party asset */
const MARK={
  ETH:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 5.2 12.1 12 15.9l6.8-3.8z" opacity=".55"/><path d="M12 17.2 5.2 13.4 12 22l6.8-8.6z"/></svg>',
  SOL:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 5.6H20.5L17.2 8.9H3.5z"/><path d="M3.5 10.4h13.7l3.3 3.3H6.8z" opacity=".65"/><path d="M6.8 15.1H20.5L17.2 18.4H3.5z"/></svg>',
};
const CHAINS=[
  {id:"eip155:84532", name:"Base Sepolia", kind:"evm", asset:"ETH", amount:"0.00002",
   approved:"0x8F3A9c21D5e74B0aC6fE18b2D7c4E90a1B3f52D7",
   poisoned:"0x8F3A44b1907cC2e5d8Ba0173Ee69fD31c0aa52D7",
   other:"0x1c7D6b90Ae324f5108B2dC7a91e0F43b85D6c2A9"},
  {id:"eip155:11155111", name:"Ethereum Sepolia", kind:"evm", asset:"ETH", amount:"0.0001",
   approved:"0x2B6e04Ff91Ca7D3a08e15B9c4D2f70A6e83bC145",
   poisoned:"0x2B6e77aD30b9F1c58e22Ac04B7d9E6538f1bC145",
   other:"0x9dA4F2c018Be73d65A0cB91f34E7a2D08c56B7E1"},
  {id:"eip155:421614", name:"Arbitrum Sepolia", kind:"evm", asset:"ETH", amount:"0.0001",
   approved:"0x4E1cB7a90F3d25e8C06b41Da97f52B3e8Ac60D19",
   poisoned:"0x4E1c33f508Ba71d92C6e40Ab18d73F05b7e60D19",
   other:"0x73BcA015d9E2f846b10C37aE95f2D6b408c1E3A7"},
  {id:"solana:devnet", name:"Solana devnet", kind:"solana", asset:"SOL", amount:"0.001",
   approved:"7mUdRcHt3JwVYPa6kqLN2sGgfEXW9bZQy4hTnAuKsvBd",
   poisoned:"7mUdRcKp8XvBcZa1nTeF5wSjLhGyMdU3ok9RtNAKsvBd",
   other:"Bq9TxLmWcVfR2sEaZ6hUdYnP4jKgX8vC1tHoSbAeMuNr"},
];
const EVM=/^0x[0-9a-fA-F]{40}$/;
/* base58 has no 0, O, I or l, which is most of the reason it is used here */
const B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let chain=CHAINS[0], first=true;

const shapeOk=(c,a)=>c.kind==="evm"?EVM.test(a):B58.test(a);
/* EIP-55 only varies the casing, so an EVM address is compared case-blind;
   base58 is case-significant and is compared exactly. */
const same=(c,a,b)=>c.kind==="evm"?a.toLowerCase()===b.toLowerCase():a===b;
const looksLike=(c,a,b)=>!same(c,a,b)&&a.slice(0,6).toLowerCase()===b.slice(0,6).toLowerCase()
  &&a.slice(-4).toLowerCase()===b.slice(-4).toLowerCase();
const short=a=>a.length>20?a.slice(0,10)+"…"+a.slice(-8):a;

function decide(to,amt){
  const t=to.trim();
  if(!t) return {decision:"deny",reasons:[["destination-missing",L("no destination address was given","لم يُعطَ عنوان وجهة")]]};
  if(!shapeOk(chain,t)) return {decision:"deny",reasons:[["destination-format",
    L(`that is not a valid ${chain.kind==="evm"?"EVM":"Solana"} address, so nothing could be signed for it`,
      `هذا ليس عنوان ${chain.kind==="evm"?"EVM":"Solana"} صالحًا، فلا يمكن توقيع شيء له`)]]};

  if(same(chain,t,chain.approved)){
    const a=Number(amt), cap=Number(chain.amount);
    if(!isFinite(a)||a<=0) return {decision:"deny",reasons:[["amount-invalid",L("that is not an amount","هذا ليس مبلغًا")]]};
    if(a>cap) return {decision:"step_up",reasons:[["authorization-amount",
      L(`${amt} ${chain.asset} is more than the ${chain.amount} ${chain.asset} you approved, so a person has to confirm it`,
        `${amt} ${chain.asset} أكثر من ${chain.amount} ${chain.asset} التي وافقت عليها، لذا يجب أن يؤكدها شخص`)]]};
    return {decision:"allow",reasons:[]};
  }

  const elsewhere=CHAINS.find(c=>c!==chain&&same(c,t,c.approved));
  if(elsewhere) return {decision:"deny",reasons:[["authorization-network",
    L(`that is the address you approved on ${elsewhere.name}. This transfer is on ${chain.name}, and an approval does not carry across networks`,
      `هذا هو العنوان الذي وافقت عليه على ${elsewhere.name}. هذا التحويل على ${chain.name}، والموافقة لا تنتقل بين الشبكات`)]]};

  if(looksLike(chain,t,chain.approved)) return {decision:"deny",reasons:[["destination-provenance",
    L("the first and last characters match the address you approved and the middle does not. Wallets abbreviate the middle; the comparison here is on the whole string",
      "الأحرف الأولى والأخيرة تطابق العنوان الذي وافقت عليه، أما الوسط فلا. تختصر المحافظ الوسط؛ والمقارنة هنا على العنوان كاملًا")]]};

  return {decision:"deny",reasons:[["destination-provenance",
    L("this address never appeared in anything you approved","لم يظهر هذا العنوان قط في أي شيء وافقت عليه")]]};
}

function drawChains(){
  $("#chains").innerHTML=CHAINS.map((c,i)=>
    `<button type="button" data-i="${i}" aria-pressed="${c===chain}">${esc(c.name)}</button>`).join("");
  for(const b of $("#chains").querySelectorAll("button"))
    b.addEventListener("click",()=>{chain=CHAINS[+b.dataset.i];drawChain()});
}
function drawChain(){
  for(const b of $("#chains").querySelectorAll("button"))
    b.setAttribute("aria-pressed",String(CHAINS[+b.dataset.i]===chain));
  $("#mandate").innerHTML=[
    [L("Payee","المستفيد"),esc(PAYEE)],
    [L("Network","الشبكة"),`${esc(chain.name)} <span class="dim mono">${esc(chain.id)}</span>`],
    [L("Amount","المبلغ"),`<span dir="ltr">${esc(chain.amount)} ${esc(chain.asset)}</span>`],
    [L("Address","العنوان"),`<span class="mono addr">${esc(chain.approved)}</span>`],
  ].map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("#to").value=chain.approved;
  $("#amt").value=chain.amount;
  $("#amt").removeAttribute("aria-invalid");
  $("#asset").innerHTML=MARK[chain.asset]+"<span class=\"dim\">"+chain.asset+"</span>";
  $("#asset").setAttribute("aria-label",chain.asset);
  $("#fills").innerHTML=[
    [L("The address you approved","العنوان الذي وافقت عليه"),chain.approved],
    [L("A poisoned lookalike","شبيه مسموم"),chain.poisoned],
    [L("Someone else entirely","شخص آخر تمامًا"),chain.other],
    [L("Another chain's address","عنوان من سلسلة أخرى"),CHAINS[(CHAINS.indexOf(chain)+1)%CHAINS.length].approved],
  ].map(([l,v])=>`<button type="button" class="chip" data-v="${esc(v)}">${esc(l)}</button>`).join("");
  for(const b of $("#fills").querySelectorAll(".chip"))
    b.addEventListener("click",()=>{$("#to").value=b.dataset.v;$("#to").focus()});
  sizeDeck();
}
$("#go").addEventListener("click",()=>{
  if(amountOf($("#amt"))===null){ $("#amt").focus(); return; }
  const to=$("#to").value.trim(), v=decide(to,$("#amt").value);
  verdict(row(v.decision,v.decision==="allow"?L("the wallet would be asked to sign","سيُطلب من المحفظة التوقيع")
      :L("no transaction exists","لا توجد معاملة"),L("simulated","محاكاة"))+
    `<div class="call mono">${esc(short(to))} <span class="dim">${L("on","على")} ${esc(chain.name)}</span></div>`+
    (v.reasons.length?why(v.reasons):`<p class="hint ok-line">${L("Every field matches what you approved, so there is nothing to refuse.",
      "كل حقل يطابق ما وافقت عليه، فلا شيء يُرفض.")}</p>`));
});


drawChains(); drawChain(); show(0);

// Everything above measured itself inside a hidden pane, where every height
// is zero. The deck gets its real height the first time the tab is opened.
addEventListener("moat:pane", (e) => { if (e.detail === "pane-playground") show(active); });

// And the tab may already be open before this file has loaded at all. The
// dashboard restores the pane from the URL at the end of its inline script,
// which is one line above the tag that fetches this one, so arriving straight
// at #pane-playground fired that event into a page with no listener yet and
// left the deck at the zero height it measured while hidden.
if (!$("#pane-playground").hidden) requestAnimationFrame(() => show(active));

})();
