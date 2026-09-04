"""Direct-mode harness: the real contract module run against a stub
`genlayer` that is AS STRICT AS the runtime where it matters — DynArray
refuses user construction, unknown gl attributes raise, validator functions
actually run, and a validator returning False surfaces as a failed round
rather than a settled state.

The panel is a queue: successive exec_prompt calls walk it and the last
entry repeats, so a test can hand the leader and the validator different
answers and prove the comparison logic notices."""

import importlib.util
import json
import pathlib
import sys
import types

import pytest

CONTRACT_PATH = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "adjudex.py"

PROVIDER = "0x1111111111111111111111111111111111111111"
CLIENT = "0x2222222222222222222222222222222222222222"
STRANGER = "0x5555555555555555555555555555555555555555"

GEN = 10**18
CREDIT = 5 * 10**16          # the canonical test credit: 0.05 GEN / period
RESERVE = 15 * 10**16        # opening reserve: three periods
BOND = 5 * 10**16            # bond floor dominates at this credit size
THRESHOLD = 9_500            # 95.00%
W = 900                      # every window at the enforced minimum

TERMS = (
    "SERVICE LEVEL AGREEMENT between the correspondent bank (provider) and "
    "the institution (client). 95% of eligible cross-border payments must be "
    "processed within 30 minutes of instruction receipt. EXCEPTIONS: delays "
    "caused by regulatory or compliance screening are excepted; delays caused "
    "by documented infrastructure outages the provider notified within 24 "
    "hours are excepted; payments with incomplete beneficiary information "
    "are not eligible until completed. CONSEQUENCE: falling below the "
    "threshold in a service period owes the client the agreed service credit."
)

# Test wall-clock. Tests advance it to pass real time.
_NOW = [1_760_000_000]
_SKEW = {}
_DEAD = set()
_PANEL = []
_PANEL_CALLS = [0]
_SENT = []
_PROMPTS = []
_RUN_DRIFT = []
_RUN_INDEX = [-1]

# JSON-RPC anchor mocks: (url_fragment, method) -> result | Exception.
# Strict: an unmocked POST fails the test, so a hidden extra RPC call
# surfaces. rpc_calls records every (url, method, params) the round made.
# OMIT_RESULT reproduces the probed StudioNet quirk: a success envelope
# with NO result key at all (instead of "result": null).
_RPC = {}
_RPC_CALLS = []
OMIT_RESULT = object()


class _UserError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


class _VmModule:
    UserError = _UserError

    class Return:
        def __init__(self, calldata):
            self.calldata = calldata

    class Rollback:
        def __init__(self, message):
            self.message = message

    Result = object

    @staticmethod
    def run_nondet_unsafe(leader_fn, validator_fn):
        try:
            value = leader_fn()
        except Exception as e:
            res = _VmModule.Rollback(getattr(e, "message", str(e)))
            if validator_fn(res):
                raise _UserError(getattr(e, "message", str(e)))
            raise _UserError("[LLM_ERROR] validators disagreed with the leader's failure")
        ok = validator_fn(_VmModule.Return(value))
        if not ok:
            raise _UserError("[LLM_ERROR] validators did not agree with the leader")
        return value


class _TreeMap(dict):
    def get(self, k, default=None):
        return super().get(k, default)


class _U256(int):
    def __new__(cls, v):
        return super().__new__(cls, int(v))


class _DynArrayMeta(type):
    def __getitem__(cls, item):
        return cls


class _DynArray(list, metaclass=_DynArrayMeta):
    """Refuses user construction exactly like the runtime — a stub more
    permissive than the chain certifies bugs instead of catching them."""

    def __init__(self, *args, **kwargs):
        raise TypeError("this class can't be instantiated by user")

    @classmethod
    def _from_storage(cls, items=()):
        obj = list.__new__(cls)
        list.__init__(obj, items)
        return obj


class _Address(str):
    def __new__(cls, v):
        return super().__new__(cls, str(v))


class _CliAddress:
    """What the genlayer CLI delivers for a 40-hex argument: an Address
    OBJECT with .as_hex and no str methods."""
    def __init__(self, hex_str):
        self.as_hex = hex_str

    def __repr__(self):
        return f"<Address {self.as_hex}>"


class _ViewDeco:
    def __call__(self, fn):
        return fn


class _WriteDeco:
    payable = staticmethod(lambda fn: fn)

    def __call__(self, fn):
        return fn


class _Public:
    view = _ViewDeco()
    write = _WriteDeco()


class _EvmProxyInstance:
    def __init__(self, addr):
        self._addr = addr

    def emit_transfer(self, value=0, on="finalized"):
        if on != "finalized":
            raise AssertionError("payouts must ride on='finalized'")
        _SENT.append((str(self._addr).lower(), int(value)))


class _EvmModule:
    @staticmethod
    def contract_interface(cls):
        return lambda addr: _EvmProxyInstance(addr)


class _NondetWeb:
    class _Response:
        def __init__(self, status, body):
            self.status = status
            self.body = body
            self.headers = {}

    @staticmethod
    def post(url, body=None, headers=None):
        try:
            method = json.loads(body.decode("utf-8")).get("method", "")
            params = json.loads(body.decode("utf-8")).get("params", [])
        except Exception:
            method, params = "", []
        _RPC_CALLS.append((url, method, params))
        for (frag, m), answer in _RPC.items():
            if frag in url and m == method:
                if isinstance(answer, BaseException):
                    raise answer
                if answer is OMIT_RESULT:
                    envelope = {"jsonrpc": "2.0", "id": 1}
                else:
                    envelope = {"jsonrpc": "2.0", "id": 1, "result": answer}
                return _NondetWeb._Response(
                    200, json.dumps(envelope).encode("utf-8"))
        raise AssertionError(f"unmocked RPC POST: {url} {method}")

    @staticmethod
    def render(url, mode="text"):
        for dead in _DEAD:
            if dead in url:
                raise RuntimeError("source unreachable")
        skew = next((v for k, v in _SKEW.items() if k in url), 0)
        if "cloudflare.com/cdn-cgi/trace" in url:
            _RUN_INDEX[0] += 1
        drift = 0
        if _RUN_DRIFT:
            drift = _RUN_DRIFT[min(max(_RUN_INDEX[0], 0), len(_RUN_DRIFT) - 1)]
        if drift == "DEAD" and (
            "cdn-cgi/trace" in url or "blockscout" in url or "headers/head" in url
        ):
            raise RuntimeError("source unreachable")
        now = _NOW[0] + skew + (drift if isinstance(drift, int) else 0)
        if "cdn-cgi/trace" in url:
            return f"fl=1\nts={now}.000\n"
        if "blockscout" in url:
            import datetime as _dt
            t = _dt.datetime.fromtimestamp(now, _dt.timezone.utc)
            return json.dumps([{"timestamp": t.strftime("%Y-%m-%dT%H:%M:%S.000000Z")}])
        if "headers/head" in url:
            slot = (now - 1606824023) // 12
            return json.dumps({"data": {"header": {"message": {"slot": str(slot)}}}})
        return ""


class _Nondet:
    web = _NondetWeb()

    @staticmethod
    def exec_prompt(prompt, response_format=None):
        _PROMPTS.append(prompt)
        if not _PANEL:
            raise AssertionError("test ran the panel without panel_says()")
        idx = min(_PANEL_CALLS[0], len(_PANEL) - 1)
        _PANEL_CALLS[0] += 1
        answer = _PANEL[idx]
        if isinstance(answer, BaseException):
            raise answer
        return answer


class _GL:
    class Contract:
        pass

    nondet = _Nondet()
    public = _Public()
    vm = _VmModule
    evm = _EvmModule()

    class message:
        sender_address = PROVIDER
        value = 0


def _install():
    mod = types.ModuleType("genlayer")
    mod.gl = _GL
    mod.TreeMap = _TreeMap
    mod.DynArray = _DynArray
    mod.u256 = _U256
    mod.Address = _Address
    mod.allow_storage = lambda cls: cls
    mod.__all__ = ["gl", "TreeMap", "DynArray", "u256", "Address", "allow_storage"]
    sys.modules["genlayer"] = mod


def _load():
    _install()
    spec = importlib.util.spec_from_file_location("adjudex_contract", CONTRACT_PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.fixture
def module():
    return _load()


@pytest.fixture
def c(module):
    _NOW[0] = 1_760_000_000
    _SKEW.clear()
    _DEAD.clear()
    _SENT.clear()
    _PROMPTS.clear()
    _PANEL.clear()
    _PANEL_CALLS[0] = 0
    _RUN_DRIFT.clear()
    _RUN_INDEX[0] = -1
    _RPC.clear()
    _RPC_CALLS.clear()

    as_(module, PROVIDER, 0)
    inst = module.Adjudex()
    for name in ("agreements", "terms_store", "cases", "case_index",
                 "period_registry", "manifests", "assessments", "acks",
                 "ack_lists", "actor_index", "claimable"):
        setattr(inst, name, module.TreeMap())
    inst.agreement_ids = _DynArray._from_storage()
    return inst


# ── helpers ──────────────────────────────────────────────────────────────────

def as_(module, who, value=0):
    module.gl.message.sender_address = who
    module.gl.message.value = value


def advance(seconds):
    _NOW[0] += seconds


def sent():
    return list(_SENT)


def prompts():
    return list(_PROMPTS)


def clock_drift(*offsets):
    _RUN_DRIFT.clear()
    _RUN_INDEX[0] = -1
    _RUN_DRIFT.extend(offsets)


def skew(fragment, seconds):
    _SKEW[fragment] = seconds


def dead(fragment):
    _DEAD.add(fragment)


def rpc_mock(url_fragment, method, answer):
    """Mock one JSON-RPC method on endpoints whose URL contains the
    fragment. answer: the JSON-RPC result value, or an Exception to raise
    at transport level."""
    _RPC[(url_fragment, method)] = answer


def rpc_calls():
    return list(_RPC_CALLS)


def err(module):
    return module.gl.vm.UserError


def conserve(module, c):
    """The wei invariant: everything the contract physically holds is either
    an agreement reserve (free or held), an unclaimed ledger balance, or an
    undecided challenge bond."""
    reserves = sum(int(ag.reserve_free) + int(ag.reserve_held)
                   for ag in c.agreements.values())
    ledger = sum(int(v) for v in c.claimable.values())
    bonds = sum(int(cs.challenge_bond_atto) for cs in c.cases.values())
    assert int(c.escrow_atto) == reserves + ledger + bonds, (
        f"conservation broken: escrow={int(c.escrow_atto)} "
        f"reserves={reserves} ledger={ledger} bonds={bonds}")


def log_item(label="Payment log", content=None, kind="payment_log"):
    return {"kind": kind, "label": label,
            "content": content or (
                "PAYMENT PROCESSING LOG, period 2026-08. 100 eligible "
                "cross-border payments received. 90 processed within 30 "
                "minutes. 10 exceeded 30 minutes: TXN-0041 (44m), TXN-0102 "
                "(47m), TXN-0177 (61m), TXN-0203 (39m), TXN-0264 (52m), "
                "TXN-0311 (35m), TXN-0362 (88m), TXN-0410 (41m), TXN-0455 "
                "(49m), TXN-0489 (73m).")}


def demo_items():
    return [
        log_item(),
        log_item("Exception records",
                 "EXCEPTION RECORDS, period 2026-08. TXN-0041: regulatory "
                 "compliance screening hold, cleared after 41 minutes, "
                 "screening reference SCR-2216. TXN-0102: compliance "
                 "screening hold, reference SCR-2219.",
                 "exception_record"),
        log_item("Outage notice",
                 "OUTAGE NOTICE. On 14 August the provider's settlement "
                 "gateway was degraded between 09:10 and 10:05 UTC; incident "
                 "INC-88 was notified to clients at 09:41 UTC the same day. "
                 "TXN-0177 was in flight during the outage window.",
                 "outage_notice"),
    ]


def sla_answer(eligible=100, late=10, compliance=2, infrastructure=1,
               data_gap=0, other=0, evidence="SUFFICIENT", conflicts=None,
               score=88, reason="the record reconciles and the exceptions are documented",
               **over):
    """A complete, valid panel answer. Defaults describe demo_items():
    100 eligible, 10 late, 3 excused -> 7 unexcused -> rate 9300 bps,
    below the 9500 threshold -> BREACHED."""
    ans = {
        "eligible_total": eligible, "late_total": late,
        "excused": {"COMPLIANCE_HOLD": compliance,
                    "INFRASTRUCTURE": infrastructure,
                    "DATA_GAP": data_gap, "OTHER_TERMS": other},
        "evidence": evidence,
        "conflicts": conflicts or [],
        "score": score,
        "reason": reason,
    }
    ans.update(over)
    return ans


def panel_says(answer):
    _PANEL.clear()
    _PANEL_CALLS[0] = 0
    _PANEL.append(answer)


def panel_sequence(*answers):
    _PANEL.clear()
    _PANEL_CALLS[0] = 0
    _PANEL.extend(answers)


# ── lifecycle helpers ────────────────────────────────────────────────────────

def created(module, c, reserve=RESERVE, credit=CREDIT, threshold=THRESHOLD,
            terms=TERMS, windows=(W, W, W, W)):
    as_(module, PROVIDER, reserve)
    return c.create_agreement(CLIENT, terms, threshold, str(credit),
                              windows[0], windows[1], windows[2], windows[3])


def active(module, c, **kw):
    aid = created(module, c, **kw)
    as_(module, CLIENT, 0)
    c.accept_agreement(aid)
    return aid


def opened(module, c, period="2026-08", **kw):
    aid = active(module, c, **kw)
    as_(module, CLIENT, 0)
    cid = c.open_case(aid, period)
    return aid, cid


def evidenced(module, c, items=None, acks=("EV-001",), **kw):
    """Commit the record and, by default, have the provider acknowledge the
    payment log — the corroborated posture of the canonical live arc. The
    authenticity floor makes an entirely unacknowledged, unanchored record
    non-payable by design; tests probing that path pass acks=()."""
    aid, cid = opened(module, c, **kw)
    as_(module, CLIENT, 0)
    c.commit_evidence(cid, json.dumps(items or demo_items()))
    for item_id in acks:
        as_(module, PROVIDER, 0)
        c.review_evidence(cid, item_id, "ACK")
    return aid, cid


def adjudicated(module, c, answer=None, items=None, **kw):
    aid, cid = evidenced(module, c, items=items, **kw)
    advance(W + 1)
    panel_says(answer or sla_answer())
    as_(module, STRANGER, 0)
    c.adjudicate(cid)
    return aid, cid


def final(module, c, **kw):
    aid, cid = adjudicated(module, c, **kw)
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.promote(cid)
    return aid, cid


def settled(module, c, **kw):
    aid, cid = final(module, c, **kw)
    advance(W + 1)
    as_(module, STRANGER, 0)
    c.settle(cid)
    return aid, cid
