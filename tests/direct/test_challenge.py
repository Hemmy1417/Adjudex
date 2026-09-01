"""The bonded challenge: exact bond, the S29 snapshot, deterministic bond
routing at re-adjudication, and the stale-challenge unilateral exit."""

import json

import pytest

from conftest import (PROVIDER, CLIENT, STRANGER, CREDIT, BOND, W, as_,
                      advance, conserve, final, err, panel_says,
                      sla_answer, log_item)


def challenge_items():
    return [{"kind": "response", "label": "Gateway telemetry",
             "content": "GATEWAY TELEMETRY EXPORT. Independent timing export "
                        "for period 2026-08 showing seven of the flagged "
                        "transactions completed inside 30 minutes at the "
                        "settlement leg."}]


def filed(module, c, by=PROVIDER, **kw):
    aid, cid = final(module, c, **kw)
    as_(module, by, BOND)
    c.challenge(cid, "the timing basis in the log is contradicted by the "
                     "gateway's own telemetry export", json.dumps(
        challenge_items() if by == PROVIDER else [log_item("More records")]))
    return aid, cid


def test_challenge_takes_an_exact_bond_and_new_material(module, c):
    aid, cid = filed(module, c)
    cs = json.loads(c.get_case(cid))
    assert cs["challenge_open"] is True
    assert cs["challenger"] == PROVIDER
    assert cs["evidence_version"] == 2
    assert cs["challenge_new_version"] == 2
    assert cs["challenged_version"] == 1
    conserve(module, c)


def test_challenge_refuses_a_wrong_bond(module, c):
    aid, cid = final(module, c)
    as_(module, PROVIDER, BOND - 1)
    with pytest.raises(err(module), match="bond is exactly"):
        c.challenge(cid, "the record is wrong for reasons stated here",
                    json.dumps(challenge_items()))


def test_challenge_is_party_only_within_the_window(module, c):
    aid, cid = final(module, c)
    as_(module, STRANGER, BOND)
    with pytest.raises(err(module), match="only a party"):
        c.challenge(cid, "a stranger with an opinion and a bond attached",
                    json.dumps(challenge_items()))
    advance(W + 1)
    as_(module, PROVIDER, BOND)
    with pytest.raises(err(module), match="window has passed"):
        c.challenge(cid, "filed after the challenge window has already run out",
                    json.dumps(challenge_items()))


def test_challenge_blocks_settlement_until_resolved(module, c):
    aid, cid = filed(module, c)
    advance(W + 1)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="challenge is open"):
        c.settle(cid)


def test_re_adjudication_changed_verdict_returns_the_bond(module, c):
    aid, cid = filed(module, c)
    # the second panel reads the telemetry as excusing enough items
    panel_says(sla_answer(compliance=4, infrastructure=2))   # 9600 NOT_BREACHED
    as_(module, STRANGER, 0)
    out = json.loads(c.re_adjudicate(cid))
    assert out == {"verdict": "NOT_BREACHED", "bond_returned": True}
    assert c.get_claimable(PROVIDER) == str(BOND)
    cs = json.loads(c.get_case(cid))
    assert cs["status"] == "PENDING_FINALITY"
    assert cs["challenge_open"] is False
    conserve(module, c)
    # the new verdict promotes and settles like any other
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.promote(cid)
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.settle(cid)
    assert json.loads(c.get_case(cid))["verdict"] == "NOT_BREACHED"


def test_re_adjudication_unchanged_verdict_pays_the_other_party(module, c):
    aid, cid = filed(module, c)          # provider challenges a BREACHED
    panel_says(sla_answer())             # the re-read agrees: BREACHED
    as_(module, STRANGER, 0)
    out = json.loads(c.re_adjudicate(cid))
    assert out["bond_returned"] is False
    assert c.get_claimable(CLIENT) == str(BOND)
    conserve(module, c)


def test_re_adjudicate_requires_an_open_challenge(module, c):
    aid, cid = final(module, c)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="no challenge is open"):
        c.re_adjudicate(cid)


def test_lapse_restores_the_snapshot_exactly(module, c):
    """S29: the state restored is the state APPEALED — verdict, windows,
    evidence version — not whatever drifted since; the bond goes home."""
    aid, cid = filed(module, c)
    before = json.loads(c.get_case(cid))
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="stale window"):
        c.lapse_challenge(cid)
    advance(3_601)
    as_(module, CLIENT, 0)
    c.lapse_challenge(cid)
    cs = json.loads(c.get_case(cid))
    assert cs["status"] == "FINAL"
    assert cs["verdict"] == "BREACHED"
    assert cs["rate_bps"] == 9_300
    assert cs["evidence_version"] == 1          # the appended version is orphaned
    assert cs["item_count"] == 3
    assert cs["challenge_open"] is False
    assert cs["challenge_until_epoch"] == before["challenge_until_epoch"]
    assert c.get_claimable(PROVIDER) == str(BOND)
    conserve(module, c)
    # the restored FINAL settles normally (its window has long passed)
    as_(module, STRANGER, 0)
    c.settle(cid)
    assert json.loads(c.get_case(cid))["status"] == "SETTLED"


def test_second_challenge_after_a_new_final(module, c):
    aid, cid = filed(module, c)
    panel_says(sla_answer(compliance=4, infrastructure=2))
    as_(module, STRANGER, 0)
    c.re_adjudicate(cid)
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.promote(cid)                      # NOT_BREACHED, fresh challenge window
    as_(module, CLIENT, BOND)
    c.challenge(cid, "the telemetry export is not the provider's system of "
                     "record and contradicts the notified incident scope",
                json.dumps([log_item("Rebuttal records")]))
    cs = json.loads(c.get_case(cid))
    assert cs["challenge_open"] is True
    assert cs["evidence_version"] == 3
    conserve(module, c)


def test_version_cap_ends_the_ping_pong(module, c):
    aid, cid = final(module, c)
    for n in range(2, 7):               # versions 2..6 fill the cap
        as_(module, PROVIDER, BOND)
        c.challenge(cid, f"round {n}: the record remains wrong as argued",
                    json.dumps(challenge_items()))
        panel_says(sla_answer())        # unchanged: BREACHED every time
        as_(module, STRANGER, 0)
        c.re_adjudicate(cid)
        advance(W + 1)
        as_(module, STRANGER, 0)
        c.promote(cid)
    as_(module, PROVIDER, BOND)
    with pytest.raises(err(module), match="at most 6 versions"):
        c.challenge(cid, "a seventh round the record cannot hold anymore",
                    json.dumps(challenge_items()))
    conserve(module, c)


def test_challenge_after_settlement_refused(module, c):
    from conftest import settled
    aid, cid = settled(module, c)
    as_(module, PROVIDER, BOND)
    with pytest.raises(err(module), match="nothing challengeable"):
        c.challenge(cid, "post-terminal challenges must bounce off (S30)",
                    json.dumps(challenge_items()))


def test_challenge_refuses_an_overpaid_bond(module, c):
    """The bond is EXACT in both directions — an overpay would strand the
    difference in escrow with no ledger row to claim it back."""
    aid, cid = final(module, c)
    as_(module, PROVIDER, BOND + 1)
    with pytest.raises(err(module), match="bond is exactly"):
        c.challenge(cid, "an overpaid bond must bounce, not strand value",
                    json.dumps(challenge_items()))
