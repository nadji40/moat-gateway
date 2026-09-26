"""Rescore saved results with Moat's own number rule.

Moat compares amounts after converting Arabic-Indic digits to ASCII and
removing thousands grouping, so "٤٨٠" and "480" are one value, and so are
"1,250.00" and "1250.00". A model that returns the normalised form has not
invented anything. A name must still be a literal substring.
"""
import glob
import json
import re
import unicodedata

from llm_eval import CASES

AR = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫٬", "01234567890123456789.,")


def number(s):
    """Canonical value of an amount string, or None. Mirrors normalize_number."""
    if not s:
        return None
    s = s.translate(AR).strip()
    s = re.sub(r"[^\d.,']", "", s)
    if not s:
        return None
    if re.fullmatch(r"\d{1,3}(\.\d{3})+,\d+", s):      # 1.500,00
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d+,\d{1,2}", s):               # 480,00
        s = s.replace(",", ".")
    else:                                               # 1,250.00 and 1'500
        s = s.replace(",", "").replace("'", "")
    try:
        v = float(s)
    except ValueError:
        return None
    return f"{v:.6f}".rstrip("0").rstrip(".")


def numbers_in(text):
    return {number(m) for m in re.findall(r"[\d٠-٩۰-۹][\d٠-٩۰-۹.,٫٬']*", text)} - {None}


def main():
    by_id = {c[0]: c for c in CASES}
    for path in sorted(glob.glob("D:/moat-ml/llm_results_*.json")):
        data = json.load(open(path, encoding="utf-8"))
        rows = data["rows"]
        names_bad = amount_invented = amount_wrong = paid_nothing_wrong = 0
        for r in rows:
            cid, lang, text, pay, refused, amount, cur, refs = by_id[r["id"]]
            got = r["got"]
            t = unicodedata.normalize("NFKC", text)
            for n in (got.get("pay") or []) + (got.get("refused") or []):
                if unicodedata.normalize("NFKC", n) not in t:
                    names_bad += 1
            a = got.get("amount")
            if a and number(a) not in numbers_in(text):
                amount_invented += 1
            # Only an amount attached to a payment matters.
            if pay and number(a) != number(amount):
                amount_wrong += 1
        s = data["summary"]
        print(f'{s["model"]:12} fail-open {s["fail_open"]}  payee {s["pay_ok"]}/36  refused {s["refused_ok"]}/36  '
              f'amount-for-payment wrong {amount_wrong}  amount invented {amount_invented}  '
              f'name not verbatim {names_bad}  currency {s["currency_ok"]}/36  median {s["s_median"]}s')


if __name__ == "__main__":
    main()
