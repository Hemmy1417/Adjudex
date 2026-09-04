"""Chain-anchored evidence (v0.2.0): the fixed registry, the per-node anchor
verification, the corroboration derivation, and the S34 authenticity floor —
a breach found on a record that is neither chain-verified nor conceded by
the counterparty cannot take money.

RPC mocks are strict: an unmocked POST fails the test, so hidden extra
chain calls surface.
"""

import json

import pytest

from conftest import (PROVIDER, CLIENT, STRANGER, CREDIT, W, as_, advance,
                      evidenced, err, panel_says, sla_answer, prompts,
                      rpc_mock, rpc_calls, log_item, demo_items)

TX = "0x" + "ab" * 32
BLOCK = "0x" + "cd" * 32

GOOD_RECEIPT = {"status": "0x1", "blockHash": BLOCK}
GOOD_BLOCK = {"timestamp": hex(1_759_990_000)}


def anchored_items(chain="genlayer-studionet", tx=TX):
    items = demo_items()
    items[0]["anchor_chain"] = chain
    items[0]["anchor_tx"] = tx
    return items


def studio_ok():
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt", GOOD_RECEIPT)
    rpc_mock("studio.genlayer.com", "eth_getBlockByHash", GOOD_BLOCK)


# ── intake validation ────────────────────────────────────────────────────────

def test_anchor_needs_both_chain_and_tx(module, c):
    items = demo_items()
    items[0]["anchor_chain"] = "base"
    aid, cid = None, None
    from conftest import opened
    aid, cid = opened(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="names both its chain"):
        c.commit_evidence(cid, json.dumps(items))


def test_anchor_refuses_unknown_chain(module, c):
    from conftest import opened
    aid, cid = opened(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="unknown anchor chain"):
        c.commit_evidence(cid, json.dumps(
            anchored_items(chain="dogechain")))


def test_anchor_refuses_malformed_tx_hash(module, c):
    from conftest import opened
    aid, cid = opened(module, c)
    as_(module, CLIENT, 0)
    with pytest.raises(err(module), match="0x plus 64 hex"):
        c.commit_evidence(cid, json.dumps(
            anchored_items(tx="0x1234")))


def test_provider_response_carries_no_anchor(module, c):
    aid, cid = evidenced(module, c)
    as_(module, PROVIDER, 0)
    item = {"kind": "response", "label": "Answer", "content":
            "The provider answers the record with its own account of it.",
            "anchor_chain": "base", "anchor_tx": TX}
    with pytest.raises(err(module), match="wallet-signed already"):
        c.commit_evidence(cid, json.dumps([item]))


def test_anchored_row_hash_commits_to_the_anchor(module, c):
    """An anchored row's content_hash covers the anchor fields; an
    unanchored row's hash stays on the v0.1.0 formula."""
    from conftest import opened
    aid, cid = opened(module, c)
    as_(module, CLIENT, 0)
    c.commit_evidence(cid, json.dumps(anchored_items()))
    manifest = json.loads(c.get_evidence(cid, 1))
    anchored, plain = manifest["items"][0], manifest["items"][1]
    assert anchored["anchor_chain"] == "genlayer-studionet"
    assert anchored["anchor_tx"] == TX
    h = module._sha256_hex(module._canonical(
        {k: anchored[k] for k in ("id", "kind", "submitter", "label",
                                  "content", "anchor_chain", "anchor_tx")}))
    assert anchored["content_hash"] == h
    h2 = module._sha256_hex(module._canonical(
        {k: plain[k] for k in ("id", "kind", "submitter", "label",
                               "content")}))
    assert plain["content_hash"] == h2


# ── _verify_anchor unit paths ────────────────────────────────────────────────

def test_verify_anchor_verified_with_block_time(module, c):
    studio_ok()
    assert module._verify_anchor("genlayer-studionet", TX) == \
        ("VERIFIED", 1_759_990_000)


def test_verify_anchor_not_found_is_authoritative(module, c):
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt", None)
    assert module._verify_anchor("genlayer-studionet", TX) == ("NOT_FOUND", 0)


def test_verify_anchor_omitted_result_key_is_not_found(module, c):
    """The probed StudioNet quirk: an unknown hash answers with a success
    envelope carrying NO result key at all. That is the chain not knowing
    the transaction — NOT_FOUND, never UNAVAILABLE."""
    from conftest import OMIT_RESULT
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt", OMIT_RESULT)
    assert module._verify_anchor("genlayer-studionet", TX) == ("NOT_FOUND", 0)


def test_verify_anchor_error_envelope_is_endpoint_weather(module, c):
    """A JSON-RPC error envelope (unsupported method, bad params) is the
    ENDPOINT failing to answer, never a chain answer: UNAVAILABLE."""
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt",
             RuntimeError("transport"))
    assert module._verify_anchor("genlayer-studionet", TX) == \
        ("UNAVAILABLE", 0)


def test_verify_anchor_failed_tx(module, c):
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt",
             {"status": "0x0", "blockHash": BLOCK})
    assert module._verify_anchor("genlayer-studionet", TX) == ("FAILED_TX", 0)


def test_verify_anchor_unavailable_on_transport_failure(module, c):
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt",
             RuntimeError("connection refused"))
    assert module._verify_anchor("genlayer-studionet", TX) == \
        ("UNAVAILABLE", 0)


def test_verify_anchor_falls_back_to_the_second_endpoint(module, c):
    rpc_mock("mainnet.base.org", "eth_getTransactionReceipt",
             RuntimeError("down"))
    rpc_mock("base-rpc.publicnode.com", "eth_getTransactionReceipt",
             GOOD_RECEIPT)
    rpc_mock("base-rpc.publicnode.com", "eth_getBlockByHash", GOOD_BLOCK)
    assert module._verify_anchor("base", TX) == ("VERIFIED", 1_759_990_000)
    assert any("publicnode" in u for u, m, p in rpc_calls())


def test_verify_anchor_receipt_without_status_proves_existence(module, c):
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt",
             {"blockHash": BLOCK})
    rpc_mock("studio.genlayer.com", "eth_getBlockByHash", GOOD_BLOCK)
    assert module._verify_anchor("genlayer-studionet", TX) == \
        ("VERIFIED", 1_759_990_000)


def test_verify_anchor_insane_epoch_zeroes(module, c):
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt", GOOD_RECEIPT)
    rpc_mock("studio.genlayer.com", "eth_getBlockByHash",
             {"timestamp": "0x10"})
    assert module._verify_anchor("genlayer-studionet", TX) == ("VERIFIED", 0)


# ── corroboration derivation ─────────────────────────────────────────────────

def test_corroboration_ladder(module, c):
    d = module._derive_corroboration
    row = lambda **kw: dict({"submitter": "client", "ack": "",
                             "anchor_state": ""}, **kw)
    assert d([row()]) == "NONE"
    assert d([row(ack="DISPUTE")]) == "NONE"
    assert d([row(ack="ACK")]) == "BILATERAL"
    assert d([row(anchor_state="VERIFIED")]) == "INDEPENDENT"
    assert d([row(ack="ACK"), row(anchor_state="VERIFIED")]) == "INDEPENDENT"
    # provider rows and garbage upgrade nothing
    assert d([row(submitter="provider", anchor_state="VERIFIED"),
              "garbage", None]) == "NONE"
    assert d([row(anchor_state="NOT_FOUND")]) == "NONE"


def test_floor_in_derive_verdict(module, c):
    ex = {x: 0 for x in module.EXCUSE_CATEGORIES}
    args = (100, 10, ex, "SUFFICIENT", [], 9_500)
    assert module._derive_verdict(*args, "NONE") == ("REVIEW_REQUIRED", 0)
    assert module._derive_verdict(*args, "BILATERAL") == ("BREACHED", 9_000)
    assert module._derive_verdict(*args, "INDEPENDENT") == ("BREACHED", 9_000)
    # NOT_BREACHED needs no floor: returning the reservation is neutral
    ok = (100, 2, ex, "SUFFICIENT", [], 9_500)
    assert module._derive_verdict(*ok, "NONE") == ("NOT_BREACHED", 9_800)


# ── the round, end to end ────────────────────────────────────────────────────

def test_uncorroborated_breach_holds_for_review(module, c):
    """The S34 floor live in the round: breach-shaped counts on a record
    with no ACK and no anchor land REVIEW_REQUIRED, and the reservation
    stays held for the reopened case."""
    aid, cid = evidenced(module, c, acks=())
    advance(W + 1)
    panel_says(sla_answer())
    as_(module, STRANGER, 0)
    c.adjudicate(cid)
    a = json.loads(c.get_assessment(cid, 1))
    assert a["verdict"] == "REVIEW_REQUIRED"
    assert a["rate_bps"] == 0
    assert a["corroboration"] == "NONE"


def test_verified_anchor_alone_carries_the_breach(module, c):
    """INDEPENDENT footing from the panel's own registry check: no ACKs at
    all, one verified anchor, and the breach pays."""
    studio_ok()
    aid, cid = evidenced(module, c, items=anchored_items(), acks=())
    advance(W + 1)
    panel_says(sla_answer())
    as_(module, STRANGER, 0)
    c.adjudicate(cid)
    a = json.loads(c.get_assessment(cid, 1))
    assert a["verdict"] == "BREACHED"
    assert a["rate_bps"] == 9_300
    assert a["corroboration"] == "INDEPENDENT"
    row = a["rows"][0]
    assert row["anchor_state"] == "VERIFIED"
    assert row["anchor_epoch"] == 1_759_990_000
    # the leader and the validator each queried the chain themselves
    receipt_calls = [x for x in rpc_calls()
                     if x[1] == "eth_getTransactionReceipt"]
    assert len(receipt_calls) == 2


def test_prompt_names_the_verification_results(module, c):
    studio_ok()
    aid, cid = evidenced(module, c, items=anchored_items(), acks=())
    advance(W + 1)
    panel_says(sla_answer())
    as_(module, STRANGER, 0)
    c.adjudicate(cid)
    p = prompts()[-1]
    assert "CHAIN-VERIFIED ANCHOR" in p
    assert "1 verified, 0 refuted" in p
    assert "block time epoch 1759990000" in p


def test_refuted_anchor_is_weighed_against_the_item(module, c):
    """A declared anchor the chain does not know: corroboration falls back
    (here to BILATERAL via the default ACK) and the prompt says NOT FOUND
    so the panel can weigh the failed verification."""
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt", None)
    aid, cid = evidenced(module, c, items=anchored_items())
    advance(W + 1)
    panel_says(sla_answer())
    as_(module, STRANGER, 0)
    c.adjudicate(cid)
    a = json.loads(c.get_assessment(cid, 1))
    assert a["corroboration"] == "BILATERAL"
    assert a["rows"][0]["anchor_state"] == "NOT_FOUND"
    assert "DECLARED ANCHOR NOT FOUND" in prompts()[-1]


def test_unreachable_registry_upgrades_nothing(module, c):
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt",
             RuntimeError("registry down"))
    aid, cid = evidenced(module, c, items=anchored_items(), acks=())
    advance(W + 1)
    panel_says(sla_answer())
    as_(module, STRANGER, 0)
    c.adjudicate(cid)
    a = json.loads(c.get_assessment(cid, 1))
    assert a["verdict"] == "REVIEW_REQUIRED"      # floor holds
    assert a["corroboration"] == "NONE"
    assert a["rows"][0]["anchor_state"] == "UNAVAILABLE"


# ── forged-leader anchor claims ──────────────────────────────────────────────

def _tampered_round(module, c, cid, mutate):
    real = module.gl.vm.run_nondet_unsafe
    endorsed = []

    def wrapped(leader_fn, validator_fn):
        value = leader_fn()
        if not (isinstance(value, dict) and "verdict" in value):
            return real(lambda: value, validator_fn)   # the clock round
        mutate(value)
        ok = validator_fn(module.gl.vm.Return(value))
        endorsed.append(ok)
        if not ok:
            raise module.gl.vm.UserError(
                "[LLM_ERROR] validators did not agree with the leader")
        return value

    module.gl.vm.run_nondet_unsafe = wrapped
    try:
        c.adjudicate(cid)
    except err(module):
        pass
    finally:
        module.gl.vm.run_nondet_unsafe = real
    assert endorsed, "the round never reached the validator"
    return endorsed[0]


def test_validator_refuses_a_forged_anchor_state(module, c):
    """A leader upgrading its row to VERIFIED (and its packet to
    INDEPENDENT/BREACHED) against a chain that says NOT_FOUND dies on the
    validator's own registry query."""
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt", None)
    aid, cid = evidenced(module, c, items=anchored_items(), acks=())
    advance(W + 1)
    panel_says(sla_answer())

    def forge(v):
        v["rows"][0]["anchor_state"] = "VERIFIED"
        v["corroboration"] = "INDEPENDENT"
        v["verdict"] = "BREACHED"
        v["rate_bps"] = 9_300

    assert _tampered_round(module, c, cid, forge) is False
    assert c.get_assessment(cid, 1) == ""


def test_validator_refuses_a_forged_corroboration_field(module, c):
    """Corroboration is re-derived from the leader's own rows: asserting
    INDEPENDENT without a VERIFIED row is refused even before comparison
    with this validator's own reading."""
    aid, cid = evidenced(module, c, acks=())
    advance(W + 1)
    panel_says(sla_answer())

    def forge(v):
        v["corroboration"] = "INDEPENDENT"
        v["verdict"] = "BREACHED"
        v["rate_bps"] = 9_300

    assert _tampered_round(module, c, cid, forge) is False


def test_validator_refuses_an_anchor_state_forged_in_place(module, c):
    """The subtle forgery: ONLY the row's anchor_state is upgraded, with the
    packet's corroboration and verdict left consistent with what the leader
    honestly derived. The row comparison (or the recheck deriving
    corroboration from those rows) must still catch it — the dossier is a
    record later readers rely on."""
    rpc_mock("studio.genlayer.com", "eth_getTransactionReceipt", None)
    aid, cid = evidenced(module, c, items=anchored_items(), acks=())
    advance(W + 1)
    panel_says(sla_answer())

    def forge(v):
        v["rows"][0]["anchor_state"] = "VERIFIED"   # everything else honest

    assert _tampered_round(module, c, cid, forge) is False


def test_validator_refuses_a_cosmetic_corroboration_lie(module, c):
    """The class lie that changes NOTHING else: a BILATERAL record (default
    ACK) whose packet claims INDEPENDENT, verdict and rate untouched — the
    derivation lands BREACHED either way, so only the corroboration layers
    themselves can catch it. The field is part of the record consumers
    read; a lie in it must not ratify."""
    aid, cid = evidenced(module, c)                 # ACKed -> BILATERAL
    advance(W + 1)
    panel_says(sla_answer())

    def forge(v):
        v["corroboration"] = "INDEPENDENT"          # verdict stays BREACHED

    assert _tampered_round(module, c, cid, forge) is False


def test_settlement_after_anchored_breach_pays_the_client(module, c):
    """End to end: the anchored breach settles and the client's ledger
    carries the credit — the floor never blocks a corroborated record."""
    studio_ok()
    aid, cid = evidenced(module, c, items=anchored_items(), acks=())
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
    assert c.get_claimable(CLIENT) == str(CREDIT)
