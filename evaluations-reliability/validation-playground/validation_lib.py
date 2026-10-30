"""Helper functions for the Validation Playground.

Everything here is plain Python + scikit-learn so it can be tested without Streamlit.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.datasets import load_breast_cancer, load_iris, load_wine, make_classification
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_selection import SelectKBest, f_classif
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score
from sklearn.model_selection import KFold, StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeClassifier

SAMPLE_DATASETS = [
    "Breast cancer (569 rows)",
    "Wine (178 rows)",
    "Iris (150 rows)",
    "Synthetic imbalanced (1,000 rows, 5% positive)",
]
MODELS = ["Logistic Regression", "Random Forest", "Decision Tree"]
METRICS = {
    "Accuracy": "accuracy",
    "Balanced accuracy": "balanced_accuracy",
    "F1 (macro)": "f1_macro",
}
MAX_ROWS_FOR_DEMOS = 5000  # keep the app quick: validation demos use at most this many rows
N_SEEDS = 20  # number of random seeds in the "single split" chart


# --------------------------------------------------------------------------- data
@dataclass
class Dataset:
    name: str
    X: pd.DataFrame
    y: np.ndarray
    class_names: list[str]
    n_rows_total: int  # rows before any sampling for speed

    @property
    def n_rows(self) -> int:
        return len(self.y)

    @property
    def class_counts(self) -> np.ndarray:
        return np.bincount(self.y)

    @property
    def minority_share(self) -> float:
        counts = self.class_counts
        return float(counts.min() / counts.sum())


def load_sample(name: str) -> Dataset:
    if name.startswith("Breast"):
        d = load_breast_cancer(as_frame=True)
        X, y, names = d.data, d.target.to_numpy(), list(d.target_names)
    elif name.startswith("Wine"):
        d = load_wine(as_frame=True)
        X, y, names = d.data, d.target.to_numpy(), list(d.target_names)
    elif name.startswith("Iris"):
        d = load_iris(as_frame=True)
        X, y, names = d.data, d.target.to_numpy(), list(d.target_names)
    else:
        Xa, y = make_classification(
            n_samples=1000, n_features=12, n_informative=5, n_redundant=2,
            weights=[0.95, 0.05], flip_y=0.01, class_sep=0.9, random_state=7,
        )
        X = pd.DataFrame(Xa, columns=[f"feature_{i + 1}" for i in range(Xa.shape[1])])
        names = ["majority (0)", "minority (1)"]
    return Dataset(name.split(" (")[0], X, np.asarray(y), [str(n) for n in names], len(y))


def prepare_csv(df: pd.DataFrame, target: str) -> Dataset:
    """Turn an uploaded table into a classification Dataset. Raises ValueError with a plain message."""
    if target not in df.columns:
        raise ValueError(f"Column '{target}' was not found.")
    df = df.dropna(subset=[target]).copy()
    if len(df) < 10:
        raise ValueError("Need at least 10 rows with a value in the target column.")
    t = df[target]
    if pd.api.types.is_float_dtype(t) and t.nunique() > 20:
        raise ValueError(
            f"'{target}' looks like a number to predict (it has {t.nunique()} different values). "
            "This playground is for classification. Pick a column with a few classes, such as 0/1 or yes/no."
        )
    if t.nunique() > 50:
        raise ValueError(f"'{target}' has {t.nunique()} different values. Pick a column with fewer classes.")
    codes, uniques = pd.factorize(t, sort=True)
    X = df.drop(columns=[target])
    X = X.dropna(axis=1, how="all")
    # drop identifier-like text columns, one-hot the rest
    drop = [c for c in X.columns if X[c].dtype == object and X[c].nunique() > 30]
    X = X.drop(columns=drop)
    X = pd.get_dummies(X, drop_first=True, dtype=float)
    X = X.apply(pd.to_numeric, errors="coerce").astype(float)
    X = X.loc[:, X.notna().any()]
    X = X.loc[:, X.nunique(dropna=True) > 1]
    if X.shape[1] == 0:
        raise ValueError("No usable feature columns were found after cleaning.")
    X.columns = [str(c) for c in X.columns]
    counts = np.bincount(codes)
    keep_classes = np.where(counts >= 2)[0]
    if len(keep_classes) < 2:
        raise ValueError("Need at least 2 classes with 2 or more rows each.")
    mask = np.isin(codes, keep_classes)
    X, codes = X[mask].reset_index(drop=True), codes[mask]
    remap = {old: new for new, old in enumerate(keep_classes)}
    y = np.array([remap[c] for c in codes])
    names = [str(uniques[i]) for i in keep_classes]
    n_total = len(y)
    if n_total > MAX_ROWS_FOR_DEMOS:
        idx = np.random.RandomState(0).choice(n_total, MAX_ROWS_FOR_DEMOS, replace=False)
        X, y = X.iloc[idx].reset_index(drop=True), y[idx]
    return Dataset("Your CSV", X, y, names, n_total)


# ------------------------------------------------------------------------- models
def make_model(name: str):
    if name == "Logistic Regression":
        return LogisticRegression(max_iter=2000)
    if name == "Random Forest":
        return RandomForestClassifier(n_estimators=100, random_state=0, n_jobs=1)
    if name == "Decision Tree":
        return DecisionTreeClassifier(random_state=0)
    raise ValueError(name)


def make_pipeline_for(model_name: str, scale: bool = True) -> Pipeline:
    steps = [SimpleImputer(strategy="median")]
    if scale:
        steps.append(StandardScaler())
    steps.append(make_model(model_name))
    return make_pipeline(*steps)


def score_fn(metric: str):
    return {
        "accuracy": accuracy_score,
        "balanced_accuracy": balanced_accuracy_score,
        "f1_macro": lambda a, b: f1_score(a, b, average="macro"),
    }[metric]


def max_k(y: np.ndarray, stratified: bool, limit: int = 10) -> int:
    n = len(y)
    cap = min(limit, n)
    if stratified:
        cap = min(cap, int(np.bincount(y).min()))
    return max(cap, 2)


def can_stratify(y: np.ndarray) -> bool:
    return int(np.bincount(y).min()) >= 2


# ------------------------------------------------------------------- experiments
def single_split_score(X, y, model_name: str, metric: str, seed: int, test_size: float, stratified: bool) -> float:
    strat = y if (stratified and can_stratify(y)) else None
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=test_size, random_state=seed, stratify=strat)
    pipe = make_pipeline_for(model_name).fit(Xtr, ytr)
    return float(score_fn(metric)(yte, pipe.predict(Xte)))


def single_split_scores(X, y, model_name: str, metric: str, test_size: float, stratified: bool, seeds=range(N_SEEDS)):
    return np.array([single_split_score(X, y, model_name, metric, s, test_size, stratified) for s in seeds])


def make_cv(k: int, stratified: bool, seed: int = 42):
    cls = StratifiedKFold if stratified else KFold
    return cls(n_splits=k, shuffle=True, random_state=seed)


def kfold_scores(X, y, model_name: str, metric: str, k: int, stratified: bool) -> np.ndarray:
    pipe = make_pipeline_for(model_name)
    return cross_val_score(pipe, X, y, cv=make_cv(k, stratified), scoring=metric)


def leaky_scaling_scores(X, y, model_name: str, metric: str, k: int, stratified: bool) -> np.ndarray:
    """WRONG on purpose: impute + scale on ALL rows, then cross-validate."""
    Xs = SimpleImputer(strategy="median").fit_transform(X)
    Xs = StandardScaler().fit_transform(Xs)  # the scaler has seen every test row
    model = make_model(model_name)
    return cross_val_score(model, Xs, y, cv=make_cv(k, stratified), scoring=metric)


def feature_selection_leak_demo(n_rows: int = 100, n_features: int = 2000, keep: int = 20, seed: int = 0):
    """Pure-noise data: no model can truly beat 50%. Selecting features before CV makes it look like it can."""
    rng = np.random.RandomState(seed)
    X = rng.normal(size=(n_rows, n_features))
    y = rng.randint(0, 2, size=n_rows)
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=seed)
    model = LogisticRegression(max_iter=1000)
    Xsel = SelectKBest(f_classif, k=keep).fit_transform(X, y)  # looks at the labels of ALL rows
    leaky = cross_val_score(model, Xsel, y, cv=cv)
    honest = cross_val_score(make_pipeline(SelectKBest(f_classif, k=keep), LogisticRegression(max_iter=1000)), X, y, cv=cv)
    return float(leaky.mean()), float(honest.mean())


# ----------------------------------------------------------------------- advisor
@dataclass
class Advice:
    method: str
    headline: str
    why: list[str]
    code: str
    badges: list[str]


def advise(n_rows: int, minority_share: float, min_class_count: int, model_name: str = "Logistic Regression") -> Advice:
    imbalanced = minority_share < 0.20
    model_line = {
        "Logistic Regression": "LogisticRegression(max_iter=1000)",
        "Random Forest": "RandomForestClassifier(n_estimators=100, random_state=0)",
        "Decision Tree": "DecisionTreeClassifier(random_state=0)",
    }.get(model_name, "LogisticRegression(max_iter=1000)")
    imports = (
        "from sklearn.model_selection import {sel}\n"
        "from sklearn.pipeline import make_pipeline\n"
        "from sklearn.preprocessing import StandardScaler\n"
    )
    model_import = {
        "Logistic Regression": "from sklearn.linear_model import LogisticRegression\n",
        "Random Forest": "from sklearn.ensemble import RandomForestClassifier\n",
        "Decision Tree": "from sklearn.tree import DecisionTreeClassifier\n",
    }.get(model_name, "from sklearn.linear_model import LogisticRegression\n")
    pipe = f"model = make_pipeline(StandardScaler(), {model_line})  # scaler inside = no leakage\n"

    if n_rows >= 100_000:
        why = [
            f"You have {n_rows:,} rows. That is a lot, so one split gives a steady score.",
            "K-fold would train the model k times. That costs a lot and adds little.",
        ]
        if n_rows >= 1_000_000:
            why.append("With millions of rows, even 98/1/1 leaves tens of thousands of rows to test on.")
            split = "98/1/1"
            sizes = "test_size=0.02"
        else:
            split = "80/10/10"
            sizes = "test_size=0.20"
        if imbalanced:
            why.append("Classes are uneven, so keep the same class mix in every part (stratify).")
        strat = ", stratify=y" if imbalanced else ""
        code = (
            imports.format(sel="train_test_split")
            + model_import + "\n"
            + f"# {split} split: train / validation / test\n"
            + f"X_train, X_rest, y_train, y_rest = train_test_split(X, y, {sizes}{strat}, random_state=42)\n"
            + "X_val, X_test, y_val, y_test = train_test_split(X_rest, y_rest, test_size=0.5"
            + f"{strat.replace('stratify=y', 'stratify=y_rest')}, random_state=42)\n\n"
            + pipe
            + "model.fit(X_train, y_train)\n"
            + "print('Validation score:', model.score(X_val, y_val))  # tune with this\n"
            + "print('Test score:', model.score(X_test, y_test))      # use once, at the end\n"
        )
        return Advice("Hold-out split", f"Use a hold-out split ({split})", why, code,
                      ["Large data", "Hold-out", "Stratified" if imbalanced else "Plain split"])

    if n_rows <= 100:
        why = [
            f"You have only {n_rows:,} rows. Every row counts, so you cannot set many aside.",
            "Leave-one-out tests on exactly one row per round and trains on all the others.",
            "It is slow on big data, but with a few dozen rows it is fine.",
        ]
        if imbalanced:
            why.append(
                "Classes are uneven. LOOCV cannot be stratified, so also consider repeated stratified 5-fold "
                "and compare the two."
            )
        code = (
            imports.format(sel="LeaveOneOut, cross_val_score")
            + model_import + "\n"
            + pipe
            + "scores = cross_val_score(model, X, y, cv=LeaveOneOut(), scoring='accuracy')\n"
            + "print(f'LOOCV accuracy: {scores.mean():.3f}')  # each score is 0 or 1; the mean is what counts\n"
        )
        return Advice("LOOCV", "Use leave-one-out (LOOCV)", why, code, ["Tiny data", "LOOCV"])

    k = 10 if n_rows < 1000 else 5
    k = max(2, min(k, min_class_count)) if imbalanced else k
    if imbalanced:
        why = [
            f"You have {n_rows:,} rows, so cross validation is a good fit.",
            f"The smaller class is only {minority_share:.0%} of rows. A plain split could leave a fold with almost none.",
            "Stratified K-fold keeps the same class mix in every fold.",
        ]
        if min_class_count < 10:
            why.append(f"The smaller class has only {min_class_count} rows, so k is kept at {k} or lower.")
        code = (
            imports.format(sel="StratifiedKFold, cross_val_score")
            + model_import + "\n"
            + pipe
            + f"cv = StratifiedKFold(n_splits={k}, shuffle=True, random_state=42)\n"
            + "scores = cross_val_score(model, X, y, cv=cv, scoring='balanced_accuracy')  # not plain accuracy\n"
            + "print(scores.round(3), f'mean={scores.mean():.3f} std={scores.std():.3f}')\n"
        )
        return Advice("Stratified K-fold", f"Use stratified K-fold (k = {k})", why, code,
                      ["Small / medium data", "Imbalanced", "Stratified K-fold"])

    why = [
        f"You have {n_rows:,} rows. One split would be noisy, so use cross validation.",
        "Your classes are fairly even, so plain K-fold is fine. (Stratified is also safe for classification.)",
        f"k = {k} is a good default: every row is used for training and for testing.",
    ]
    if 20_000 <= n_rows < 100_000:
        why.append("At this size a hold-out split also works. Choose the one your compute budget allows.")
    code = (
        imports.format(sel="KFold, cross_val_score")
        + model_import + "\n"
        + pipe
        + f"cv = KFold(n_splits={k}, shuffle=True, random_state=42)\n"
        + "scores = cross_val_score(model, X, y, cv=cv, scoring='accuracy')\n"
        + "print(scores.round(3), f'mean={scores.mean():.3f} std={scores.std():.3f}')\n"
        + "model.fit(X, y)  # final step: retrain on all the data\n"
    )
    return Advice("K-fold", f"Use K-fold (k = {k})", why, code, ["Small / medium data", "K-fold"])
