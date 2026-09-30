import pytest

from judgelab import stats


def test_kappa_perfect_and_chance():
    assert stats.cohen_kappa(["pass", "fail"] * 5, ["pass", "fail"] * 5) == pytest.approx(1.0)
    # Same marginals, agreement no better than chance.
    a = ["pass", "pass", "fail", "fail"]
    b = ["pass", "fail", "pass", "fail"]
    assert stats.cohen_kappa(a, b) == pytest.approx(0.0)


def test_kappa_known_value():
    # 20 cases: both pass 12, both fail 4, a-pass/b-fail 3, a-fail/b-pass 1.
    a = ["pass"] * 12 + ["fail"] * 4 + ["pass"] * 3 + ["fail"] * 1
    b = ["pass"] * 12 + ["fail"] * 4 + ["fail"] * 3 + ["pass"] * 1
    # po = 0.8, pe = 0.75*0.65 + 0.25*0.35 = 0.575, kappa = 0.225/0.425
    assert stats.cohen_kappa(a, b) == pytest.approx(0.225 / 0.425)


def test_kappa_undefined_when_single_label():
    assert stats.cohen_kappa(["pass"] * 3, ["pass"] * 3) is None


def test_high_agreement_can_hide_low_kappa():
    # 90% agreement, but the judge passes everything: kappa is 0.
    human = ["pass"] * 9 + ["fail"]
    judge = ["pass"] * 10
    assert stats.agreement(human, judge) == pytest.approx(0.9)
    assert stats.cohen_kappa(human, judge) == pytest.approx(0.0)


def test_wilson_interval():
    lo, hi = stats.wilson(8, 10)
    assert lo == pytest.approx(0.490, abs=0.001) and hi == pytest.approx(0.943, abs=0.001)
    assert stats.wilson(0, 0) is None
    assert stats.wilson(10, 10)[1] == 1.0


def test_bootstrap_is_deterministic_and_brackets_estimate():
    a = ["pass"] * 12 + ["fail"] * 8
    b = ["pass"] * 10 + ["fail"] * 2 + ["fail"] * 7 + ["pass"]
    first = stats.bootstrap(a, b, stats.agreement)
    assert first == stats.bootstrap(a, b, stats.agreement)
    assert first[0] <= stats.agreement(a, b) <= first[1]


def test_confusion_rates():
    human = ["pass", "pass", "fail", "fail", "fail"]
    judge = ["pass", "fail", "pass", "fail", "fail"]
    c = stats.confusion(human, judge)
    assert (c["true_pass"], c["false_fail"], c["false_pass"], c["true_fail"]) == (1, 1, 1, 2)
    assert c["false_pass_rate"] == pytest.approx(1 / 3)
    assert c["false_fail_rate"] == pytest.approx(0.5)
