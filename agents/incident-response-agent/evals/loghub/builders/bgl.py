import uuid

import yaml

from evals.loghub.parsers.bgl import BGLParser
from src.ira.cache.signature import compute_signature, get_signature_hash
from src.ira.models.incident import Incident

from .base import BaseBuilder, GroundTruth, IncidentCase


class BGLBuilder(BaseBuilder):
    def __init__(self, taxonomy_path: str = "evals/loghub/taxonomy.yaml"):
        with open(taxonomy_path, 'r') as f:
            self.taxonomy = yaml.safe_load(f).get('BGL', {})

    def build_cases(self, csv_file_path: str) -> list[IncidentCase]:
        parser = BGLParser()
        
        with open(csv_file_path, 'r') as f:
            csv_content = f.read()
            
        parsed_records = parser.parse_slice_csv(csv_content)
        
        # BGL is evaluated in sliding windows (e.g. 10 mins).
        # A simple algorithm to find cases: group anomalous lines by Node and Time window.
        # For this skeleton, we'll just group all anomalies by Node and create one case per Node with errors.
        
        node_anomalies = {}
        for record, label in parsed_records:
            if label != '-':
                node = record.host_or_node
                if node not in node_anomalies:
                    node_anomalies[node] = []
                node_anomalies[node].append((record, label))
                
        cases = []
        for node, anomalies in node_anomalies.items():
            first_anomaly = anomalies[0][0]
            first_label = anomalies[0][1]
            
            mapping = self.taxonomy.get(first_label) or {}
            fault_type = mapping.get("primary", "unknown")
            accepted = mapping.get("accepted", [fault_type])
            
            incident_id = uuid.uuid4()
            labels = {"alertname": "NodeError", "node": node, "dataset": "BGL"}
            signature = compute_signature(
                source="eval", service="", environment="prod", labels=labels,
                title=f"Node {node} reported errors",
                description=f"Automated alert: node {node} reported errors in the RAS log "
                            "stream.",
            )
            
            incident = Incident(
                id=incident_id,
                source="eval",
                title=f"Node {node} reported errors",
                description=f"Automated alert: node {node} reported errors in the RAS log "
                            "stream.",
                environment="prod",
                severity="sev2",
                labels=labels,
                started_at=first_anomaly.ts,
                received_at=first_anomaly.ts,
                raw_payload={},
                signature=signature,
                signature_hash=get_signature_hash(signature),
                status="new"
            )
            
            ground_truth = GroundTruth(
                fault_type=fault_type,
                accepted_fault_types=accepted,
                label=first_label,
                affected_components=[first_label],
                affected_nodes=[node],
                anomalous_templates=list(set([a[0].content for a in anomalies]))
            )
            
            # log slice would ideally be a window around the anomaly
            log_slice = [r[0] for r in parsed_records if r[0].host_or_node == node]
            
            case = IncidentCase(
                case_id=f"BGL_{node}_{first_anomaly.line_id}",
                dataset="BGL",
                incident=incident,
                log_slice=log_slice,
                ground_truth=ground_truth
            )
            cases.append(case)
            
        return cases
