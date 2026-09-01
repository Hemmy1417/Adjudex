"""Agreement lifecycle: draft-and-fund, mutual assent, reserve custody,
close-out with an enforced notice window."""

import json

import pytest

from conftest import (PROVIDER, CLIENT, STRANGER, CREDIT, RESERVE, THRESHOLD,
                      TERMS, W, as_, advance, conserve, created, active,
                      opened, err, panel_says, sla_answer)


def test_create_returns_id_and_holds_reserve(module, c):
    aid = created(module, c)
    assert aid == "adx-000001"
    ag = json.loads(c.get_agreement(aid))
    assert ag["status"] == "CREATED"
    assert ag["provider"] == PROVIDER
    assert ag["client"] == CLIENT
    assert ag["reserve_free_atto"] == str(RESERVE)
    assert ag["reserve_held_atto"] == "0"
    assert ag["terms_text"] == TERMS
    assert int(c.escrow_atto) == RESERVE
    conserve(module, c)


def test_create_refuses_self_dealing(module, c):
    as_(module, PROVIDER, RESERVE)
    with pytest.raises(err(module), match="cannot be the provider's own"):
        c.create_agreement(PROVIDER, TERMS, THRESHOLD, str(CREDIT), W, W, W, W)


def test_create_refuses_short_terms(module, c):
    as_(module, PROVIDER, RESERVE)
    with pytest.raises(err(module), match="terms must be"):
        c.create_agreement(CLIENT, "too short", THRESHOLD, str(CREDIT), W, W, W, W)


def test_create_refuses_threshold_out_of_bounds(module, c):
    as_(module, PROVIDER, RESERVE)
    with pytest.raises(err(module), match="threshold"):
        c.create_agreement(CLIENT, TERMS, 4_999, str(CREDIT), W, W, W, W)
    as_(module, PROVIDER, RESERVE)
    with pytest.raises(err(module), match="threshold"):
        c.create_agreement(CLIENT, TERMS, 10_001, str(CREDIT), W, W, W, W)


def test_create_refuses_credit_out_of_bounds(module, c):
    as_(module, PROVIDER, RESERVE)
    with pytest.raises(err(module), match="credit amount"):
        c.create_agreement(CLIENT, TERMS, THRESHOLD, str(10**15), W, W, W, W)


def test_create_refuses_tiny_window(module, c):
    as_(module, PROVIDER, RESERVE)
    with pytest.raises(err(module), match="response window"):
        c.create_agreement(CLIENT, TERMS, THRESHOLD, str(CREDIT), 899, W, W, W)


def test_create_refuses_underfunded_reserve(module, c):
    as_(module, PROVIDER, CREDIT - 1)
    with pytest.raises(err(module), match="reserve must cover"):
        c.create_agreement(CLIENT, TERMS, THRESHOLD, str(CREDIT), W, W, W, W)


def test_cancel_refunds_through_ledger(module, c):
    aid = created(module, c)
    as_(module, PROVIDER, 0)
    c.cancel_agreement(aid)
    ag = json.loads(c.get_agreement(aid))
    assert ag["status"] == "CANCELLED"
    assert ag["reserve_free_atto"] == "0"
    assert c.get_claimable(PROVIDER) == str(RESERVE)
    conserve(module, c)


def test_cancel_is_provider_only_and_pre_accept_only(module, c):
    aid = created(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="only the provider"):
        c.cancel_agreement(aid)
    as_(module, CLIENT, 0)
    c.accept_agreement(aid)
    as_(module, PROVIDER, 0)
    with pytest.raises(err(module), match="unaccepted"):
        c.cancel_agreement(aid)


def test_accept_after_cancel_refused(module, c):
    aid = created(module, c)
    as_(module, PROVIDER, 0)
    c.cancel_agreement(aid)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="nothing to accept"):
        c.accept_agreement(aid)


def test_accept_binds_the_named_client_only(module, c):
    aid = created(module, c)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="named client"):
        c.accept_agreement(aid)
    as_(module, CLIENT, 0)
    assert c.accept_agreement(aid) == "active"
    assert json.loads(c.get_agreement(aid))["status"] == "ACTIVE"


def test_top_up_grows_the_free_reserve(module, c):
    aid = active(module, c)
    as_(module, PROVIDER, CREDIT)
    c.top_up_reserve(aid)
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_free_atto"] == str(RESERVE + CREDIT)
    conserve(module, c)


def test_top_up_is_provider_only(module, c):
    aid = active(module, c)
    as_(module, CLIENT, CREDIT)
    with pytest.raises(err(module), match="only the provider"):
        c.top_up_reserve(aid)


def test_close_out_honours_notice_then_releases(module, c):
    aid = active(module, c)
    as_(module, CLIENT, 0)
    c.begin_close(aid)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="notice window"):
        c.finalize_close(aid)
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.finalize_close(aid)
    ag = json.loads(c.get_agreement(aid))
    assert ag["status"] == "CLOSED"
    assert c.get_claimable(PROVIDER) == str(RESERVE)
    conserve(module, c)


def test_close_out_waits_for_open_cases(module, c):
    aid, cid = opened(module, c)
    as_(module, PROVIDER, 0)
    c.begin_close(aid)
    advance(W + 1)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="open cases"):
        c.finalize_close(aid)


def test_client_keeps_case_rights_through_the_notice_window(module, c):
    aid = active(module, c)
    as_(module, PROVIDER, 0)
    c.begin_close(aid)
    as_(module, CLIENT, 0)
    cid = c.open_case(aid, "2026-08")
    assert cid == "case-000001"
    advance(W + 1)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="notice window has passed"):
        c.open_case(aid, "2026-09")


def test_stranger_cannot_begin_close(module, c):
    aid = active(module, c)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="only a party"):
        c.begin_close(aid)


def test_agreement_views_paginate(module, c):
    created(module, c)
    created(module, c)
    page = json.loads(c.get_agreements(0, 1))
    assert page["total"] == 2
    assert len(page["agreements"]) == 1
    assert page["agreements"][0]["agreement_id"] == "adx-000002"
    mine = json.loads(c.get_agreements_for(PROVIDER))
    assert {a["agreement_id"] for a in mine} == {"adx-000001", "adx-000002"}
