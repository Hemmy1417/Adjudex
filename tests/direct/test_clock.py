"""The consensus clock: fail-closed on every missing witness, tolerant of
explorer lag, strict on candidate divergence and validator drift."""

import pytest

from conftest import (PROVIDER, CLIENT, RESERVE, CREDIT, THRESHOLD, TERMS, W,
                      as_, dead, skew, clock_drift, err, active)


def _try_create(module, c):
    as_(module, PROVIDER, RESERVE)
    return c.create_agreement(CLIENT, TERMS, THRESHOLD, str(CREDIT), W, W, W, W)


def test_no_wall_clock_fails_closed(module, c):
    dead("cdn-cgi/trace")
    with pytest.raises(err(module), match="no consensus clock"):
        _try_create(module, c)


def test_one_dead_source_is_survivable(module, c):
    dead("medium.com")
    assert _try_create(module, c) == "adx-000001"


def test_divergent_candidates_fail_closed(module, c):
    skew("medium.com", 400)
    with pytest.raises(err(module), match="no consensus clock"):
        _try_create(module, c)


def test_dead_beacons_fail_closed(module, c):
    dead("headers/head")
    with pytest.raises(err(module), match="no consensus clock"):
        _try_create(module, c)


def test_lagging_explorer_is_tolerated(module, c):
    """The chain floor is one-directional: an indexer 21 minutes behind is
    normal and must not freeze the contract."""
    skew("blockscout", -1_250)
    assert _try_create(module, c) == "adx-000001"


def test_future_explorer_block_fails_closed(module, c):
    skew("blockscout", 400)
    with pytest.raises(err(module), match="no consensus clock"):
        _try_create(module, c)


def test_forward_skewed_wall_clock_hits_the_beacon_ceiling(module, c):
    """S20: a common forward skew of every edge host passes the mutual
    divergence check; only an independent mechanism catches it."""
    for host in ("cloudflare.com", "digitalocean.com", "medium.com"):
        skew(host, 400)
    with pytest.raises(err(module), match="no consensus clock"):
        _try_create(module, c)


def test_validator_drift_beyond_tolerance_fails_the_round(module, c):
    clock_drift(0, 400)
    with pytest.raises(err(module)):
        _try_create(module, c)


def test_validator_drift_within_tolerance_agrees(module, c):
    clock_drift(0, 200)
    assert _try_create(module, c) == "adx-000001"
