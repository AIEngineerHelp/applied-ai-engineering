from src.ira.knowledge.extract import build_dataset_graph, build_graph


def test_bgl_layout_and_errors_without_labels() -> None:
    g = build_dataset_graph("BGL")
    host = g.nodes["BGL:Host:R30-M0-N9-C:J16-U01"]
    assert host.props["errors"] == 60  # FATAL lines by level, not by ground-truth label
    for parent, child in [("BGL:Rack:R30", "BGL:Midplane:R30-M0"),
                          ("BGL:Midplane:R30-M0", "BGL:NodeCard:R30-M0-N9"),
                          ("BGL:NodeCard:R30-M0-N9", "BGL:Host:R30-M0-N9-C:J16-U01")]:
        assert g.edges[(parent, "CONTAINS", child)] == 1
    assert not any("Label" in str(n.props) for n in g.nodes.values())


def test_ssh_attack_graph() -> None:
    g = build_dataset_graph("OpenSSH")
    assert g.edges[("OpenSSH:IP:183.62.140.253", "FAILED_LOGIN", "OpenSSH:User:root")] > 500
    assert any(rel == "ACCEPTED_LOGIN" for _, rel, _ in g.edges)


def test_all_datasets_build_with_no_dangling_edges() -> None:
    from src.ira.tools.log_explorer.catalog import DatasetCatalog

    names = DatasetCatalog().names()
    g = build_graph(names)
    assert {n.name for n in g.nodes.values() if n.kind == "Dataset"} == set(names)
    assert all(s in g.nodes and t in g.nodes for s, _, t in g.edges)
