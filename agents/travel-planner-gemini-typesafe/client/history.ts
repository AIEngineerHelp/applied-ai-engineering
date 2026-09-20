const list = document.querySelector("#history-list");

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  );

const pretty = (value) =>
  String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

function render(records) {
  if (!records.length) {
    list.innerHTML = `
      <div class="history-empty">
        <span aria-hidden="true">⌁</span>
        <h2>No saved searches yet</h2>
        <p>Run your first comparison and it will appear here automatically.</p>
        <a class="primary history-cta" href="/">Open workspace <span>→</span></a>
      </div>`;
    return;
  }

  list.innerHTML = records
    .map((record) => {
      const trip = record.task ?? {};
      const days = Number.isInteger(trip.days) ? `${trip.days} day${trip.days === 1 ? "" : "s"}` : "Trip";
      const people = Number.isInteger(trip.people) ? `${trip.people} traveler${trip.people === 1 ? "" : "s"}` : "travelers";
      const budget = Number.isFinite(trip.budget) ? `₹${Number(trip.budget).toLocaleString("en-IN")} budget` : "Budget not recorded";
      const interests = Array.isArray(trip.interests) ? trip.interests.join(", ") : "";
      return `
        <a class="history-card" href="/?search=${encodeURIComponent(record.id)}">
          <div class="history-card-main">
            <span class="history-city">${escape(trip.city || "Trip")}</span>
            <span class="history-status status-${escape(record.status)}">${escape(pretty(record.status))}</span>
            <h2>${escape(days)} for ${escape(people)}</h2>
            <p>${budget} · ${escape(interests || "Open itinerary")}</p>
          </div>
          <div class="history-card-meta">
            <time datetime="${escape(record.createdAt)}">${escape(new Date(record.createdAt).toLocaleString())}</time>
            <span>Search #${escape(record.id.slice(0, 8).toUpperCase())} →</span>
          </div>
        </a>`;
    })
    .join("");
}

async function refreshHistory() {
  list.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) throw new Error("Could not load run history.");
    render(await response.json());
  } catch (error) {
    list.innerHTML = `<p class="history-error">${escape(error.message)}</p>`;
  } finally {
    list.removeAttribute("aria-busy");
  }
}

document.querySelector("#refresh-history").addEventListener("click", refreshHistory);
refreshHistory();
