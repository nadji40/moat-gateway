"""Evaluate GLiNER models as Moat's span-locating intent reader.

What Moat needs from a span reader, in order of importance:
  1. The payee to pay, as an exact span of the user's text.
  2. The amount, as an exact span, and never a reference number instead.
  3. Some way to tell a payee the user refused from one they asked for.
It must never invent text: every returned span is checked against the input.
"""
import json
import os
import sys
import time
import unicodedata

import re

from gliner import GLiNER

# Chinese, Japanese and Korean are written without spaces, so GLiNER's
# whitespace rule turns a whole sentence into one word. Here every CJK
# character is its own token, and every other script keeps GLiNER's rule.
CJK = "぀-ヿ㐀-䶿一-鿿가-힯豈-﫿"
SCRIPT_AWARE = re.compile(
    rf"[{CJK}]|(?:(?![{CJK}])\w)+(?:[-_](?:(?![{CJK}])\w)+)*|\S"
)


class ScriptAwareSplitter:
    def __call__(self, text):
        for m in SCRIPT_AWARE.finditer(text):
            yield m.group(), m.start(), m.end()

# (id, lang, text, pay, refused, amount, references)
#   pay        the payee the user asked to pay (exact span), or None
#   refused    a payee the user said NOT to pay, or None
#   amount     the amount span, or None
#   references spans that are numbers but not prices
CASES = [
    ("en-1", "en", "Pay Orbit Labs Srl 480 USD for invoice INV-100", "Orbit Labs Srl", None, "480", ["INV-100"]),
    ("en-2", "en", "Don't pay Orbit Labs Srl, it is a scam. Pay Vega Cloud Ltd 480 USD instead.", "Vega Cloud Ltd", "Orbit Labs Srl", "480", []),
    ("en-3", "en", "Please send $1,250.00 to Northwind Traders for order 4471", "Northwind Traders", None, "1,250.00", ["4471"]),
    ("en-4", "en", "Pay Monitoring Pro Inc for ticket 88, the amount is 45 dollars", "Monitoring Pro Inc", None, "45", ["88"]),
    ("en-5", "en", "Transfer 300 GBP to Sarah Johnson for the flat deposit", "Sarah Johnson", None, "300", []),
    ("ar-1", "ar", "ادفع 480 ريال إلى شركة أوربت لابس للفاتورة رقم 100", "شركة أوربت لابس", None, "480", ["100"]),
    ("ar-2", "ar", "لا تدفع لشركة الأفق الرقمي، ادفع لمؤسسة عسير للحلول السحابية ٤٨٠ ريال", "مؤسسة عسير للحلول السحابية", "شركة الأفق الرقمي", "٤٨٠", []),
    ("ar-3", "ar", "حول ٢٥٠٠ درهم إلى أحمد المنصوري", "أحمد المنصوري", None, "٢٥٠٠", []),
    ("ar-4", "ar", "ادفع 480 ريال إلى Orbit Labs Srl", "Orbit Labs Srl", None, "480", []),
    ("it-1", "it", "Paga 480,00 € a Orbit Labs Srl per la fattura 2024-17", "Orbit Labs Srl", None, "480,00", ["2024-17"]),
    ("it-2", "it", "Non pagare Orbit Labs Srl, è una truffa. Paga 480 euro a Vega Cloud Srl.", "Vega Cloud Srl", "Orbit Labs Srl", "480", []),
    ("it-3", "it", "Bonifica 1.500,00 euro a Marco Rossi", "Marco Rossi", None, "1.500,00", []),
    ("de-1", "de", "Zahle 480 EUR an Orbit Labs GmbH für Rechnung 7731", "Orbit Labs GmbH", None, "480", ["7731"]),
    ("de-2", "de", "Zahle nicht an Orbit Labs GmbH, sondern 480 EUR an Vega Cloud GmbH", "Vega Cloud GmbH", "Orbit Labs GmbH", "480", []),
    ("fr-1", "fr", "Paie 480 € à Orbit Labs SAS pour la facture 55", "Orbit Labs SAS", None, "480", ["55"]),
    ("fr-2", "fr", "Ne paie pas Orbit Labs SAS, paie 480 € à Vega Cloud SAS", "Vega Cloud SAS", "Orbit Labs SAS", "480", []),
    ("es-1", "es", "Paga 480 USD a Orbit Labs SL por el pedido 9021", "Orbit Labs SL", None, "480", ["9021"]),
    ("es-2", "es", "No pagues a Orbit Labs SL, paga 480 USD a Vega Cloud SL", "Vega Cloud SL", "Orbit Labs SL", "480", []),
    ("pt-1", "pt", "Não pague a Orbit Labs Ltda, pague 480 USD à Vega Cloud Ltda", "Vega Cloud Ltda", "Orbit Labs Ltda", "480", []),
    ("ru-1", "ru", "Не плати ООО Орбита, заплати ООО Вега 480 долларов", "ООО Вега", "ООО Орбита", "480", []),
    ("tr-1", "tr", "Orbit Labs AŞ'ye 480 USD öde", "Orbit Labs AŞ", None, "480", []),
    ("zh-1", "zh", "请向轨道实验室支付480美元，发票号INV-100", "轨道实验室", None, "480", ["INV-100"]),
    ("zh-2", "zh", "不要付款给轨道实验室，付480美元给织女云", "织女云", "轨道实验室", "480", []),
    ("zh-3", "zh", "请向Orbit Labs Srl支付480美元", "Orbit Labs Srl", None, "480", []),
    ("ja-1", "ja", "Orbit Labs株式会社に480ドル支払ってください", "Orbit Labs株式会社", None, "480", []),
    ("hi-1", "hi", "Orbit Labs Srl को 480 डॉलर दो", "Orbit Labs Srl", None, "480", []),
]

LABEL_SETS = {
    # Generic NER vocabulary the models were trained on.
    "generic": ["organization", "person", "money", "reference number"],
    # Task vocabulary: can the label itself carry the refusal?
    "task": ["recipient to pay", "recipient not to pay", "amount of money", "invoice or order number"],
}

PAYEE_LABELS = {"organization", "person", "recipient to pay"}
REFUSED_LABELS = {"recipient not to pay"}
AMOUNT_LABELS = {"money", "amount of money"}


def norm(s):
    return unicodedata.normalize("NFKC", s).strip().strip(".,،:;").casefold()


def amount_core(s):
    """Money spans often include the currency; keep only the number part."""
    digits = "".join(ch for ch in s if ch.isdigit() or ch in ".,٫٬")
    return digits


def run(model_id, threshold, splitter):
    if splitter == "script":
        # Models configured for Stanza build it on load, which downloads a
        # pipeline per language. Substitute the script-aware splitter instead.
        import gliner.data_processing.tokenizer as tok
        tok.StanzaWordsSplitter = lambda *a, **k: ScriptAwareSplitter()
    t0 = time.time()
    model = GLiNER.from_pretrained(model_id)
    load_s = time.time() - t0
    if splitter == "script":
        model.data_processor.words_splitter = ScriptAwareSplitter()
    results = {"model": model_id, "threshold": threshold, "splitter": splitter,
               "load_s": round(load_s, 1), "sets": {}}
    for set_name, labels in LABEL_SETS.items():
        rows, latencies = [], []
        for cid, lang, text, pay, refused, amount, refs in CASES:
            t = time.time()
            ents = model.predict_entities(text, labels, threshold=threshold)
            latencies.append(time.time() - t)
            # Grounding: every span must be a literal substring at its offsets.
            grounded = all(text[e["start"]:e["end"]] == e["text"] for e in ents)
            payees = [e for e in ents if e["label"] in PAYEE_LABELS]
            refusals = [e for e in ents if e["label"] in REFUSED_LABELS]
            amounts = [e for e in ents if e["label"] in AMOUNT_LABELS]
            payee_texts = [norm(e["text"]) for e in payees]
            amount_cores = [amount_core(e["text"]) for e in amounts]
            row = {
                "id": cid, "lang": lang, "grounded": grounded,
                "payee_exact": pay is not None and norm(pay) in payee_texts,
                "payee_partial": pay is not None and any(norm(pay) in p or p in norm(pay) for p in payee_texts if p),
                # The refused payee must not come back labelled as someone to pay.
                "refused_leak": refused is not None and set_name == "task" and any(
                    norm(refused) == p for p in [norm(e["text"]) for e in payees]),
                "refused_found": refused is not None and set_name == "task" and any(
                    norm(refused) == norm(e["text"]) for e in refusals),
                "amount_exact": amount is not None and amount_core(amount) in amount_cores,
                "ref_as_amount": any(amount_core(r) and amount_core(r) in amount_cores for r in refs),
                "entities": [(e["label"], e["text"], round(e["score"], 2)) for e in ents],
            }
            rows.append(row)
        n = len(rows)
        with_refused = [r for r in rows if any(c[0] == r["id"] and c[4] for c in CASES)]
        summary = {
            "cases": n,
            "grounded": sum(r["grounded"] for r in rows),
            "payee_exact": sum(r["payee_exact"] for r in rows),
            "payee_partial": sum(r["payee_partial"] for r in rows),
            "amount_exact": sum(r["amount_exact"] for r in rows),
            "ref_as_amount": sum(r["ref_as_amount"] for r in rows),
            "refused_cases": len(with_refused),
            "refused_leak": sum(r["refused_leak"] for r in with_refused),
            "refused_found": sum(r["refused_found"] for r in with_refused),
            "ms_median": round(sorted(latencies)[n // 2] * 1000),
            "ms_max": round(max(latencies) * 1000),
        }
        results["sets"][set_name] = {"summary": summary, "rows": rows}
    return results


if __name__ == "__main__":
    model_id = sys.argv[1]
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0.4
    splitter = sys.argv[3] if len(sys.argv) > 3 else "default"
    out = run(model_id, threshold, splitter)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        f"results_{model_id.replace('/', '__')}_{splitter}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps({"model": out["model"], "splitter": splitter, "load_s": out["load_s"],
                      **{k: v["summary"] for k, v in out["sets"].items()}}, ensure_ascii=False, indent=1))
