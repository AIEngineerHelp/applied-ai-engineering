"""Offline checks for the plain scikit-learn helpers in validation_lib.py."""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from sklearn.datasets import load_breast_cancer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import KFold, cross_val_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import validation_lib as vl

SAMPLE_CSV = Path(__file__).resolve().parent.parent / "sample_data" / "customer_churn_sample.csv"


def test_sample_csv_loads():
    data = vl.prepare_csv(pd.read_csv(SAMPLE_CSV), "churned")
    assert data.n_rows == 600
    assert len(data.class_names) == 2


def test_numeric_target_with_many_values_is_rejected():
    frame = pd.DataFrame({"a": range(50), "t": [i * 0.37 for i in range(50)]})
    with pytest.raises(ValueError):
        vl.prepare_csv(frame, "t")


@pytest.mark.parametrize(
    ("n_rows", "minority_share", "min_class_count", "method"),
    [
        (60, 0.5, 30, "LOOCV"),
        (500, 0.5, 250, "K-fold"),
        (1000, 0.05, 50, "Stratified K-fold"),
        (500_000, 0.5, 1, "Hold-out split"),
    ],
)
def test_advisor_recommendation(n_rows, minority_share, min_class_count, method):
    assert vl.advise(n_rows, minority_share, min_class_count).method == method


@pytest.mark.parametrize(
    ("n_rows", "minority_share"), [(60, 0.5), (500, 0.5), (1000, 0.05), (500_000, 0.5), (2_000_000, 0.02)]
)
def test_advisor_code_snippets_compile(n_rows, minority_share):
    advice = vl.advise(n_rows, minority_share, max(2, int(n_rows * minority_share)))
    compile(advice.code, "snippet", "exec")


def test_post_kfold_example_is_stable():
    """The article's code: scaler inside a Pipeline, KFold(5, shuffle, random_state=42)."""
    X, y = load_breast_cancer(return_X_y=True)
    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000))
    scores = cross_val_score(model, X, y, cv=KFold(5, shuffle=True, random_state=42), scoring="accuracy")
    # The post reports 0.974 0.982 0.965 0.991 0.973 (mean 0.977) on scikit-learn 1.9.1.
    assert np.allclose(scores.round(3), [0.974, 0.982, 0.965, 0.991, 0.973], atol=0.002)
    assert scores.mean().round(3) == pytest.approx(0.977, abs=0.002)


def test_feature_selection_leak_demo_fakes_accuracy_on_noise():
    leaky, honest = vl.feature_selection_leak_demo()
    assert leaky > 0.75  # labels were used to pick features before cross validation
    assert 0.35 < honest < 0.65  # inside the pipeline, noise stays noise
