"""Mutation check for Adjudex: break each protective rule in a scratch copy
and prove the direct suite FAILS. A mutation that survives is an unpinned
rule. Includes a CONTROL (no mutation) that must stay green."""

import pathlib
import shutil
import subprocess
import sys

SRC = pathlib.Path(r"C:/Users/Pc/Desktop/Adjudex")
WORK = pathlib.Path(__file__).parent / "work"

MUTATIONS = [
    ("CONTROL (no mutation — must PASS)", None, None),

    # ── money movement ───────────────────────────────────────────────────
    ("S23: open_case stops debiting the free reserve",
     "        ag.reserve_free = u256(int(ag.reserve_free) - credit)\n"
     "        ag.reserve_held = u256(int(ag.reserve_held) + credit)",
     "        ag.reserve_held = u256(int(ag.reserve_held) + credit)"),

    ("open_case stops checking solvency",
     "        if int(ag.reserve_free) < credit:",
     "        if False and int(ag.reserve_free) < credit:"),

    ("settle pays the client even on NOT_BREACHED",
     "        if cs.verdict == \"BREACHED\":\n"
     "            self._credit(ag.client, held)",
     "        if cs.verdict in (\"BREACHED\", \"NOT_BREACHED\"):\n"
     "            self._credit(ag.client, held)"),

    ("settle stops releasing reserve_held",
     "        ag.reserve_held = u256(int(ag.reserve_held) - held)\n"
     "        ag.open_cases = u256(int(ag.open_cases) - 1)\n"
     "        if cs.verdict == \"BREACHED\":",
     "        ag.open_cases = u256(int(ag.open_cases) - 1)\n"
     "        if cs.verdict == \"BREACHED\":"),

    ("claim stops zeroing the ledger before transfer",
     "        self.claimable[sender] = u256(0)\n"
     "        self.escrow_atto = u256(int(self.escrow_atto) - amount)",
     "        self.escrow_atto = u256(int(self.escrow_atto) - amount)"),

    ("claim stops decrementing escrow",
     "        self.claimable[sender] = u256(0)\n"
     "        self.escrow_atto = u256(int(self.escrow_atto) - amount)",
     "        self.claimable[sender] = u256(0)"),

    ("withdraw stops releasing the reservation",
     "        self._release_reservation(cs, ag)\n"
     "        cs.status = \"WITHDRAWN\"\n"
     "        cs.withdrawn_epoch = u256(self._require_clock())\n"
     "        return \"withdrawn\"",
     "        cs.status = \"WITHDRAWN\"\n"
     "        cs.withdrawn_epoch = u256(self._require_clock())\n"
     "        return \"withdrawn\""),

    # ── the derivation (the heart) ───────────────────────────────────────
    ("S34: the authenticity floor stops holding uncorroborated breaches",
     "        if corroboration == \"NONE\":\n"
     "            return \"REVIEW_REQUIRED\", 0",
     "        if False:\n"
     "            return \"REVIEW_REQUIRED\", 0"),

    ("corroboration stops seeing verified anchors",
     "        if r.get(\"anchor_state\") == \"VERIFIED\":\n"
     "            independent = True",
     "        if False:\n"
     "            independent = True"),

    ("corroboration stops requiring client rows",
     "        if not isinstance(r, dict) or r.get(\"submitter\") != \"client\":\n"
     "            continue",
     "        if not isinstance(r, dict):\n"
     "            continue"),

    # Corroboration is guarded twice (direct comparison + recheck from the
    # leader's own rows), and the row facts feeding it are guarded twice
    # (row comparison + the recheck deriving from those rows). Single-layer
    # mutants of any one guard are EQUIVALENT — the sibling layer catches
    # the same forgery — so each pair is mutated together (the dual-layer
    # convention this sweep already uses for judge+validator pairs).
    ("validator loses BOTH corroboration layers (compare + recheck)",
     "MULTI",
     [("            if mine[\"corroboration\"] != theirs.get(\"corroboration\"):\n"
       "                return False",
       "            if False:\n"
       "                return False"),
      ("            t_corr = _derive_corroboration(t_rows)\n"
       "            if t_corr != theirs.get(\"corroboration\"):\n"
       "                return False",
       "            t_corr = str(theirs.get(\"corroboration\"))")]),

    ("validator loses BOTH anchor layers (row compare + recheck)",
     "MULTI",
     [("                if me[\"anchor_state\"] != them.get(\"anchor_state\"):\n"
       "                    return False",
       "                if False:\n"
       "                    return False"),
      ("            t_corr = _derive_corroboration(t_rows)\n"
       "            if t_corr != theirs.get(\"corroboration\"):\n"
       "                return False",
       "            t_corr = str(theirs.get(\"corroboration\"))")]),

    ("anchor verification treats a null receipt as verified",
     "        if receipt is None or not isinstance(receipt, dict):\n"
     "            return (\"NOT_FOUND\", 0)",
     "        if receipt is None or not isinstance(receipt, dict):\n"
     "            return (\"VERIFIED\", 0)"),

    ("anchor intake stops validating the chain name",
     "                if anchor_chain not in ANCHOR_CHAINS:",
     "                if False and anchor_chain not in ANCHOR_CHAINS:"),

    ("S22: sufficiency stops gating the verdict",
     "    if evidence_flag != \"SUFFICIENT\":\n"
     "        return \"REVIEW_REQUIRED\", 0",
     "    if False:\n"
     "        return \"REVIEW_REQUIRED\", 0"),

    ("two hard conflicts stop forcing review",
     "    if len(hard_conflicts) >= 2:\n"
     "        return \"REVIEW_REQUIRED\", 0",
     "    if len(hard_conflicts) >= 99:\n"
     "        return \"REVIEW_REQUIRED\", 0"),

    ("zero eligible stops forcing review",
     "    if eligible <= 0:\n"
     "        return \"REVIEW_REQUIRED\", 0",
     "    if eligible < 0:\n"
     "        return \"REVIEW_REQUIRED\", 0"),

    ("threshold comparison flips to <=",
     "    if rate_bps < threshold_bps:\n"
     "        if corroboration == \"NONE\":",
     "    if rate_bps <= threshold_bps:\n"
     "        if corroboration == \"NONE\":"),

    ("excused items stop reducing lateness",
     "    excused_total = sum(int(excused.get(c, 0)) for c in EXCUSE_CATEGORIES)",
     "    excused_total = 0 * sum(int(excused.get(c, 0)) for c in EXCUSE_CATEGORIES)"),

    # ── boundary validation (S16) ────────────────────────────────────────
    ("late may exceed eligible (both layers)",
     "MULTI", [
         ("            if not (0 <= late <= eligible):",
          "            if not (0 <= late):"),
         ("            if not (0 <= t_late <= t_eligible):",
          "            if not (0 <= t_late):"),
     ]),

    ("excused may exceed late (both layers)",
     "MULTI", [
         ("            if sum(excused.values()) > late:",
          "            if False and sum(excused.values()) > late:"),
         ("            if sum(t_excused.values()) > t_late:",
          "            if False and sum(t_excused.values()) > t_late:"),
     ]),

    ("evidence flag enum check dropped",
     "            if evidence_flag not in EVIDENCE_FLAGS:",
     "            if False and evidence_flag not in EVIDENCE_FLAGS:"),

    ("zero-eligible-SUFFICIENT inconsistency allowed",
     "            if eligible == 0 and evidence_flag == \"SUFFICIENT\":",
     "            if False and eligible == 0 and evidence_flag == \"SUFFICIENT\":"),

    # ── windows and gates ────────────────────────────────────────────────
    ("S2: the response window stops gating adjudication",
     "        if now <= int(cs.last_commit_epoch) + int(ag.response_window):",
     "        if False and now <= int(cs.last_commit_epoch) + int(ag.response_window):"),

    ("re-roll of a judged version allowed",
     "        if self.assessments.get(f\"{cs.case_id}|{version}\") is not None:",
     "        if False and self.assessments.get(f\"{cs.case_id}|{version}\") is not None:"),

    ("promote stops waiting for the finality window",
     "        if now <= int(cs.pending_until_epoch):",
     "        if False and now <= int(cs.pending_until_epoch):"),

    ("S22 defense-in-depth at promote dropped",
     "        if dossier.get(\"evidence_flag\") != \"SUFFICIENT\" and verdict != \"REVIEW_REQUIRED\":\n"
     "            verdict = \"REVIEW_REQUIRED\"",
     "        if False:\n"
     "            verdict = \"REVIEW_REQUIRED\""),

    ("settle stops waiting for the challenge window",
     "        if now <= int(cs.challenge_until_epoch):\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} the challenge window is still open\")",
     "        if False:\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} the challenge window is still open\")"),

    ("settle runs twice",
     "        if cs.status != \"FINAL\":\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} nothing to settle in {cs.status}\")",
     "        if cs.status not in (\"FINAL\", \"SETTLED\"):\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} nothing to settle in {cs.status}\")"),

    ("close-out notice window dropped",
     "        if now <= int(ag.closing_epoch) + int(ag.notice_window):",
     "        if False and now <= int(ag.closing_epoch) + int(ag.notice_window):"),

    ("close-out stops waiting for open cases",
     "        if int(ag.open_cases) != 0:",
     "        if False and int(ag.open_cases) != 0:"),

    ("abandon window dropped",
     "        if now <= int(cs.last_commit_epoch) + ABANDON_SECONDS:",
     "        if False and now <= int(cs.last_commit_epoch) + ABANDON_SECONDS:"),

    # ── challenge economics ──────────────────────────────────────────────
    ("challenge bond becomes at-least instead of exact",
     "        if self._value() != bond:",
     "        if self._value() < bond:"),

    ("challenge window stops closing",
     "        if now > int(cs.challenge_until_epoch):\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} the challenge window has passed\")",
     "        if False:\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} the challenge window has passed\")"),

    ("bond routing flips: unchanged verdict pays the challenger",
     "        if changed:\n"
     "            self._credit(cs.challenger, bond)\n"
     "        else:\n"
     "            other = ag.provider if cs.challenger == ag.client else ag.client\n"
     "            self._credit(other, bond)",
     "        self._credit(cs.challenger, bond)"),

    # NOTE: mutating the status/verdict restore alone is an EQUIVALENT mutant
    # (only a FINAL case can file a challenge, and nothing rewrites the
    # verdict while one is open) — the restore is pinned through the fields
    # a challenge actually drifts: the appended evidence version.
    ("S29: lapse keeps the challenge's appended evidence version",
     "        cs.evidence_version = u256(_as_int(snap.get(\"evidence_version\"),\n"
     "                                           int(cs.evidence_version)))\n"
     "        cs.evidence_root = snap.get(\"evidence_root\", cs.evidence_root)\n"
     "        cs.item_count = u256(_as_int(snap.get(\"item_count\"), int(cs.item_count)))",
     "        pass"),

    ("version cap dropped",
     "        if version > MAX_VERSIONS:",
     "        if False and version > MAX_VERSIONS:"),

    # ── validator comparison ─────────────────────────────────────────────
    ("validator stops comparing the derived verdict",
     "            if mine[\"verdict\"] != theirs.get(\"verdict\"):\n"
     "                return False",
     "            if False:\n"
     "                return False"),

    ("validator stops re-deriving the leader's arithmetic",
     "            re_verdict, re_rate = _derive_verdict(\n"
     "                t_eligible, t_late, t_excused, t_flag, t_hard, threshold_bps,\n"
     "                t_corr)\n"
     "            if re_verdict != theirs.get(\"verdict\"):\n"
     "                return False\n"
     "            if re_rate != _as_int(theirs.get(\"rate_bps\"), -1):\n"
     "                return False",
     "            re_verdict, re_rate = _derive_verdict(\n"
     "                t_eligible, t_late, t_excused, t_flag, t_hard, threshold_bps,\n"
     "                t_corr)"),

    ("validator stops comparing the hard-conflict set",
     "            if mine[\"hard_conflicts\"] != theirs.get(\"hard_conflicts\"):\n"
     "                return False",
     "            if False:\n"
     "                return False"),

    ("validator widens the rate bucket to any distance",
     "            if abs(my_rb - their_rb) > 1:\n"
     "                return False",
     "            if abs(my_rb - their_rb) > 999:\n"
     "                return False"),

    ("validator stops checking row digests (S21)",
     "                if _sha256_hex(me[\"excerpt\"]) != them.get(\"digest\"):\n"
     "                    return False",
     "                if False:\n"
     "                    return False"),

    ("validator stops comparing row bytes",
     "                if them.get(\"excerpt\") != me[\"excerpt\"]:\n"
     "                    return False",
     "                if False:\n"
     "                    return False"),

    ("validator loses BOTH ack layers (row compare + recheck)",
     "MULTI",
     [("                if me[\"ack\"] != them.get(\"ack\"):\n"
       "                    return False",
       "                if False:\n"
       "                    return False"),
      ("            t_corr = _derive_corroboration(t_rows)\n"
       "            if t_corr != theirs.get(\"corroboration\"):\n"
       "                return False",
       "            t_corr = str(theirs.get(\"corroboration\"))")]),

    # ── sanitation / roles ───────────────────────────────────────────────
    ("S19: the defang sanitizer goes half (opener only)",
     "    return str(s or \"\").replace(\"<<<\", \"\u2039\u2039\u2039\").replace(\">>>\", \"\u203a\u203a\u203a\")",
     "    return str(s or \"\").replace(\"<<<\", \"\u2039\u2039\u2039\")"),

    ("provider may commit non-response kinds",
     "            if submitter_role == \"provider\" and kind != \"response\":",
     "            if False and submitter_role == \"provider\" and kind != \"response\":"),

    ("stranger may open cases",
     "        if self._sender() != ag.client:\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} only the client opens cases\")",
     "        if False:\n"
     "            raise gl.vm.UserError(f\"{ERROR_EXPECTED} only the client opens cases\")"),

    ("provider self-review of its own items allowed",
     "        if target[\"submitter\"] != \"client\":",
     "        if False and target[\"submitter\"] != \"client\":"),
]


def run_suite() -> bool:
    r = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/direct", "-q", "-x"],
        cwd=WORK, capture_output=True, text=True)
    return r.returncode == 0


def main():
    contract_rel = pathlib.Path("contracts") / "adjudex.py"
    original = (SRC / contract_rel).read_text(encoding="utf-8")

    killed, survived, missing = [], [], []
    for name, old, new in MUTATIONS:
        if WORK.exists():
            shutil.rmtree(WORK)
        shutil.copytree(SRC / "contracts", WORK / "contracts",
                        ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(SRC / "tests", WORK / "tests",
                        ignore=shutil.ignore_patterns("work", "__pycache__"))

        text = original
        if old == "MULTI":
            bad = [o for o, n in new if o not in text]
            if bad:
                print(f"ANCHOR MISSING  {name}")
                missing.append(name)
                continue
            for o, n in new:
                text = text.replace(o, n, 1)
        elif old is not None:
            if old not in text:
                print(f"ANCHOR MISSING  {name}")
                missing.append(name)
                continue
            text = text.replace(old, new, 1)
        (WORK / contract_rel).write_bytes(text.encode("utf-8"))

        green = run_suite()
        if old is None:
            status = "CONTROL PASS" if green else "CONTROL **FAILED**"
            print(f"{status:18} {name}")
            if not green:
                missing.append("CONTROL")
        elif green:
            print(f"SURVIVED **      {name}")
            survived.append(name)
        else:
            print(f"killed           {name}")
            killed.append(name)

    print()
    print(f"killed {len(killed)} / survived {len(survived)} / anchor-missing {len(missing)}")
    if survived:
        print("UNPINNED RULES:")
        for s in survived:
            print("  -", s)


if __name__ == "__main__":
    main()
