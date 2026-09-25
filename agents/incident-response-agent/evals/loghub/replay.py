import argparse
import asyncio
import json

from evals.loghub.builders.bgl import BGLBuilder


async def push_to_intake(case) -> None:
    """Mock pushing the incident to the Intake API"""
    payload = {
        "source": "eval",
        "title": case.incident.title,
        "description": case.incident.description,
        "environment": "prod",
        "severity": "sev2",
        "labels": case.incident.labels,
    }
    
    # Ideally, we would HTTP POST to localhost:8000/v1/incidents
    # For now, we'll just print
    print(f"Would push to API: {json.dumps(payload, indent=2)}")

def run_loki_replay(dataset: str, case_id: str, speed: float, inject_noise: bool):
    print(f"Running Loki mode replay for {dataset} case {case_id} at {speed}x speed. Inject noise: {inject_noise}")
    # TODO: Implement shifting timestamps, pushing to Loki, and POSTing the alert to intake API

async def run_file_replay_async(dataset: str, case_id: str, inject_noise: bool):
    print(f"Running File mode replay for {dataset} case {case_id}. Inject noise: {inject_noise}")
    
    if dataset.lower() == "bgl":
        builder = BGLBuilder()
        cases = builder.build_cases("data/loghub/2k/BGL/BGL_2k.log_structured.csv")
        
        target_case = next((c for c in cases if c.case_id == case_id), None)
        if not target_case:
            print(f"Case {case_id} not found.")
            return
            
        print(f"Found case {case_id}. Fault type: {target_case.ground_truth.fault_type}")
        await push_to_intake(target_case)
    else:
        print(f"Replay for dataset {dataset} is not fully implemented.")

def run_file_replay(dataset: str, case_id: str, inject_noise: bool):
    asyncio.run(run_file_replay_async(dataset, case_id, inject_noise))

def main():
    parser = argparse.ArgumentParser(description="Loghub Replay Harness")
    parser.add_argument("--dataset", type=str, required=True, help="Dataset name (e.g. Hadoop, BGL)")
    parser.add_argument("--case", type=str, required=True, help="Incident case ID")
    parser.add_argument("--speed", type=float, default=1.0, help="Replay speed for Loki mode")
    parser.add_argument("--backend", choices=["loki", "file"], default="file", help="Replay backend")
    parser.add_argument("--inject-noise", action="store_true", help="Inject unrelated windows")
    
    args = parser.parse_args()
    
    if args.backend == "loki":
        run_loki_replay(args.dataset, args.case, args.speed, args.inject_noise)
    else:
        run_file_replay(args.dataset, args.case, args.inject_noise)

if __name__ == "__main__":
    main()
