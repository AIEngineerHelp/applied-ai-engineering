"""A mock clinic CRM with a fault switch.

It behaves like the third-party systems a voice agent is wired into: bearer auth,
paginated listings, idempotency keys on writes, and failures on demand: slow
responses, 500s, 429s with Retry-After, hangs, malformed records, and the nasty one,
a write that commits but whose response never arrives.

All patients are fictional. Run it alone with `uv run python -m voiceagent crm`.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

TZ = ZoneInfo("America/Chicago")
FaultMode = Literal[
    "none", "slow", "error_500", "rate_limit", "timeout", "bad_data", "down", "lost_response"
]
FAULT_MODES: list[str] = list(FaultMode.__args__)  # type: ignore[attr-defined]

PATIENTS: list[dict[str, Any]] = [
    {"id": "pt_1001", "first_name": "Priya", "last_name": "Sharma", "phone": "+15550142201",
     "date_of_birth": "1988-03-14", "primary_provider": "dr_rao"},
    {"id": "pt_1002", "first_name": "Arjun", "last_name": "Mehta", "phone": "+15550142202",
     "date_of_birth": "1975-11-02", "primary_provider": "dr_patel"},
    {"id": "pt_1003", "first_name": "Lakshmi", "last_name": "Iyer", "phone": "+15550142203",
     "date_of_birth": "1952-07-29", "primary_provider": "dr_rao"},
    {"id": "pt_1004", "first_name": "Rahul", "last_name": "Verma", "phone": "+15550142204",
     "date_of_birth": "1999-01-21", "primary_provider": "np_nair"},
]
PROVIDERS: dict[str, str] = {
    "dr_rao": "Dr. Ananya Rao",
    "dr_patel": "Dr. Ravi Patel",
    "np_nair": "Kavya Nair, NP",
}


class FaultConfig(BaseModel):
    mode: FaultMode = "none"
    # Fail only the next `count` matching requests (0 = every request, by probability).
    count: int = 0
    probability: float = 1.0
    # Restrict the fault to paths starting with this prefix, e.g. "/appointments".
    path_prefix: str = ""
    latency_ms: int = 2500


class NewAppointment(BaseModel):
    patient_id: str
    slot_id: str
    reason: str = ""


class AppointmentChange(BaseModel):
    slot_id: str


@dataclass
class CRMState:
    today: date
    seed: int = 7
    patients: list[dict[str, Any]] = field(default_factory=lambda: [dict(p) for p in PATIENTS])
    appointments: dict[str, dict[str, Any]] = field(default_factory=dict)
    idempotency: dict[str, tuple[int, dict[str, Any]]] = field(default_factory=dict)
    fault: FaultConfig = field(default_factory=FaultConfig)
    fault_remaining: int = 0
    requests: list[dict[str, Any]] = field(default_factory=list)
    next_id: int = 5001

    def __post_init__(self) -> None:
        self.rng = random.Random(self.seed)
        # Each seeded patient has one upcoming appointment to reschedule or cancel.
        for i, patient in enumerate(self.patients):
            slot = self.all_slots(patient["primary_provider"])[3 + i * 5]
            self._insert(patient["id"], slot["id"], "Annual check-up")

    def register(self, first_name: str, last_name: str, phone: str) -> dict[str, Any]:
        """Add a demo patient so a visitor can call as themselves. A number that is already
        on file returns that patient unchanged rather than renaming them."""
        existing = next((p for p in self.patients if p["phone"] == phone), None)
        if existing:
            return existing
        patient = {"id": f"pt_{2001 + len(self.patients) - len(PATIENTS)}",
                   "first_name": first_name, "last_name": last_name, "phone": phone,
                   "date_of_birth": "", "primary_provider": "dr_rao"}
        self.patients.append(patient)
        # Like the seeded patients, give them one visit to move or cancel.
        free = [s for s in self.all_slots("dr_rao") if s["id"] not in self.taken()]
        self._insert(patient["id"], free[len(self.patients) % 7]["id"], "Annual check-up")
        return patient

    def all_slots(self, provider: str | None = None) -> list[dict[str, Any]]:
        """Weekday 20-minute slots for the next 14 days, 9:00-16:40 local time."""
        slots = []
        for offset in range(1, 15):
            day = self.today + timedelta(days=offset)
            if day.weekday() >= 5:
                continue
            for pid in [provider] if provider else list(PROVIDERS):
                for minute in range(9 * 60, 17 * 60, 20):
                    start = datetime(day.year, day.month, day.day, minute // 60, minute % 60,
                                     tzinfo=TZ)
                    slots.append({
                        "id": f"sl_{pid}_{start:%Y%m%d%H%M}",
                        "provider_id": pid,
                        "provider_name": PROVIDERS[pid],
                        "start": start.isoformat(),
                        "duration_minutes": 20,
                    })
        return slots

    def taken(self) -> set[str]:
        return {a["slot_id"] for a in self.appointments.values() if a["status"] == "booked"}

    def slot(self, slot_id: str) -> dict[str, Any] | None:
        parts = slot_id.split("_")
        if len(parts) != 4 or parts[0] != "sl":
            return None
        provider = f"{parts[1]}_{parts[2]}"
        if provider not in PROVIDERS:
            return None
        return next((s for s in self.all_slots(provider) if s["id"] == slot_id), None)

    def _insert(self, patient_id: str, slot_id: str, reason: str) -> dict[str, Any]:
        slot = self.slot(slot_id)
        assert slot is not None
        appt = {
            "id": f"ap_{self.next_id}",
            "patient_id": patient_id,
            "slot_id": slot_id,
            "provider_id": slot["provider_id"],
            "provider_name": slot["provider_name"],
            "start": slot["start"],
            "reason": reason,
            "status": "booked",
        }
        self.next_id += 1
        self.appointments[appt["id"]] = appt
        return appt

    def should_fault(self, path: str) -> bool:
        fault = self.fault
        if fault.mode == "none" or not path.startswith(fault.path_prefix or "/"):
            return False
        if fault.count:
            if self.fault_remaining <= 0:
                return False
            self.fault_remaining -= 1
            return True
        return self.rng.random() < fault.probability


def create_app(state: CRMState | None = None, api_key: str = "dev-crm-key") -> FastAPI:
    app = FastAPI(title="Mock clinic CRM", docs_url="/docs")
    app.state.crm = state or CRMState(today=datetime.now(TZ).date())

    def crm(request: Request) -> CRMState:
        return request.app.state.crm  # type: ignore[no-any-return]

    async def auth(authorization: str = Header(default="")) -> None:
        if authorization != f"Bearer {api_key}":
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    @app.middleware("http")
    async def faults(request: Request, call_next: Any) -> Response:
        st: CRMState = request.app.state.crm
        path = request.url.path
        if path.startswith("/_admin") or path.startswith("/docs") or path == "/openapi.json":
            return await call_next(request)  # type: ignore[no-any-return]
        faulted = st.should_fault(path)
        mode = st.fault.mode if faulted else "none"
        st.requests.append({"at": datetime.now(TZ).isoformat(), "method": request.method,
                            "path": path, "fault": mode})
        if mode == "slow":
            await asyncio.sleep(st.fault.latency_ms / 1000)
        elif mode == "error_500":
            return JSONResponse({"error": "internal error"}, status_code=500)
        elif mode == "down":
            return JSONResponse({"error": "service unavailable"}, status_code=503)
        elif mode == "rate_limit":
            return JSONResponse({"error": "rate limited"}, status_code=429,
                                headers={"Retry-After": "1"})
        elif mode == "timeout":
            await asyncio.sleep(30)
        response: Response = await call_next(request)
        if mode == "lost_response":
            # The write has been committed; the caller just never hears about it.
            await asyncio.sleep(30)
        if mode == "bad_data":
            return JSONResponse({"data": [{"id": None, "start": "not-a-date"}],
                                 "first_name": 42}, status_code=200)
        return response

    @app.get("/patients", dependencies=[Depends(auth)])
    async def find_patient(phone: str, st: CRMState = Depends(crm)) -> dict[str, Any]:
        matches = [p for p in st.patients if p["phone"] == phone]
        return {"data": matches}

    @app.get("/patients/{patient_id}/appointments", dependencies=[Depends(auth)])
    async def patient_appointments(patient_id: str, st: CRMState = Depends(crm)) -> dict[str, Any]:
        rows = [a for a in st.appointments.values()
                if a["patient_id"] == patient_id and a["status"] == "booked"]
        return {"data": sorted(rows, key=lambda a: a["start"])}

    @app.get("/slots", dependencies=[Depends(auth)])
    async def list_slots(
        on: date | None = None,
        provider_id: str | None = None,
        limit: int = 8,
        cursor: str | None = None,
        st: CRMState = Depends(crm),
    ) -> dict[str, Any]:
        if provider_id and provider_id not in PROVIDERS:
            raise HTTPException(status_code=404, detail="unknown provider")
        taken = st.taken()
        rows = [s for s in st.all_slots(provider_id)
                if s["id"] not in taken and (on is None or s["start"][:10] == on.isoformat())]
        rows.sort(key=lambda s: (s["start"], s["provider_id"]))
        start = int(cursor) if cursor else 0
        page = rows[start:start + min(limit, 25)]
        nxt = start + len(page)
        return {"data": page, "next_cursor": str(nxt) if nxt < len(rows) else None}

    def idempotent(st: CRMState, key: str | None) -> tuple[int, dict[str, Any]] | None:
        if not key:
            raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
        return st.idempotency.get(key)

    @app.post("/appointments", status_code=201, dependencies=[Depends(auth)])
    async def book(
        body: NewAppointment,
        response: Response,
        idempotency_key: str | None = Header(default=None),
        st: CRMState = Depends(crm),
    ) -> dict[str, Any]:
        if (seen := idempotent(st, idempotency_key)) is not None:
            response.status_code = seen[0]
            response.headers["Idempotent-Replayed"] = "true"
            return seen[1]
        if not any(p["id"] == body.patient_id for p in st.patients):
            raise HTTPException(status_code=404, detail="unknown patient")
        if st.slot(body.slot_id) is None:
            raise HTTPException(status_code=404, detail="unknown slot")
        if body.slot_id in st.taken():
            raise HTTPException(status_code=409, detail="slot is no longer available")
        result = {"data": st._insert(body.patient_id, body.slot_id, body.reason)}
        st.idempotency[idempotency_key or ""] = (201, result)
        return result

    @app.patch("/appointments/{appointment_id}", dependencies=[Depends(auth)])
    async def reschedule(
        appointment_id: str,
        body: AppointmentChange,
        response: Response,
        idempotency_key: str | None = Header(default=None),
        st: CRMState = Depends(crm),
    ) -> dict[str, Any]:
        if (seen := idempotent(st, idempotency_key)) is not None:
            response.headers["Idempotent-Replayed"] = "true"
            return seen[1]
        appt = st.appointments.get(appointment_id)
        if appt is None or appt["status"] != "booked":
            raise HTTPException(status_code=404, detail="unknown appointment")
        slot = st.slot(body.slot_id)
        if slot is None:
            raise HTTPException(status_code=404, detail="unknown slot")
        if body.slot_id in st.taken():
            raise HTTPException(status_code=409, detail="slot is no longer available")
        appt.update(slot_id=slot["id"], provider_id=slot["provider_id"],
                    provider_name=slot["provider_name"], start=slot["start"])
        result = {"data": dict(appt)}
        st.idempotency[idempotency_key or ""] = (200, result)
        return result

    @app.delete("/appointments/{appointment_id}", dependencies=[Depends(auth)])
    async def cancel(
        appointment_id: str,
        idempotency_key: str | None = Header(default=None),
        st: CRMState = Depends(crm),
    ) -> dict[str, Any]:
        if (seen := idempotent(st, idempotency_key)) is not None:
            return seen[1]
        appt = st.appointments.get(appointment_id)
        if appt is None or appt["status"] != "booked":
            raise HTTPException(status_code=404, detail="unknown appointment")
        appt["status"] = "cancelled"
        result = {"data": dict(appt)}
        st.idempotency[idempotency_key or ""] = (200, result)
        return result

    # Admin endpoints drive the demo: the dashboard's fault switch and a reset.
    @app.get("/_admin/faults")
    async def get_fault(st: CRMState = Depends(crm)) -> dict[str, Any]:
        return {"fault": st.fault.model_dump(), "remaining": st.fault_remaining,
                "modes": FAULT_MODES}

    @app.put("/_admin/faults")
    async def set_fault(fault: FaultConfig, st: CRMState = Depends(crm)) -> dict[str, Any]:
        st.fault = fault
        st.fault_remaining = fault.count
        return {"fault": fault.model_dump(), "remaining": st.fault_remaining}

    @app.post("/_admin/reset")
    async def reset(request: Request) -> dict[str, str]:
        request.app.state.crm = CRMState(today=request.app.state.crm.today)
        return {"status": "reset"}

    @app.get("/_admin/requests")
    async def recent_requests(st: CRMState = Depends(crm)) -> dict[str, Any]:
        return {"data": st.requests[-50:]}

    return app
