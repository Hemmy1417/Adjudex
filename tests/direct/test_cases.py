"""Case lifecycle: the S23 reservation at open, the append-only record,
the provider's on-chain review posture, withdraw and abandon exits."""

import json

import pytest

from conftest import (PROVIDER, CLIENT, STRANGER, CREDIT, RESERVE, W, as_,
                      advance, conserve, active, opened, evidenced, err,
                      log_item, demo_items)


def test_open_reserves_the_full_credit(module, c):
    aid, cid = opened(module, c)
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_free_atto"] == str(RESERVE - CREDIT)
    assert ag["reserve_held_atto"] == str(CREDIT)
    assert ag["open_cases"] == 1
    cs = json.loads(c.get_case(cid))
    assert cs["status"] == "OPEN"
    assert cs["reserved_atto"] == str(CREDIT)
    conserve(module, c)


def test_open_is_client_only(module, c):
    aid = active(module, c)
    as_(module, PROVIDER, 0)
    with pytest.raises(err(module), match="only the client"):
        c.open_case(aid, "2026-08")


def test_open_refuses_bad_period_labels(module, c):
    aid = active(module, c)
    for bad in ("x", "2026_08", "AUG 26", "A" * 25):
        as_(module, CLIENT, 0)
        with pytest.raises(err(module), match="period label"):
            c.open_case(aid, bad)
    # lowercase input is normalized, not refused
    as_(module, CLIENT, 0)
    c.open_case(aid, "aug-2026")
    assert json.loads(c.get_case("case-000001"))["period_label"] == "AUG-2026"


def test_open_dedupes_periods(module, c):
    aid, cid = opened(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="already has a case"):
        c.open_case(aid, "2026-08")


def test_s23_reservation_race_is_closed(module, c):
    """Reserve funds exactly ONE credit: the second open must fail on the
    solvency the first already consumed — not settle later against nothing."""
    aid = active(module, c, reserve=CREDIT)
    as_(module, CLIENT, 0)
    c.open_case(aid, "2026-08")
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="cannot fund another"):
        c.open_case(aid, "2026-09")
    conserve(module, c)


def test_three_periods_exhaust_the_demo_reserve(module, c):
    aid = active(module, c)
    for period in ("2026-08", "2026-09", "2026-10"):
        as_(module, CLIENT, 0)
        c.open_case(aid, period)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="cannot fund another"):
        c.open_case(aid, "2026-11")
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_free_atto"] == "0"
    assert ag["reserve_held_atto"] == str(3 * CREDIT)
    conserve(module, c)


def test_commit_builds_versioned_manifest(module, c):
    aid, cid = evidenced(module, c)
    cs = json.loads(c.get_case(cid))
    assert cs["evidence_version"] == 1
    assert cs["item_count"] == 3
    manifest = json.loads(c.get_evidence(cid, 1))
    assert [it["id"] for it in manifest["items"]] == ["EV-001", "EV-002", "EV-003"]
    assert manifest["root"] == cs["evidence_root"]
    for it in manifest["items"]:
        assert it["submitter"] == "client"
        assert len(it["content_hash"]) == 64


def test_commit_appends_across_versions(module, c):
    aid, cid = evidenced(module, c)
    as_(module, CLIENT, 0)
    c.commit_evidence(cid, json.dumps([log_item("Late addendum")]))
    cs = json.loads(c.get_case(cid))
    assert cs["evidence_version"] == 2
    assert cs["item_count"] == 4
    m2 = json.loads(c.get_evidence(cid, 2))
    assert [it["id"] for it in m2["items"]][-1] == "EV-004"
    # the first version is still there, untouched
    m1 = json.loads(c.get_evidence(cid, 1))
    assert len(m1["items"]) == 3


def test_commit_is_party_only(module, c):
    aid, cid = opened(module, c)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="only a party"):
        c.commit_evidence(cid, json.dumps(demo_items()))


def test_provider_commits_response_kind_only(module, c):
    aid, cid = evidenced(module, c)
    as_(module, PROVIDER, 0)
    with pytest.raises(err(module), match="kind 'response'"):
        c.commit_evidence(cid, json.dumps([log_item("Provider log")]))
    as_(module, PROVIDER, 0)
    c.commit_evidence(cid, json.dumps([
        {"kind": "response", "label": "Provider answer",
         "content": "The 14 August incident INC-88 was notified at 09:41 UTC; "
                    "TXN-0177 falls inside the documented outage window."}]))
    m = json.loads(c.get_evidence(cid, 2))
    assert m["items"][-1]["submitter"] == "provider"


def test_client_cannot_use_response_kind(module, c):
    aid, cid = opened(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="provider's kind"):
        c.commit_evidence(cid, json.dumps(
            [log_item("Fake answer", "x" * 40, "response")]))


def test_commit_restarts_the_response_window(module, c):
    aid, cid = evidenced(module, c)
    first = json.loads(c.get_case(cid))["last_commit_epoch"]
    advance(500)
    as_(module, PROVIDER, 0)
    c.commit_evidence(cid, json.dumps([
        {"kind": "response", "label": "Answer",
         "content": "The provider contests the eligibility basis of the log "
                    "for the reasons stated in this response record."}]))
    assert json.loads(c.get_case(cid))["last_commit_epoch"] == first + 500


def test_review_records_provider_positions(module, c):
    aid, cid = evidenced(module, c)
    as_(module, PROVIDER, 0)
    c.review_evidence(cid, "EV-001", "ack")
    as_(module, PROVIDER, 0)
    c.review_evidence(cid, "EV-003", "dispute")
    assert json.loads(c.get_acks(cid)) == {"EV-001": "ACK", "EV-003": "DISPUTE"}


def test_review_is_provider_only_on_client_items(module, c):
    aid, cid = evidenced(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="only the provider"):
        c.review_evidence(cid, "EV-001", "ack")
    as_(module, PROVIDER, 0)
    c.commit_evidence(cid, json.dumps([
        {"kind": "response", "label": "Answer",
         "content": "A response record long enough to pass the length gate."}]))
    as_(module, PROVIDER, 0)
    with pytest.raises(err(module), match="not its own"):
        c.review_evidence(cid, "EV-004", "ack")


def test_review_refuses_unknown_item_and_position(module, c):
    aid, cid = evidenced(module, c)
    as_(module, PROVIDER, 0)
    with pytest.raises(err(module), match="no such item"):
        c.review_evidence(cid, "EV-099", "ack")
    as_(module, PROVIDER, 0)
    with pytest.raises(err(module), match="ACK or DISPUTE"):
        c.review_evidence(cid, "EV-001", "maybe")


def test_withdraw_releases_the_reservation(module, c):
    aid, cid = opened(module, c)
    as_(module, CLIENT, 0)
    c.withdraw_case(cid)
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_free_atto"] == str(RESERVE)
    assert ag["reserve_held_atto"] == "0"
    assert ag["open_cases"] == 0
    assert json.loads(c.get_case(cid))["status"] == "WITHDRAWN"
    conserve(module, c)


def test_withdraw_is_client_only_and_open_only(module, c):
    aid, cid = opened(module, c)
    as_(module, PROVIDER, 0)
    with pytest.raises(err(module), match="only the client"):
        c.withdraw_case(cid)
    as_(module, CLIENT, 0)
    c.withdraw_case(cid)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="cannot withdraw"):
        c.withdraw_case(cid)


def test_abandon_needs_the_idle_window(module, c):
    aid, cid = opened(module, c)
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="abandon window"):
        c.abandon_case(cid)
    advance(2_592_001)
    as_(module, STRANGER, 0)
    c.abandon_case(cid)
    ag = json.loads(c.get_agreement(aid))
    assert ag["reserve_free_atto"] == str(RESERVE)
    assert json.loads(c.get_case(cid))["status"] == "WITHDRAWN"
    conserve(module, c)


def test_commit_resets_the_abandon_clock(module, c):
    aid, cid = evidenced(module, c)
    advance(2_000_000)
    as_(module, CLIENT, 0)
    c.commit_evidence(cid, json.dumps([log_item("Keepalive record")]))
    advance(1_000_000)   # 3M since open, only 1M since the commit
    as_(module, STRANGER, 0)
    with pytest.raises(err(module), match="abandon window"):
        c.abandon_case(cid)


def test_period_registry_reaches_the_case(module, c):
    aid, cid = opened(module, c)
    cases = json.loads(c.get_cases_for(aid))
    assert [x["case_id"] for x in cases] == [cid]
    assert cases[0]["period_label"] == "2026-08"
