import pytest

from src.ira.tools.log_explorer.catalog import DatasetCatalog, DatasetNotFoundError
from tests.fakes import FakeScrubber


@pytest.fixture(scope="module")
def catalog() -> DatasetCatalog:
    return DatasetCatalog(scrubber=FakeScrubber())  # type: ignore[arg-type]


def test_every_catalogued_dataset_has_logs_and_suggestions(catalog: DatasetCatalog) -> None:
    items = catalog.all()
    assert len(items) == 14
    for d in items:
        assert d["lines"] == 2000 and d["event_types"] > 0
        assert d["suggested_incidents"], d["name"]
        assert d["source_url"].startswith("https://github.com/logpai/loghub/tree/master/")
        assert "Label" not in d["columns"]


def test_logs_filtering_and_paging(catalog: DatasetCatalog) -> None:
    page = catalog.logs("OpenSSH", q="Failed password", limit=10)
    assert page["total"] >= 383 and len(page["lines"]) == 10
    assert all("Failed password" in line["content"] for line in page["lines"])
    assert page["lines"][0]["time"]
    bgl = catalog.logs("BGL", level="FATAL", limit=5)
    assert all(line["level"] == "FATAL" for line in bgl["lines"])


def test_templates_sorted_with_share(catalog: DatasetCatalog) -> None:
    templates = catalog.templates("Hadoop")
    counts = [t["count"] for t in templates]
    assert counts == sorted(counts, reverse=True)
    assert abs(sum(t["share"] for t in templates) - 1) < 0.01


def test_unknown_dataset(catalog: DatasetCatalog) -> None:
    with pytest.raises(DatasetNotFoundError):
        catalog.summary("../../etc")
