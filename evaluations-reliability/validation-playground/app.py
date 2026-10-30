"""Validation Playground: a hands-on demo for the post
'Your Model Scored 97%, Then Failed on Real Data: How to Build and Test It the Right Way'
By Nagaraju Poralla
"""
import random

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import validation_lib as vl

# ------------------------------------------------------------------ page + style
st.set_page_config(page_title="Validation Playground", page_icon="🧪", layout="wide")

PASTEL = {
    "blue": "#A9C7F5", "mint": "#B5E2CF", "peach": "#FFD3B0", "pink": "#F6C4D8",
    "lavender": "#D3C6F2", "yellow": "#FBE9A8", "ink": "#2B3445", "grey": "#8892A6",
}
DEEP = {"blue": "#5B84D6", "mint": "#4FA787", "peach": "#E39358", "pink": "#D9719E", "lavender": "#8B72D1"}

st.markdown(
    f"""
<style>
html, body, [class*="css"] {{ font-size: 18px; }}
.block-container {{ padding-top: 2.2rem; max-width: 1250px; }}
h1 {{ font-size: 3rem !important; font-weight: 800 !important; color: {PASTEL['ink']}; letter-spacing: -0.5px; }}
.hero-sub {{ font-size: 1.3rem; color: #55607a; margin-top: -0.6rem; margin-bottom: 1.2rem; }}
.sec {{ border-radius: 18px; padding: 1.1rem 1.5rem 0.9rem 1.5rem; margin: 2.6rem 0 1rem 0; }}
.sec .num {{ display:inline-block; width: 2.3rem; height: 2.3rem; line-height: 2.3rem; text-align:center;
  border-radius: 50%; background: white; font-weight: 800; margin-right: .7rem; color: {PASTEL['ink']}; }}
.sec h2 {{ display:inline; font-size: 2rem; font-weight: 800; color: {PASTEL['ink']}; }}
.sec p {{ font-size: 1.15rem; color: #44506a; margin: .5rem 0 0 0; }}
.sec-blue {{ background: #EAF2FD; }} .sec-mint {{ background: #E8F6EF; }}
.sec-peach {{ background: #FFF1E4; }} .sec-lav {{ background: #F1ECFB; }} .sec-pink {{ background: #FDEAF2; }}
.card {{ background: #FFFFFF; border: 2px solid #E6EAF4; border-radius: 16px; padding: 1rem 1.3rem; }}
.col-title {{ font-size: 1.45rem; font-weight: 700; color: {PASTEL['ink']}; margin-bottom: .2rem; }}
.big-number {{ font-size: 3.2rem; font-weight: 800; line-height: 1.1; color: {PASTEL['ink']}; }}
.big-label {{ font-size: 1.05rem; color: #66718a; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }}
.callout {{ border-radius: 14px; padding: .9rem 1.2rem; font-size: 1.15rem; color: {PASTEL['ink']}; margin: .6rem 0; }}
.callout-yellow {{ background: #FEF6D3; }} .callout-mint {{ background: #E3F5EC; }}
.callout-pink {{ background: #FCE3EE; }} .callout-blue {{ background: #E4EEFC; }}
.badge {{ display:inline-block; background:#F1ECFB; color:#5B4A99; border-radius: 999px; padding: .25rem .9rem;
  font-weight: 700; font-size: 1rem; margin-right: .4rem; }}
.rec {{ font-size: 2.1rem; font-weight: 800; color: {PASTEL['ink']}; margin: .3rem 0 .6rem 0; }}
.footer {{ text-align:center; color: #6b7690; font-size: 1.05rem; padding: 2.2rem 0 1rem 0; margin-top: 3rem;
  border-top: 2px solid #EEF1F8; }}
.footer a {{ color: #5B84D6; text-decoration: none; font-weight: 700; }}
[data-testid="stSidebar"] {{ background: #F5F7FC; }}
[data-testid="stSidebar"] label p {{ font-size: 1.15rem !important; font-weight: 700 !important; color: {PASTEL['ink']}; }}
[data-testid="stWidgetLabel"] p {{ font-size: 1.1rem; font-weight: 600; }}
[data-testid="stMetricValue"] {{ font-size: 2.4rem; font-weight: 800; }}
[data-testid="stMetricLabel"] p {{ font-size: 1.05rem; font-weight: 600; color: #66718a; }}
.stButton > button {{ font-size: 1.15rem; font-weight: 700; border-radius: 12px; padding: .5rem 1.2rem;
  background: #E4EEFC; color: {PASTEL['ink']}; border: 2px solid #A9C7F5; }}
.stButton > button:hover {{ background: #D3E2FA; border-color: #7C9CF5; color: {PASTEL['ink']}; }}
</style>
""",
    unsafe_allow_html=True,
)


def section(num: int, title: str, sub: str, color: str):
    st.markdown(
        f'<div class="sec sec-{color}"><span class="num">{num}</span><h2>{title}</h2><p>{sub}</p></div>',
        unsafe_allow_html=True,
    )


def callout(text: str, color: str = "yellow"):
    st.markdown(f'<div class="callout callout-{color}">{text}</div>', unsafe_allow_html=True)


def style_fig(fig: go.Figure, height: int = 400, ytitle: str = "Score") -> go.Figure:
    fig.update_layout(
        template="simple_white", height=height, paper_bgcolor="white", plot_bgcolor="white",
        font=dict(size=16, color=PASTEL["ink"]), margin=dict(l=10, r=10, t=30, b=10),
        yaxis=dict(title=ytitle, gridcolor="#EEF1F8", showgrid=True, tickformat=".2f"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, x=0, font=dict(size=15)),
        bargap=0.25,
    )
    return fig


def y_range(*arrays, pad=0.04):
    allv = np.concatenate([np.asarray(a) for a in arrays])
    lo, hi = float(allv.min()), float(allv.max())
    return [max(0.0, lo - pad - 0.02), min(1.02, hi + pad * 0.6)]


# ------------------------------------------------------------------ cached work
@st.cache_data(show_spinner=False)
def cached_sample(name):
    return vl.load_sample(name)


@st.cache_data(show_spinner=False)
def cached_single(name_key, X, y, model, metric, test_size, stratified):
    return vl.single_split_scores(X, y, model, metric, test_size, stratified)


@st.cache_data(show_spinner=False)
def cached_one_split(name_key, X, y, model, metric, seed, test_size, stratified):
    return vl.single_split_score(X, y, model, metric, seed, test_size, stratified)


@st.cache_data(show_spinner=False)
def cached_kfold(name_key, X, y, model, metric, k, stratified):
    return vl.kfold_scores(X, y, model, metric, k, stratified)


@st.cache_data(show_spinner=False)
def cached_leaky(name_key, X, y, model, metric, k, stratified):
    return vl.leaky_scaling_scores(X, y, model, metric, k, stratified)


@st.cache_data(show_spinner=False)
def cached_noise_demo():
    return vl.feature_selection_leak_demo()


# ------------------------------------------------------------------ header
st.markdown("# 🧪 Validation Playground")
st.markdown(
    '<div class="hero-sub">Your model scored 97%, then failed on real data. Play with the settings below '
    "and see why one score can fool you, and how K-fold cross validation fixes it.</div>",
    unsafe_allow_html=True,
)

# ------------------------------------------------------------------ sidebar: choices
# The seed lives in a plain session value (not a widget key), so it survives when the slider is not drawn.
if "seed_value" not in st.session_state:
    st.session_state["seed_value"] = 42


def reshuffle():
    new = random.randint(0, 99)
    st.session_state["seed_value"] = new
    st.session_state["seed_widget"] = new


def seed_changed():
    st.session_state["seed_value"] = st.session_state["seed_widget"]


with st.sidebar:
    st.markdown("## 1. Pick your setup")
    source = st.radio("Data", ["Sample dataset", "Upload my CSV"], horizontal=True)
    data = None
    if source == "Sample dataset":
        ds_name = st.selectbox("Dataset", vl.SAMPLE_DATASETS)
        data = cached_sample(ds_name)
    else:
        up = st.file_uploader("CSV file", type=["csv"], help="Max 20 MB. One column must be the class to predict.")
        if up is not None:
            try:
                raw = pd.read_csv(up)
            except Exception as e:  # noqa: BLE001
                st.error(f"Could not read this file as CSV: {e}")
                raw = None
            if raw is not None:
                target = st.selectbox("Target column (what to predict)", list(raw.columns), index=len(raw.columns) - 1)
                try:
                    data = vl.prepare_csv(raw, target)
                except ValueError as e:
                    st.error(str(e))
        else:
            st.info("Upload a CSV, then choose the target column. Or try a sample dataset.")
            with open("sample_data/customer_churn_sample.csv", "rb") as f:
                st.download_button("Download a sample CSV to try", f, "customer_churn_sample.csv", "text/csv")
    model_name = st.selectbox("Model", vl.MODELS)
    metric_label = st.selectbox("Score", list(vl.METRICS), help="Balanced accuracy is fairer when one class is rare.")
    metric = vl.METRICS[metric_label]
    st.caption("Models run with scikit-learn defaults. Missing values are filled inside the pipeline.")

if data is None:
    st.stop()

X, y = data.X, data.y
n_classes = len(data.class_names)
min_count = int(data.class_counts.min())
key = f"{data.name}|{len(y)}|{X.shape[1]}|{int(y.sum())}|{float(np.nan_to_num(X.to_numpy()).sum()):.4f}"

with st.sidebar:
    stratified_ok = vl.can_stratify(y)
    stratified = st.toggle(
        "Stratified (keep class mix)", value=stratified_ok, disabled=not stratified_ok,
        help="Each split or fold keeps the same share of every class as the full data.",
    )
    kmax = vl.max_k(y, stratified)
    k = st.slider("k (number of folds)", 3, 10, min(5, max(3, kmax)), help="K-fold cuts the data into k parts.")
    if stratified and k > min_count:
        st.warning(f"The smallest class has only {min_count} rows, so k is lowered to {max(2, min_count)}.")
        k = max(2, min_count)
    test_size = st.slider("Single split: test share", 0.10, 0.50, 0.20, 0.05, format="%.2f")

# ------------------------------------------------------------------ data summary
c1, c2, c3, c4 = st.columns(4)
c1.metric("Rows", f"{data.n_rows_total:,}")
c2.metric("Features", X.shape[1])
c3.metric("Classes", n_classes)
c4.metric("Smallest class", f"{data.minority_share:.0%}")
if data.n_rows_total > vl.MAX_ROWS_FOR_DEMOS:
    callout(f"Your file has {data.n_rows_total:,} rows. For speed, sections 2 to 4 use a random {vl.MAX_ROWS_FOR_DEMOS:,}.", "blue")
if data.minority_share < 0.20 and metric == "accuracy":
    callout("Heads up: one class is rare. A model that always guesses the big class still gets a high "
            "<b>accuracy</b>. Try <b>Balanced accuracy</b> in the sidebar.", "yellow")

# ================================================================== 1. single vs kfold
section(1, "One split vs K-fold",
        "Same data, same model. Left: one train/test split. Right: K-fold. Which one would you trust?", "blue")

left, right = st.columns(2, gap="large")

with left:
    st.markdown('<div class="col-title">One train/test split</div>', unsafe_allow_html=True)
    b1, b2 = st.columns([1, 2])
    b1.button("🔀 Reshuffle", on_click=reshuffle, help="Pick a new random seed")
    seed = b2.slider("Seed (which rows go to test)", 0, 99, value=st.session_state["seed_value"],
                     key="seed_widget", on_change=seed_changed)
    with st.spinner("Training on 20 different splits..."):
        scores20 = cached_single(key, X, y, model_name, metric, test_size, stratified)
        my_score = cached_one_split(key, X, y, model_name, metric, seed, test_size, stratified)
    m1, m2 = st.columns(2)
    m1.metric(f"Score with seed {seed}", f"{my_score:.3f}")
    m2.metric("Range over 20 seeds", f"{scores20.min():.2f} to {scores20.max():.2f}")
    fig = go.Figure()
    colors = [DEEP["pink"] if i == seed else PASTEL["pink"] for i in range(vl.N_SEEDS)]
    fig.add_bar(x=[f"{i}" for i in range(vl.N_SEEDS)], y=scores20, marker_color=colors,
                marker_line_color=DEEP["pink"], marker_line_width=1.2, name="Score on that seed",
                hovertemplate="seed %{x}: %{y:.3f}<extra></extra>")
    fig.add_hline(y=my_score, line_dash="dash", line_color=PASTEL["ink"],
                  annotation_text=f"your seed ({seed})", annotation_position="top left",
                  annotation_font=dict(size=14))
    style_fig(fig, ytitle=metric_label)
    fig.update_xaxes(title="Random seed (20 different splits)")
    fig.update_yaxes(range=y_range(scores20, [my_score]))
    st.plotly_chart(fig, width="stretch", key="fig_single")
    st.caption(f"Only the seed changes. The model and data stay the same, yet the score moves by "
               f"{(scores20.max() - scores20.min()):.3f} (std {scores20.std():.3f}).")

with right:
    st.markdown('<div class="col-title">K-fold cross validation</div>', unsafe_allow_html=True)
    with st.spinner("Training on each fold..."):
        fold = cached_kfold(key, X, y, model_name, metric, k, stratified)
    m1, m2 = st.columns(2)
    m1.metric(f"Mean of {k} folds", f"{fold.mean():.3f}")
    m2.metric("Std (spread)", f"{fold.std():.3f}")
    fig = go.Figure()
    fig.add_bar(x=[f"Fold {i + 1}" for i in range(k)], y=fold, marker_color=PASTEL["mint"],
                marker_line_color=DEEP["mint"], marker_line_width=1.2, name="Fold score",
                text=[f"{s:.3f}" for s in fold], textposition="outside", textfont=dict(size=14),
                hovertemplate="%{x}: %{y:.3f}<extra></extra>")
    fig.add_hrect(y0=fold.mean() - fold.std(), y1=fold.mean() + fold.std(), fillcolor=PASTEL["yellow"],
                  opacity=0.45, line_width=0, annotation_text="mean ± std", annotation_position="top right",
                  annotation_font=dict(size=14))
    fig.add_hline(y=fold.mean(), line_dash="dash", line_color=PASTEL["ink"],
                  annotation_text=f"mean {fold.mean():.3f}", annotation_position="bottom right",
                  annotation_font=dict(size=14))
    style_fig(fig, ytitle=metric_label)
    fig.update_xaxes(title=f"Each fold is the test set once ({'stratified' if stratified else 'plain'} K-fold)")
    fig.update_yaxes(range=y_range(fold, scores20))
    st.plotly_chart(fig, width="stretch", key="fig_kfold")
    st.caption("Every row is used for testing exactly once. Report the mean, and the spread beside it.")

callout(
    f"<b>What to notice.</b> One split gave anything from <b>{scores20.min():.3f}</b> to <b>{scores20.max():.3f}</b> "
    f"depending on luck. K-fold reports <b>{fold.mean():.3f} ± {fold.std():.3f}</b>, a more honest answer with its "
    f"uncertainty shown.", "mint")

# ================================================================== 2. leakage
section(2, "Leakage: when the test data sneaks in",
        "Scaling learns the mean and spread of your data. If it sees the test rows, the score is no longer honest.", "pink")

mode = st.radio("Where does scaling happen?",
                ["Inside a Pipeline (correct)", "Before the split (leaks)"], horizontal=True, key="leak_mode")
leaky_on = mode.startswith("Before")
with st.spinner("Comparing both ways..."):
    good = cached_kfold(key, X, y, model_name, metric, k, stratified)
    leak = cached_leaky(key, X, y, model_name, metric, k, stratified)
diff = leak.mean() - good.mean()
shown, other = (leak, good) if leaky_on else (good, leak)

lc, rc = st.columns([3, 2], gap="large")
with lc:
    fig = go.Figure()
    x = [f"Fold {i + 1}" for i in range(k)]
    fig.add_bar(x=x, y=other, name="Pipeline (correct)" if leaky_on else "Before split (leaks)",
                marker_color="#EEF1F8", marker_line_color="#C9D0E2", marker_line_width=1.2)
    fig.add_bar(x=x, y=shown, name="Before split (leaks)" if leaky_on else "Pipeline (correct)",
                marker_color=PASTEL["pink"] if leaky_on else PASTEL["lavender"],
                marker_line_color=DEEP["pink"] if leaky_on else DEEP["lavender"], marker_line_width=1.2)
    fig.update_layout(barmode="group")
    style_fig(fig, height=380, ytitle=metric_label)
    fig.update_yaxes(range=y_range(good, leak))
    st.plotly_chart(fig, width="stretch", key="fig_leak")
with rc:
    st.metric("Score you are looking at", f"{shown.mean():.3f}")
    st.metric("Score difference (leaky − correct)", f"{diff:+.3f}",
              help="A positive number means the leaky way looks better than it should.")
    if model_name != "Logistic Regression":
        callout(f"<b>Why so small?</b> {model_name} does not care about the scale of a feature, so scaling "
                "leaks almost nothing here. Switch to Logistic Regression to see scaling matter more.", "blue")
    elif abs(diff) < 0.0005:
        callout("<b>No gap on this data.</b> The leak is real but tiny here. It grows with small data and "
                "with steps that look at the labels (see below).", "yellow")
    else:
        callout("The leaky score is a little off because the scaler already saw the test rows.", "yellow")

st.markdown(
    "**What happens.** With the leaky way, the scaler is fit on *all* rows, then you split. The test fold has "
    "already shaped the scaling. Inside a `Pipeline`, the scaler is refit on the training folds only, in every round. "
    "Scaling leaks only a little. The same mistake with steps that use the labels can leak a lot."
)

with st.expander("See a leak that really hurts: feature selection on pure noise", expanded=False):
    leaky_acc, honest_acc = cached_noise_demo()
    st.write("100 rows, 2,000 columns of random numbers, and random labels. No model can beat guessing (50%). "
             "Pick the 20 'best' columns first, then cross-validate:")
    n1, n2 = st.columns(2)
    n1.metric("Select features before CV (leaks)", f"{leaky_acc:.0%}")
    n2.metric("Select features inside the Pipeline", f"{honest_acc:.0%}")
    callout("The leaky number looks like a great model. It is built from noise. This is how a model scores "
            "97% in testing and fails on real data.", "pink")

c_a, c_b = st.columns(2)
with c_a:
    st.markdown("**Leaky (do not do this)**")
    st.code("X_s = StandardScaler().fit_transform(X)  # sees all rows\n"
            "cross_val_score(model, X_s, y, cv=cv)", language="python")
with c_b:
    st.markdown("**Correct**")
    st.code("pipe = make_pipeline(StandardScaler(), model)\n"
            "cross_val_score(pipe, X, y, cv=cv)  # refit per fold", language="python")

# ================================================================== 3. advisor
section(3, "Small data or large data?",
        "Tell me how much data you have. I will suggest how to test your model, with code.", "mint")

ac1, ac2, ac3 = st.columns(3)
adv_rows = ac1.number_input("Number of rows", min_value=10, max_value=100_000_000,
                            value=int(data.n_rows_total), step=100,
                            help="Starts at your dataset's row count. Change it to ask 'what if?'")
adv_minor = ac2.slider("Smallest class share", 0.01, 0.50, float(min(max(data.minority_share, 0.01), 0.50)), 0.01,
                       format="%.2f")
adv_min_count = max(2, int(round(adv_rows * adv_minor)))
ac3.metric("Smallest class rows (est.)", f"{adv_min_count:,}")
adv = vl.advise(int(adv_rows), float(adv_minor), adv_min_count, model_name)

st.markdown(f'<div class="rec">✅ {adv.headline}</div>' + "".join(f'<span class="badge">{b}</span>' for b in adv.badges),
            unsafe_allow_html=True)
for line in adv.why:
    st.markdown(f"- {line}")
st.markdown("**Code to copy**")
st.code(adv.code, language="python")

with st.expander("Rule of thumb used here (rough guides, not hard rules)"):
    st.markdown(
        "| Rows | Suggestion |\n|---|---|\n"
        "| 100 or fewer | LOOCV |\n"
        "| 100 to 100,000, classes fairly even | K-fold, k = 10 (under 1,000 rows) or 5 |\n"
        "| 100 to 100,000, smallest class under 20% | Stratified K-fold |\n"
        "| 100,000 or more | Hold-out split, 80/10/10 (98/1/1 for millions) |\n\n"
        "Even with K-fold, keep a small test set aside first and use it once at the end."
    )

# ================================================================== 4. your setup as code
section(4, "Your current setup as code",
        "The exact settings you picked above, ready to run.", "lav")
cv_cls = "StratifiedKFold" if stratified else "KFold"
model_ctor = {"Logistic Regression": "LogisticRegression(max_iter=2000)",
              "Random Forest": "RandomForestClassifier(n_estimators=100, random_state=0)",
              "Decision Tree": "DecisionTreeClassifier(random_state=0)"}[model_name]
model_imp = {"Logistic Regression": "from sklearn.linear_model import LogisticRegression",
             "Random Forest": "from sklearn.ensemble import RandomForestClassifier",
             "Decision Tree": "from sklearn.tree import DecisionTreeClassifier"}[model_name]
st.code(
    f"from sklearn.model_selection import {cv_cls}, cross_val_score\n"
    "from sklearn.pipeline import make_pipeline\n"
    "from sklearn.impute import SimpleImputer\n"
    "from sklearn.preprocessing import StandardScaler\n"
    f"{model_imp}\n\n"
    f"model = make_pipeline(SimpleImputer(strategy='median'), StandardScaler(), {model_ctor})\n"
    f"cv = {cv_cls}(n_splits={k}, shuffle=True, random_state=42)\n"
    f"scores = cross_val_score(model, X, y, cv=cv, scoring='{metric}')\n"
    f"print(scores.round(3), f'mean={{scores.mean():.3f}} std={{scores.std():.3f}}')\n"
    "model.fit(X, y)  # final model: retrain on all the data",
    language="python",
)

with st.expander("Peek at the data"):
    st.dataframe(X.assign(target=[data.class_names[i] for i in y]).head(50), width="stretch")

# ------------------------------------------------------------------ footer
st.markdown(
    '<div class="footer">By Nagaraju Poralla</div>',
    unsafe_allow_html=True,
)
