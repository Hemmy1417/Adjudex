"""Settlement and the ledger: atomic settle (S24), the claim choke point,
wei conservation, and the S30 concurrency/post-terminal invariants."""

import json

import pytest

from conftest import (PROVIDER, CLIENT, STRANGER, CREDIT, RESERVE, W, as_,
                      advance, conserve, sent, active, opened, final,
                      settled, err, sla_answer)


def test_breached_settlement_credits_the_client(module, c):
    aid, cid = settled(module, c)                 # default answer: BREACHED
    cs = json.loads(c.get_case(cid))
    assert cs["status"] == "SETTLED"
    assert cs["reserved_atto"] == "0"
    assert c.get_claimable(CLIENT) == str(CREDIT)
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_held_atto"] == "0"
    assert ag["reserve_free_atto"] == str(RESERVE - CREDIT)
    assert ag["open_cases"] == 0
    assert json.loads(c.get_stats())["breached"] == 1
    conserve(module, c)


def test_not_breached_settlement_returns_the_reservation(module, c):
    aid, cid = settled(module, c, answer=sla_answer(compliance=4,
                                                    infrastructure=2))
    assert json.loads(c.get_case(cid))["verdict"] == "NOT_BREACHED"
    assert c.get_claimable(CLIENT) == "0"
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_free_atto"] == str(RESERVE)
    assert json.loads(c.get_stats())["breached"] == 0
    conserve(module, c)


def test_settle_waits_for_the_challenge_window(module, c):
    aid, cid = final(module, c)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="challenge window is still open"):
        c.settle(cid)
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.settle(cid)


def test_settle_twice_refused(module, c):
    aid, cid = settled(module, c)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="nothing to settle"):
        c.settle(cid)
    conserve(module, c)


def test_settle_refuses_a_case_without_a_conclusive_verdict(module, c):
    from conftest import adjudicated
    aid, cid = adjudicated(module, c, answer=sla_answer(evidence="PARTIAL"))
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.promote(cid)                                  # REVIEW -> OPEN
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="nothing to settle"):
        c.settle(cid)


def test_claim_zeroes_then_transfers_finalized(module, c):
    aid, cid = settled(module, c)
    as_(module, CLIENT, 0)
    out = json.loads(c.claim())
    assert out["claimed_atto"] == str(CREDIT)
    assert sent() == [(CLIENT, CREDIT)]
    assert c.get_claimable(CLIENT) == "0"
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="nothing claimable"):
        c.claim()
    conserve(module, c)


def test_full_arc_conserves_every_atto(module, c):
    aid, cid = settled(module, c)                    # BREACHED
    as_(module, CLIENT, 0)
    c.claim()
    # wind the agreement down and drain the provider side too
    as_(module, PROVIDER, 0)
    c.begin_close(aid)
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.finalize_close(aid)
    as_(module, PROVIDER, 0)
    c.claim()
    assert int(c.escrow_atto) == 0
    assert sorted(sent()) == sorted([(CLIENT, CREDIT),
                                     (PROVIDER, RESERVE - CREDIT)])
    conserve(module, c)


def test_withdraw_after_settlement_refused(module, c):
    aid, cid = settled(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="cannot withdraw"):
        c.withdraw_case(cid)


def test_second_settlement_cannot_double_spend_the_reserve(module, c):
    """S30 invariant: two cases, one reserve top-up each — every settlement
    reads its OWN reservation; the ledger and reserves reconcile at every
    step."""
    aid = active(module, c, reserve=2 * CREDIT)
    for period in ("2026-08", "2026-09"):
        as_(module, CLIENT, 0)
        c.open_case(aid, period)
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_free_atto"] == "0"
    conserve(module, c)

    from conftest import demo_items, panel_says
    for cid in ("case-000001", "case-000002"):
        as_(module, CLIENT, 0)
        c.commit_evidence(cid, json.dumps(demo_items()))
        advance(W + 1)
        panel_says(sla_answer())
        as_(module, STRANGER, 0)
        c.adjudicate(cid)
        advance(W + 1)
        as_(module, STRANGER, 0)
        c.promote(cid)
        advance(W + 1)
        as_(module, STRANGER, 0)
        c.settle(cid)
        conserve(module, c)
    assert c.get_claimable(CLIENT) == str(2 * CREDIT)
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_held_atto"] == "0"
    assert ag["reserve_free_atto"] == "0"


def test_stats_reconcile(module, c):
    aid, cid = settled(module, c)
    stats = json.loads(c.get_stats())
    assert stats == {"agreements": 1, "cases": 1, "settled": 1,
                     "breached": 1, "escrow_atto": str(RESERVE)}
