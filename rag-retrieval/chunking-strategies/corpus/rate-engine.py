"""Tidewater Freight rate engine.

Computes the price of a freight shipment from its weight, dimensions, service
level and lane. The engine is used by the quoting service (POST /v2/quotes) and
by the nightly invoice job, so both paths must produce identical numbers for the
same input. All money is handled as integer cents to avoid rounding drift.

Pricing pipeline, in order:
    1. Pick the billable weight (actual weight or dimensional weight).
    2. Look up the lane's base rate per kilogram.
    3. Apply the service-level multiplier.
    4. Add accessorial charges (liftgate, residential, hazmat handling).
    5. Add the fuel surcharge, which is a percentage of the line-haul charge.
    6. Apply the customer's contract discount, then the minimum charge.

Owner: pricing-platform team. Changes to constants require a pricing review.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from enum import Enum

# Divisor used to convert a parcel's volume in cubic centimetres into kilograms.
# Industry carriers use 5000 or 6000; Tidewater uses 5000 for all modes except sea.
DIM_WEIGHT_DIVISOR_CM3_PER_KG = 5000
SEA_DIM_WEIGHT_DIVISOR_CM3_PER_KG = 1000

# Fuel surcharge tiers: (diesel price ceiling in USD per gallon, surcharge percent).
# The surcharge applies to the line-haul charge only, never to accessorials.
FUEL_SURCHARGE_TIERS = [
    (3.25, 11.5),
    (3.75, 13.0),
    (4.25, 14.75),
    (4.75, 16.5),
    (5.25, 18.25),
]
FUEL_SURCHARGE_CAP_PERCENT = 21.0

# Every shipment is billed at least this amount after discounts, in cents.
MINIMUM_CHARGE_CENTS = 4_850

# Heaviest single piece the rate engine will quote; heavier freight goes to the
# project-cargo desk and is priced by hand.
MAX_PIECE_WEIGHT_KG = 1_360

# Accessorial charges in cents.
LIFTGATE_FEE_CENTS = 7_500
RESIDENTIAL_DELIVERY_FEE_CENTS = 4_200
HAZMAT_HANDLING_FEE_CENTS = 12_900
OVERSIZE_FEE_PER_PIECE_CENTS = 3_100
OVERSIZE_LENGTH_THRESHOLD_CM = 244


class ServiceLevel(Enum):
    """Service levels sold to customers."""

    ECONOMY = "economy"
    STANDARD = "standard"
    EXPEDITED = "expedited"
    PRIORITY_OVERNIGHT = "priority_overnight"


SERVICE_LEVEL_MULTIPLIERS = {
    ServiceLevel.ECONOMY: 0.82,
    ServiceLevel.STANDARD: 1.00,
    ServiceLevel.EXPEDITED: 1.45,
    ServiceLevel.PRIORITY_OVERNIGHT: 2.30,
}


class RateEngineError(Exception):
    """Raised when a shipment cannot be priced automatically."""


@dataclass(frozen=True)
class Piece:
    """One physical piece of a shipment. Dimensions are in centimetres."""

    weight_kg: float
    length_cm: float
    width_cm: float
    height_cm: float

    @property
    def volume_cm3(self) -> float:
        return self.length_cm * self.width_cm * self.height_cm


@dataclass
class Shipment:
    """A shipment to be priced."""

    lane_code: str
    service_level: ServiceLevel
    pieces: list[Piece]
    mode: str = "road"
    liftgate: bool = False
    residential: bool = False
    hazmat: bool = False
    ship_date: date = field(default_factory=date.today)


@dataclass
class Quote:
    """The priced result, with every component kept for the invoice."""

    billable_weight_kg: float
    line_haul_cents: int
    accessorial_cents: int
    fuel_surcharge_cents: int
    discount_cents: int
    total_cents: int
    notes: list[str] = field(default_factory=list)


def dimensional_weight_kg(piece: Piece, mode: str = "road") -> float:
    """Return the dimensional (volumetric) weight of a piece in kilograms.

    Volume in cubic centimetres is divided by the mode's divisor and rounded
    up to the next half kilogram, matching how carriers bill bulky freight.
    """
    divisor = SEA_DIM_WEIGHT_DIVISOR_CM3_PER_KG if mode == "sea" else DIM_WEIGHT_DIVISOR_CM3_PER_KG
    raw = piece.volume_cm3 / divisor
    return math.ceil(raw * 2) / 2


def billable_weight_kg(shipment: Shipment) -> float:
    """Return the billable weight: the greater of actual and dimensional weight.

    The comparison is made per piece, then summed, so one bulky piece cannot
    be hidden by a dense one in the same shipment.
    """
    total = 0.0
    for piece in shipment.pieces:
        validate_piece(piece)
        total += max(piece.weight_kg, dimensional_weight_kg(piece, shipment.mode))
    return round(total, 1)


def validate_piece(piece: Piece) -> None:
    """Reject pieces the engine is not allowed to quote."""
    if piece.weight_kg <= 0:
        raise RateEngineError("Piece weight must be positive")
    if piece.weight_kg > MAX_PIECE_WEIGHT_KG:
        raise RateEngineError(
            f"Piece of {piece.weight_kg} kg exceeds {MAX_PIECE_WEIGHT_KG} kg; route to the project-cargo desk"
        )
    if min(piece.length_cm, piece.width_cm, piece.height_cm) <= 0:
        raise RateEngineError("Piece dimensions must be positive")


def fuel_surcharge_percent(diesel_usd_per_gallon: float) -> float:
    """Look up the fuel surcharge percent for the weekly diesel index price.

    Prices above the last tier add 0.5 percentage points for every started
    25 cents, up to FUEL_SURCHARGE_CAP_PERCENT.
    """
    for ceiling, percent in FUEL_SURCHARGE_TIERS:
        if diesel_usd_per_gallon <= ceiling:
            return percent
    last_ceiling, last_percent = FUEL_SURCHARGE_TIERS[-1]
    steps = math.ceil((diesel_usd_per_gallon - last_ceiling) / 0.25)
    return min(last_percent + 0.5 * steps, FUEL_SURCHARGE_CAP_PERCENT)


def accessorial_charges_cents(shipment: Shipment) -> tuple[int, list[str]]:
    """Sum the accessorial fees for a shipment and explain each one."""
    cents = 0
    notes: list[str] = []
    if shipment.liftgate:
        cents += LIFTGATE_FEE_CENTS
        notes.append("liftgate")
    if shipment.residential:
        cents += RESIDENTIAL_DELIVERY_FEE_CENTS
        notes.append("residential delivery")
    if shipment.hazmat:
        if shipment.service_level is ServiceLevel.PRIORITY_OVERNIGHT:
            raise RateEngineError("Hazmat is not accepted on priority overnight service")
        cents += HAZMAT_HANDLING_FEE_CENTS
        notes.append("hazmat handling")
    oversize = [p for p in shipment.pieces if max(p.length_cm, p.width_cm, p.height_cm) > OVERSIZE_LENGTH_THRESHOLD_CM]
    if oversize:
        cents += OVERSIZE_FEE_PER_PIECE_CENTS * len(oversize)
        notes.append(f"oversize x{len(oversize)}")
    return cents, notes


def apply_contract_discount(cents: int, discount_percent: float) -> int:
    """Return the discount amount in cents for a contract discount percent.

    Discounts apply to line haul plus accessorials, but not to the fuel
    surcharge. Discounts above 40 percent need a signed pricing exception and
    are clamped here as a safety net.
    """
    clamped = max(0.0, min(discount_percent, 40.0))
    return int(round(cents * clamped / 100))


def round_half_up_cents(value: float) -> int:
    """Round a cent amount half up, the rule used on printed invoices."""
    return int(math.floor(value + 0.5))


class LaneRateTable:
    """In-memory table of base rates per lane, loaded from the service catalog."""

    def __init__(self, rates_usd_per_kg: dict[str, float]):
        self._rates = dict(rates_usd_per_kg)

    def base_rate_cents_per_kg(self, lane_code: str) -> int:
        """Return the lane's base rate in cents per kilogram."""
        try:
            return round_half_up_cents(self._rates[lane_code] * 100)
        except KeyError:
            raise RateEngineError(f"Unknown lane {lane_code!r}") from None

    def lanes(self) -> list[str]:
        return sorted(self._rates)


class RateCalculator:
    """Prices shipments. One instance is shared by the quote API and invoicing."""

    def __init__(self, table: LaneRateTable, diesel_usd_per_gallon: float):
        self.table = table
        self.diesel_usd_per_gallon = diesel_usd_per_gallon

    def line_haul_cents(self, shipment: Shipment, weight_kg: float) -> int:
        """Base rate times billable weight times the service-level multiplier."""
        base = self.table.base_rate_cents_per_kg(shipment.lane_code)
        multiplier = SERVICE_LEVEL_MULTIPLIERS[shipment.service_level]
        return round_half_up_cents(base * weight_kg * multiplier)

    def quote(self, shipment: Shipment, discount_percent: float = 0.0) -> Quote:
        """Price a shipment and return every component of the price."""
        if not shipment.pieces:
            raise RateEngineError("A shipment needs at least one piece")
        weight = billable_weight_kg(shipment)
        line_haul = self.line_haul_cents(shipment, weight)
        accessorials, notes = accessorial_charges_cents(shipment)
        fuel_percent = fuel_surcharge_percent(self.diesel_usd_per_gallon)
        fuel = round_half_up_cents(line_haul * fuel_percent / 100)
        discount = apply_contract_discount(line_haul + accessorials, discount_percent)
        total = line_haul + accessorials + fuel - discount
        if total < MINIMUM_CHARGE_CENTS:
            notes.append("minimum charge applied")
            total = MINIMUM_CHARGE_CENTS
        return Quote(
            billable_weight_kg=weight,
            line_haul_cents=line_haul,
            accessorial_cents=accessorials,
            fuel_surcharge_cents=fuel,
            discount_cents=discount,
            total_cents=total,
            notes=notes,
        )


def quote_many(calculator: RateCalculator, shipments: list[Shipment]) -> list[Quote | None]:
    """Price a batch of shipments; failed shipments yield None instead of raising.

    Used by the nightly invoice job so one bad shipment does not stop the run.
    """
    results: list[Quote | None] = []
    for shipment in shipments:
        try:
            results.append(calculator.quote(shipment))
        except RateEngineError:
            results.append(None)
    return results


def format_usd(cents: int) -> str:
    """Format integer cents as a US dollar string, e.g. 123456 -> '$1,234.56'."""
    sign = "-" if cents < 0 else ""
    dollars, rem = divmod(abs(cents), 100)
    return f"{sign}${dollars:,}.{rem:02d}"


def quote_summary(quote: Quote) -> str:
    """One-line human-readable summary used in quote emails."""
    parts = [
        f"billable {quote.billable_weight_kg} kg",
        f"line haul {format_usd(quote.line_haul_cents)}",
        f"fuel {format_usd(quote.fuel_surcharge_cents)}",
    ]
    if quote.accessorial_cents:
        parts.append(f"accessorials {format_usd(quote.accessorial_cents)}")
    if quote.discount_cents:
        parts.append(f"discount -{format_usd(quote.discount_cents)}")
    return "; ".join(parts) + f" = {format_usd(quote.total_cents)}"


def is_peak_season(ship_date: date) -> bool:
    """Peak season runs from 15 November to 5 January inclusive.

    The peak surcharge itself is applied by the invoice job, not here; this
    helper only lets the quote API warn customers in advance.
    """
    start = date(ship_date.year, 11, 15)
    end = date(ship_date.year + 1, 1, 5)
    early_january = date(ship_date.year, 1, 5)
    return start <= ship_date <= end or ship_date <= early_january
