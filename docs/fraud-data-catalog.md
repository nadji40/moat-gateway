# Fraud intelligence and dataset catalog

Snapshot: 2026-09-17

This catalog is a research and evaluation input for Moat. It is not a claim
that public data can reproduce a payment provider's private fraud signals.
Before redistributing any dataset, re-check its current licence and access
terms. Restricted or multi-gigabyte data must not be committed to this repo.

## What belongs inside Moat

Moat is strongest when it enforces a user's authority at the moment an agent
tries to move money. The primary decision should remain deterministic:

- exact recipient or verified recipient account;
- expected amount plus an explicit tolerance, distinct from a broad cap;
- currency, invoice, expiry, recurrence and maximum uses;
- proposal fingerprint bound to approval and resume;
- idempotency and provider reconciliation;
- provenance of every payment-critical field.

Behavioural and fraud models are secondary evidence. They can lower a
tolerance, require approval or deny a known-bad recipient, but they must not
silently expand the authority the user granted.

## Priority datasets and benchmarks

| Priority | Source | What it contains | Best Moat use | Access / limitation |
|---|---|---|---|---|
| P0 | [AgentDojo](https://agentdojo.spylab.ai/) | 97 realistic tasks and 629 security cases involving untrusted tool data | Import banking, shopping, travel and workspace injection patterns; add benign twins | Public benchmark; pin a version and re-check repository licence |
| P0 | [InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent) | 1,054 indirect-prompt-injection cases across 17 user tools and 62 attacker tools | Payload diversity, cross-tool attacks and exfiltration-plus-payment chains | Public research code/data; verify licence before redistribution |
| P0 | [Agent Security Bench](https://github.com/agiresearch/ASB) | Agent attacks and defenses across 10 scenarios, 400+ tools and multiple attack classes | Memory poisoning, observation poisoning, backdoors and mixed attacks | MIT repository; many cases are broader than payments |
| P0 | [ToolEmu](https://github.com/ryoungj/toolemu) | 144 high-stakes tool-use cases in 36 toolkits | Generate unsafe-action cases and legitimate controls without touching real rails | Apache-2.0 code; model-generated emulation is not real-world ground truth |
| P0 | [IBM AMLSim](https://github.com/IBM/AMLSim) | Generator for synthetic banking graphs with known laundering patterns | Velocity, fan-in/fan-out, cycles, scatter-gather and mule-network evidence | Apache-2.0 generator; synthetic distributions require calibration |
| P0 | [IBM AML-Data](https://github.com/IBM/AML-Data) | Synthetic transfers, purchases, card transactions and checks with laundering labels | Graph and sequence detector baselines | Data is CDLA-Sharing-1.0, not the repository's Apache licence |
| P0 | [SynthAML](https://doi.org/10.1038/s41597-023-02569-2) | Synthetic alerts and transaction histories derived from 20,000 real bank AML alerts | Alert-ranking and temporal-anomaly experiments | Open research data; transformed values and alert scope limit transfer |
| P0 | [FCA APP fraud synthetic dataset](https://www.fca.org.uk/publication/external-research/app-fraud-dataset-evaluation-report.pdf) | 15M transactions and 61,000 synthetic fraud attempts across impersonation, advance-fee, purchase, romance and investment scams | APP scam scenarios, payee novelty, confirmation-of-payee and susceptibility features | Available through the FCA sandbox under its access terms |
| P1 | [IEEE-CIS Fraud Detection](https://www.kaggle.com/c/ieee-fraud-detection/data) | 590k+ e-commerce transactions with transaction and identity features | Card-not-present behavioural baselines and leakage-resistant splits | 1.35 GB; subject to Kaggle competition rules; not vendorable |
| P1 | [ULB card fraud](https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud) | 284,807 anonymized card transactions, 492 fraud labels | Imbalance-aware metrics and calibration exercises | Only two days; PCA features hide operational meaning; Kaggle terms apply |
| P1 | [PaySim](https://www.sciencedirect.com/science/article/pii/S1877050916307969) | Synthetic mobile-money transfers derived from aggregate real patterns | Cash-out, transfer, balance and account-sequence experiments | Synthetic; obtain from its official distribution and verify licence |
| P1 | [BankSim paper](https://www.msc-les.org/proceedings/emss/2014/EMSS2014_144.pdf) | Synthetic bank-card transaction simulator with injected fraud patterns | Merchant/category novelty and short-burst spending tests | Synthetic and old; public copies have inconsistent terms |
| P1 | [Elliptic Bitcoin dataset](https://arxiv.org/abs/1908.02591) | 203,769 transaction nodes, directed flows and licit/illicit/unknown labels | Temporal graph features and funds-flow risk evidence | Crypto is not supplier invoicing; many labels are unknown |
| P1 | [LDBC FinBench](https://ldbcouncil.org/benchmarks/finbench/) | Financial graph generator, datasets and OLTP anti-fraud workload | Performance-test neighbourhood, account and transfer queries | Benchmark data, not fraud ground truth |
| P1 | [CFPB Consumer Complaint Database](https://www.consumerfinance.gov/data-research/consumer-complaints/) | Daily-updated complaints, products, issues, company responses and some narratives | Mine scam language and failure modes; create reviewed scenarios | Complaints are self-reported and not a representative statistical sample |
| P1 | [FTC Consumer Sentinel data](https://www.ftc.gov/reports/consumer-sentinel-network-data-book-2024) | Aggregated fraud, identity-theft, payment-method and contact-method statistics | Weight scenario prevalence and loss severity | Public CSV is aggregate; raw reports are restricted to law enforcement |
| P1 | [UK PSR APP fraud data](https://www.psr.org.uk/app-fraud-data/) | Sending/receiving PSP scam performance and reimbursement metrics | APP scam outcome benchmarks and receiving-account risk research | Aggregate performance data, not transaction-level training data |
| P1 | [TED open procurement data](https://data.ted.europa.eu/) | EU procurement notices as queryable open linked data | Supplier history, price distributions and procurement anomaly scenarios | Open but largely unlabeled; a red flag is not proof of fraud |
| P1 | [Open Contracting red flags](https://www.open-contracting.org/resources/red-flags-in-public-procurement-a-guide-to-using-data-to-detect-and-mitigate-risks/) | 73 reproducible procurement risk indicators mapped to OCDS | Build supplier/procurement evidence features and synthetic cases | Indicators identify risk, not adjudicated fraud |
| P1 | [World Bank debarred entities](https://projects.worldbank.org/en/projects-operations/procurement/debarred-firms) | Frequently updated sanctioned firms and grounds | Known-bad supplier evidence and entity-resolution tests | Scope is World Bank procurement; names need careful matching |
| P2 | [DocILE](https://docile.rossum.ai/) | 6,680 annotated and 100k synthetic invoices/orders plus unlabeled documents | Invoice extraction, line-item consistency and document-mutation tests | Research access request; it is not a fraud-labelled dataset |
| P2 | [SROIE](https://arxiv.org/abs/2103.10213) | 1,000 receipt images with OCR and key-information annotations | OCR robustness and amount/merchant extraction | Small, receipt-focused and not fraud-labelled |
| P2 | [Enron email corpus](https://www.cs.cmu.edu/~enron/) | Roughly 0.5M real organizational emails | Benign business-email background for vendor-change/BEC synthetic injections | Old, attachments absent, privacy/redaction history; no fraud labels |
| P2 | [CERT insider-threat dataset](https://www.sei.cmu.edu/library/insider-threat-test-dataset/) | Synthetic logon, device, file, email and malicious-insider scenarios | Compromised employee and approval-abuse scenarios | Large synthetic cybersecurity dataset, not payments ground truth |

## Authoritative case and typology sources

These are better for scenario design than model training:

- [FinCEN BEC advisory](https://www.fincen.gov/resources/statutes-regulations/guidance/advisory-financial-institutions-e-mail-compromise-fraud): executive impersonation, supplier bank-detail changes, lookalike domains, urgency, unusual beneficiary and immediate follow-on payments.
- [FBI IC3 BEC reporting](https://www.ic3.gov/PSA/2024/PSA240911): a high-loss real-world basis for supplier-invoice and account-change attacks.
- [FATF cyber-enabled fraud paper](https://www.fatf-gafi.org/en/publications/Methodsandtrends/cyber-enabled-fraud-digitalisation-ml-tf-pf-risks.html): scam proceeds, mule accounts, payment transparency and confirmation-of-payee controls.
- [Federal Reserve synthetic-identity material](https://fedpaymentsimprovement.org/strategic-initiatives/payments-security/synthetic-identity-payments-fraud/): fabricated identities and bust-out behaviour.
- [OWASP Agentic AI threats](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/): memory, tool, identity, privilege, delegation and multi-agent threats.
- [NIST agent hijacking evaluation](https://www.nist.gov/news-events/news/2025/01/technical-blog-strengthening-ai-agent-hijacking-evaluations): trusted-instruction versus untrusted-data separation.

## Standards Moat should test against

- [Google AP2 specification](https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md): checkout and payment mandates, signed authorization and disclosure flows.
- [Visa Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol/docs): agent identity, signed HTTP messages and intent validation.
- [Agentic Commerce Protocol payment spec](https://agentic-commerce-protocol.com/docs/commerce/specs/payment): delegated payment primitives and provider-independent checkout.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization): OAuth boundaries for remote tools. This authenticates access; it does not prove a payment matches user intent.

## Recommended acquisition order

1. Import AgentDojo, InjecAgent, ASB and ToolEmu *case definitions* into a
   quarantined research directory. Convert only reviewed payment-relevant
   cases into Moat's format and retain source/version/license metadata.
2. Add IBM AMLSim and SynthAML as reproducible data jobs outside the main git
   repository. Store hashes and generation parameters, not raw bulk files.
3. Apply for the FCA APP dataset; it is the best fit for scam-led authorized
   payments and confirmation-of-payee evidence.
4. Use CFPB, FinCEN, FBI, FATF, PSR and FTC material to maintain a scenario
   register reviewed by the research analyst. Do not treat allegations as
   verified labels.
5. Use DocILE/SROIE only for extraction and mutation robustness. Generate
   paired clean/tampered invoices so ground truth is exact.
6. Add card and crypto datasets only when Moat has a behavioural-risk layer;
   they should not distract from mandate enforcement first.

## Evaluation rules

- Every attack needs a legitimate twin and an exact expected economic result.
- Split data by time/entity, never random-row only, to reduce leakage.
- Report attack success, legitimate completion, approval precision/recall,
  false approval rate, duplicate execution, reconciliation rate and latency.
- Use confidence intervals across repeated model runs. A single model run is
  an anecdote, not a stable benchmark.
- Keep public datasets, synthetic data and real provider sandbox outcomes as
  separate strata in every report.
- Never train on the test attack wording; hold out attack families and sources.
- Preserve source URL, version/commit, licence, hash and transformation log.

## Important boundary

No public dataset provides a complete, current view of real payment fraud.
Provider data is private, labels arrive late, attackers adapt, and synthetic
data often leaks generator rules. Public data can strengthen Moat's attack
coverage and evidence models; it cannot honestly validate production fraud
loss reduction without a provider or design-partner pilot.
