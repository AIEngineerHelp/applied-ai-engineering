"""Run the Streamlit app headlessly with every dataset, model and option and check nothing raises."""
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

import validation_lib as vl

APP = str(Path(__file__).resolve().parent.parent / "app.py")

# The score choice only changes the metric, so try it on Logistic Regression alone.
COMBINATIONS = [
    (dataset, model, metric)
    for dataset in vl.SAMPLE_DATASETS
    for model in vl.MODELS
    for metric in vl.METRICS
    if metric == "Accuracy" or model == "Logistic Regression"
]


def slider(at, label):
    return next(s for s in at.slider if s.label == label)


def radio(at, label):
    return next(r for r in at.radio if r.label == label)


def new_app():
    return AppTest.from_file(APP, default_timeout=120).run()


@pytest.mark.parametrize("stratified", [True, False])
@pytest.mark.parametrize(("dataset", "model", "metric"), COMBINATIONS)
def test_every_dataset_model_and_score(dataset, model, metric, stratified):
    at = new_app()
    at.selectbox[0].set_value(dataset)
    at.selectbox[1].set_value(model)
    at.selectbox[2].set_value(metric)
    at.toggle[0].set_value(stratified)
    slider(at, "k (number of folds)").set_value(7)
    at = at.run()
    assert not at.exception, at.exception


def test_leak_switch():
    at = new_app()
    radio(at, "Where does scaling happen?").set_value("Before the split (leaks)").run()
    assert not at.exception


@pytest.mark.parametrize("k", [3, 10])
def test_k_range(k):
    at = new_app()
    slider(at, "k (number of folds)").set_value(k).run()
    assert not at.exception


def test_reshuffle_button():
    at = new_app()
    at.button[0].click().run()
    assert not at.exception
