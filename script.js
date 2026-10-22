"use strict";

let places = [];
let activeGroup = "all";
let currentProfile = "wheelchair";
let map = null;
let markerLayer = null;
let bestKey = null;      // top match of the last text search
let selectedKey = null;  // card/marker the user is looking at
let lastMsg = "";
let afterLogin = null;   // what to do right after login
let authMode = "login";
let lastFocus = null;
const markers = {};

const profiles = {
    wheelchair: {
        label: "Wheelchair User",
        short: "Wheelchair",
        weights: { ramp: 30, lift: 30, entrance: 20, restroom: 15, parking: 5 }
    },
    elderly: {
        label: "Senior Citizen",
        short: "Senior",
        weights: { ramp: 20, lift: 30, entrance: 15, restroom: 20, parking: 15 }
    },
    stroller: {
        label: "Stroller / Caregiver",
        short: "Stroller",
        weights: { ramp: 30, lift: 25, entrance: 25, restroom: 10, parking: 10 }
    }
};

const amenityNames = {
    ramp: "Ramp",
    lift: "Lift",
    entrance: "Step-free entrance",
    restroom: "Accessible restroom",
    parking: "Accessible parking"
};

const typeGroups = {
    hospital: ["hospital", "clinic", "doctors", "dentist", "pharmacy"],
    library: ["library"],
    bus: ["bus_station", "bus_stop", "platform"],
    railway: ["station", "halt", "railway_station", "tram_stop"],
    office: ["townhall", "government", "courthouse", "post_office", "public_building", "police"]
};

const grid = document.getElementById("facilityGrid");
const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const profileSelect = document.getElementById("profileSelect");
const resultCount = document.getElementById("resultCount");
const emptyState = document.getElementById("emptyState");
const clearSearch = document.getElementById("clearSearch");
const modal = document.getElementById("reportModal");
const authModal = document.getElementById("authModal");
const mineModal = document.getElementById("mineModal");
const searchStatus = document.getElementById("searchStatus");
const mapEl = document.getElementById("map");

const token = () => localStorage.getItem("aw_token") || "";

// ---------- HELPERS ----------

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };
        return entities[character];
    });
}

function normalizeAmenity(value) {
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
    return null;
}

function getProfile(key) {
    if (key === "custom") {
        const weights = {};
        document.querySelectorAll(".need:checked").forEach(box => {
            weights[box.value] = 1;
        });
        return {
            label: "Custom needs",
            short: "Custom",
            weights: Object.keys(weights).length ? weights : { ramp: 1 }
        };
    }
    return profiles[key] || profiles.wheelchair;
}

// Score = points earned out of the FULL weight total (like the PPT formula).
// Only confirmed "Yes" answers earn points. Unconfirmed items earn 0 until they are verified.
function calculateScore(place, profileKey) {
    const profile = getProfile(profileKey);
    const totalChecks = Object.keys(profile.weights).length;

    let earned = 0;
    let totalWeight = 0;
    let knownChecks = 0;

    for (const [amenity, weight] of Object.entries(profile.weights)) {
        const value = normalizeAmenity(place[amenity]);

        totalWeight += weight;

        if (value === null) continue;

        knownChecks += 1;

        if (value === true) earned += weight;
    }

    // Nothing confirmed at all: show no score (not 0, because 0 would wrongly look like "not accessible")
    if (knownChecks === 0) {
        return { score: null, knownChecks: 0, totalChecks };
    }

    return {
        score: Math.round((earned / totalWeight) * 100),
        knownChecks,
        totalChecks
    };
}

// Data completeness is separate from the score: how many of the 5 facts are confirmed
function confirmedCount(place) {
    return Object.keys(amenityNames).filter(key => normalizeAmenity(place[key]) !== null).length;
}

function statusFor(score) {
    if (score === null) return { label: "No accessibility data yet", cls: "medium" };
    if (score >= 80) return { label: "Accessible", cls: "good" };
    if (score >= 50) return { label: "Partially Accessible", cls: "medium" };
    return { label: "Limited Accessibility", cls: "low" };
}

function amenityRow(key, label, value) {
    const v = normalizeAmenity(value);
    const cls = v === true ? "yes" : v === false ? "no" : "unknown";
    const mark = v === true ? "✓" : v === false ? "×" : "?";
    const word = v === true ? "Yes" : v === false ? "No" : "Not confirmed";

    return `
        <div class="amenity ${cls}-row">
            <span class="${cls}" aria-hidden="true">${mark}</span>
            <span>${escapeHTML(label)}: <strong>${word}</strong></span>
        </div>`;
}

function completenessBlock(count) {
    const level = count >= 4 ? "full" : count >= 2 ? "part" : "low";
    const segs = [1, 2, 3, 4, 5]
        .map(i => `<span class="seg ${i <= count ? "on" : ""}"></span>`)
        .join("");

    return `
        <div class="complete ${level}">
            <div class="segs" aria-hidden="true">${segs}</div>
            <span>Information confirmed: <strong>${count} of 5</strong></span>
        </div>`;
}

function formatDate(value) {
    const date = new Date(String(value).replace(" ", "T"));

    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

function titleCase(text) {
    return String(text || "").replace(/\b\w/g, letter => letter.toUpperCase());
}

function setStatus(message) {
    lastMsg = message;
    searchStatus.textContent = message;
}

// ---------- MODALS (focus handled for keyboard users) ----------

function openModal(el) {
    lastFocus = document.activeElement;
    el.classList.remove("hidden");
    document.body.style.overflow = "hidden";

    const first = el.querySelector("select, input:not([type=hidden]), textarea, button:not(.modal-close)");
    (first || el.querySelector("button")).focus();
}

function closeModal(el) {
    el.classList.add("hidden");

    if (!document.querySelector(".modal-backdrop:not(.hidden)")) {
        document.body.style.overflow = "";
    }

    if (lastFocus && lastFocus.focus) lastFocus.focus();
}

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach(el => closeModal(el));
        return;
    }

    if (event.key === "Tab") {
        const open = document.querySelector(".modal-backdrop:not(.hidden)");
        if (!open) return;

        const items = [...open.querySelectorAll("button, input, select, textarea, a[href]")]
            .filter(item => !item.disabled && item.offsetParent !== null);

        if (!items.length) return;

        const first = items[0];
        const last = items[items.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }
});

// ---------- MAP ----------

function initMap() {
    if (map || typeof L === "undefined") return;

    map = L.map("map", { scrollWheelZoom: false }).setView([20.5, 78.9], 4);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
}

// focusKey = zoom straight to that place (the top match). Otherwise show all results.
function updateMarkers(list, focusKey) {
    initMap();

    if (!map) return;

    markerLayer.clearLayers();
    Object.keys(markers).forEach(key => delete markers[key]);

    const points = [];

    list.forEach(place => {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return;

        const marker = L.marker([place.latitude, place.longitude]).bindPopup(
            `<strong>${escapeHTML(place.name)}</strong><br>${escapeHTML(place.address)}`
        );

        marker.on("click", () => selectPlace(place.place_key, false, true));
        marker.addTo(markerLayer);
        markers[place.place_key] = marker;
        points.push([place.latitude, place.longitude]);
    });

    if (focusKey && markers[focusKey]) {
        const best = list.find(place => place.place_key === focusKey);
        map.setView([best.latitude, best.longitude], 16);
        markers[focusKey].openPopup();
    } else if (points.length) {
        map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    }
}

function showAllOnMap() {
    const points = Object.values(markers).map(marker => marker.getLatLng());

    if (map && points.length) {
        map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    }
}

// Highlight a card and (optionally) move the map to it
function selectPlace(key, moveMap, scrollCard) {
    selectedKey = key;

    document.querySelectorAll(".facility-card").forEach(card => {
        card.classList.toggle("selected-card", card.dataset.key === key);
    });

    const place = places.find(item => item.place_key === key);

    if (moveMap && place && markers[key] && map) {
        map.setView([place.latitude, place.longitude], 17);
        markers[key].openPopup();
    }

    if (scrollCard) {
        const card = [...document.querySelectorAll(".facility-card")].find(item => item.dataset.key === key);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
}

// ---------- MAP / LIST VIEW ----------

function setView(mode) {
    mapEl.classList.toggle("hidden", mode === "list");
    document.getElementById("fitAll").classList.toggle("hidden", mode === "list");
    document.getElementById("viewMap").setAttribute("aria-pressed", String(mode === "map"));
    document.getElementById("viewList").setAttribute("aria-pressed", String(mode === "list"));

    if (mode === "map" && map) setTimeout(() => map.invalidateSize(), 60);
}

document.getElementById("viewMap").addEventListener("click", () => setView("map"));
document.getElementById("viewList").addEventListener("click", () => setView("list"));
document.getElementById("fitAll").addEventListener("click", showAllOnMap);

// ---------- MESSAGES ----------

function showMessage(title, text) {
    document.getElementById("emptyTitle").textContent = title;
    document.getElementById("emptyText").textContent = text;
    emptyState.classList.remove("hidden");
    grid.classList.add("hidden");
    resultCount.textContent = "0";
}

// ---------- RENDER CARDS ----------

function renderPlaces(refitMap = true) {
    const group = typeGroups[activeGroup];

    const filtered = places.filter(place =>
        activeGroup === "all" || (group && group.includes(place.raw_type))
    );

    resultCount.textContent = filtered.length;

    if (filtered.length === 0) {
        if (places.length === 0) {
            showMessage(
                "Search any place in the world",
                "Type a name above, for example KMC Hospital Manipal."
            );
        } else {
            showMessage(
                "No places in this category",
                "Choose All Places to see every result."
            );
        }

        if (refitMap) updateMarkers([]);
        return;
    }

    emptyState.classList.add("hidden");
    grid.classList.remove("hidden");

    const profileLabel = getProfile(currentProfile).label;

    grid.innerHTML = filtered.map(place => {
        const result = calculateScore(place, currentProfile);
        const status = statusFor(result.score);
        const confirmed = confirmedCount(place);

        let ringClass = "";
        if (result.score === null || status.cls === "medium") ringClass = "medium";
        else if (status.cls === "low") ringClass = "low";

        const scoreText = result.score === null ? "—" : result.score;
        const decisionClass = status.cls === "medium" ? "mid" : status.cls;

        const amenities = Object.entries(amenityNames)
            .map(([key, label]) => amenityRow(key, label, place[key]))
            .join("");

        const missing = Object.entries(amenityNames)
            .filter(([key]) => normalizeAmenity(place[key]) === null)
            .map(([, label]) => label);

        const missingText = confirmed > 0 && missing.length
            ? `<p class="missing">Not confirmed yet: ${escapeHTML(missing.join(", "))}</p>`
            : "";

        const partial = confirmed > 0 && confirmed < 5
            ? `<p class="partial-warning">⚠ Only ${confirmed} of 5 checks are confirmed. Unconfirmed items add 0 points until verified, so this score can only go up.</p>`
            : "";

        const compare = confirmed > 0
            ? `<div class="compare" aria-label="Score for each profile">${
                Object.keys(profiles).map(key => {
                    const r = calculateScore(place, key);
                    return `<span class="cmp ${key === currentProfile ? "on" : ""}">${profiles[key].short} <strong>${r.score === null ? "—" : r.score}</strong></span>`;
                }).join("")
            }</div>`
            : "";

        let sourceText;
        if (place.source === "verified") {
            sourceText = `<span class="vbadge">✓ Verified by AccessWay</span>` +
                (place.verified_at ? ` · last verified ${escapeHTML(formatDate(place.verified_at))}` : "");
        } else if (confirmed > 0) {
            sourceText = `<span class="vbadge osm">Community data (OpenStreetMap)</span> · not yet checked by AccessWay`;
        } else {
            sourceText = `<span class="vbadge pending">Unverified · no data yet</span>`;
        }

        let stateBadge;
        if (place.source === "verified") {
            stateBadge = `<span class="need-badge ok">✓ Verified</span>`;
        } else if (confirmed > 0) {
            stateBadge = `<span class="need-badge part">Community data · not verified</span>`;
        } else {
            stateBadge = `<span class="need-badge none">⏳ Pending verification</span>`;
        }

        const emptyCta = confirmed === 0
            ? `<p class="empty-cta">No accessibility details are recorded yet. Be the first to report what you see here, and an admin will verify it.</p>`
            : "";

        const noteLabel = place.source === "verified" ? "Source note" : "Mapper note";
        const note = place.note
            ? `<p class="place-note"><strong>${noteLabel}:</strong> ${escapeHTML(place.note)}</p>`
            : "";

        const distance = place.distance_m != null
            ? `<p class="location">📍 ${(place.distance_m / 1000).toFixed(1)} km away</p>`
            : "";

        const topBadge = place.place_key === bestKey
            ? `<span class="best-badge">Top match</span>`
            : "";

        return `
            <article class="facility-card${place.place_key === selectedKey ? " selected-card" : ""}"
                     data-key="${escapeHTML(place.place_key)}">

                <div class="facility-top">
                    <div class="facility-symbol" aria-hidden="true">⌖</div>
                    <div class="top-tags">
                        ${topBadge}
                        ${stateBadge}
                        <span class="type-label">${escapeHTML(titleCase(place.type))}</span>
                    </div>
                </div>

                <div class="facility-body">

                    <div class="facility-title-row">
                        <div>
                            <h3>${escapeHTML(place.name)}</h3>
                            <p class="location" title="${escapeHTML(place.address)}">⌖ ${escapeHTML(place.address)}</p>
                            ${distance}
                        </div>

                        <div class="score-ring ${ringClass}"
                             aria-label="Score ${scoreText} out of 100 for ${escapeHTML(profileLabel)}, using ${result.knownChecks} confirmed checks">
                            ${scoreText}
                        </div>
                    </div>

                    <div class="score-caption">Score for ${escapeHTML(profileLabel)}</div>

                    ${completenessBlock(confirmed)}

                    <p class="decision ${decisionClass}">${escapeHTML(status.label)}</p>

                    ${emptyCta}
                    ${partial}
                    ${compare}
                    ${note}

                    <div class="amenities">${amenities}</div>

                    ${missingText}

                    <div class="card-bottom">
                        <span class="verified-date">${sourceText}</span>
                    </div>

                    <div class="card-actions">
                        <button class="details-btn" type="button"
                                data-map="${escapeHTML(place.place_key)}">Show on map</button>
                        <button class="details-btn" type="button"
                                data-report="${escapeHTML(place.place_key)}">Report update</button>
                    </div>

                </div>

            </article>
        `;
    }).join("");

    if (refitMap) {
        const focus = filtered.some(p => p.place_key === bestKey) ? bestKey : null;
        updateMarkers(filtered, focus);
    }
}

// ---------- SEARCH ----------

async function searchPlaces(query) {
    const q = query.trim();

    if (q.length < 3) {
        showToast("Type at least 3 letters.");
        return;
    }

    emptyState.classList.add("hidden");
    grid.classList.remove("hidden");
    grid.innerHTML = '<p class="loading">Searching…</p>';
    setStatus("Searching…");

    try {
        const response = await fetch("/api/places/search?q=" + encodeURIComponent(q));
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.success) {
            throw new Error(data.message || "Search failed.");
        }

        places = data.places;
        bestKey = null;
        selectedKey = null;

        if (places.length === 0) {
            setStatus(`No places found for “${q}”.`);
            showMessage(
                "No places found",
                "Check the spelling, or add the city, for example KMC Hospital Manipal."
            );
            updateMarkers([]);
            return;
        }

        bestKey = places[0].place_key;
        selectedKey = bestKey;

        const sameName = places.filter(
            place => place.name.toLowerCase() === places[0].name.toLowerCase()
        ).length;

        let message = `Showing ${places.length} result${places.length > 1 ? "s" : ""} for “${q}”. ` +
            `Top match: ${places[0].name}.`;

        if (sameName > 1) {
            message += ` ${sameName} places share this name, so check the address on each card.`;
        }

        setStatus(message);
        renderPlaces(true);

        if (mapEl.scrollIntoView) mapEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

    } catch (error) {
        console.error("Search error:", error);
        places = [];
        setStatus("Search is unavailable right now.");
        showMessage("Search is unavailable", error.message + " Please try again.");
    }
}

searchForm.addEventListener("submit", event => {
    event.preventDefault();
    searchPlaces(searchInput.value);
});

searchInput.addEventListener("input", () => {
    clearSearch.style.display = searchInput.value ? "block" : "none";
});

clearSearch.addEventListener("click", () => {
    searchInput.value = "";
    clearSearch.style.display = "none";
    searchInput.focus();
});

document.querySelectorAll(".example").forEach(button => {
    button.addEventListener("click", () => {
        searchInput.value = button.dataset.example;
        clearSearch.style.display = "block";
        searchPlaces(button.dataset.example);
    });
});

// ---------- PROFILE (scores are recalculated on every change) ----------

profileSelect.addEventListener("change", () => {
    currentProfile = profileSelect.value;
    document.getElementById("needs").classList.toggle("hidden", currentProfile !== "custom");
    renderPlaces(false);

    if (places.length) {
        setStatus(`${lastMsg.split(" Scores shown")[0]} Scores shown for ${getProfile(currentProfile).label}.`);
    }
});

document.querySelectorAll(".need").forEach(box => {
    box.addEventListener("change", () => renderPlaces(false));
});

// ---------- CATEGORY FILTERS ----------

document.querySelectorAll(".filter-chip[data-type]").forEach(button => {
    button.addEventListener("click", () => {
        document.querySelectorAll(".filter-chip[data-type]").forEach(item => {
            item.classList.remove("selected");
            item.setAttribute("aria-pressed", "false");
        });

        button.classList.add("selected");
        button.setAttribute("aria-pressed", "true");
        activeGroup = button.dataset.type || "all";

        if (places.length) renderPlaces(true);
    });
});

// ---------- NEAR ME ----------

document.getElementById("nearBtn").addEventListener("click", () => {
    if (!navigator.geolocation) {
        showToast("Location is not supported in this browser.");
        return;
    }

    navigator.geolocation.getCurrentPosition(async pos => {
        const kinds = {
            all: "hospital",
            hospital: "hospital",
            library: "library",
            bus: "bus station",
            railway: "railway station",
            office: "post office"
        };

        emptyState.classList.add("hidden");
        grid.classList.remove("hidden");
        grid.innerHTML = '<p class="loading">Finding places near you…</p>';

        try {
            const response = await fetch(
                `/api/places/nearby?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}&kind=${encodeURIComponent(kinds[activeGroup])}`
            );
            const data = await response.json().catch(() => ({}));

            if (!response.ok || !data.success) {
                throw new Error(data.message || "Search failed.");
            }

            places = data.places;
            bestKey = null;
            selectedKey = null;

            if (!places.length) {
                setStatus("Nothing found near you for this category.");
                showMessage("Nothing found nearby", "Try another category.");
                updateMarkers([]);
                return;
            }

            setStatus(`Showing ${places.length} places near you, closest first.`);
            renderPlaces(true);
        } catch (error) {
            setStatus("Nearby search failed.");
            showMessage("Nearby search failed", error.message);
        }
    }, () => showToast("Allow location access to find places near you."));
});

// ---------- CARD BUTTONS ----------

grid.addEventListener("click", event => {
    const mapButton = event.target.closest("[data-map]");
    const reportButton = event.target.closest("[data-report]");

    if (mapButton) {
        setView("map");
        selectPlace(mapButton.dataset.map, true, false);
        mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    if (reportButton) {
        openReportModal(reportButton.dataset.report);
    }
});

// ---------- LOGIN ----------

function openAuth() {
    openModal(authModal);
}

function setAuthMode(mode) {
    authMode = mode;
    const register = mode === "register";

    document.getElementById("nameRow").classList.toggle("hidden", !register);
    document.getElementById("authTitle").textContent =
        register ? "Create your account" : "Log in to continue";
    document.getElementById("authSubmit").textContent =
        register ? "Create account" : "Log in";
    document.getElementById("authSwitch").textContent =
        register ? "Have an account? Log in" : "New here? Create an account";
}

document.getElementById("authSwitch").addEventListener("click", event => {
    event.preventDefault();
    setAuthMode(authMode === "login" ? "register" : "login");
});

document.getElementById("authClose").addEventListener("click", () => closeModal(authModal));

document.getElementById("authForm").addEventListener("submit", async event => {
    event.preventDefault();

    const errorBox = document.getElementById("authError");
    errorBox.textContent = "";

    try {
        const response = await fetch("/api/auth/" + authMode, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: document.getElementById("authName").value,
                email: document.getElementById("authEmail").value,
                password: document.getElementById("authPass").value
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            errorBox.textContent = data.message || "Something went wrong. Please try again.";
            return;
        }

        localStorage.setItem("aw_token", data.token);
        closeModal(authModal);
        showToast("Welcome, " + data.name);

        if (afterLogin) {
            const next = afterLogin;
            afterLogin = null;
            next();
        }
    } catch (error) {
        errorBox.textContent = "Could not reach the server. Please try again.";
    }
});

// ---------- PHOTO (resized in the browser) ----------

function readPhoto(file) {
    return new Promise(resolve => {
        if (!file) return resolve("");

        const img = new Image();
        const url = URL.createObjectURL(file);

        img.onload = () => {
            const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL("image/jpeg", 0.7));
        };

        img.onerror = () => resolve("");
        img.src = url;
    });
}

// ---------- REPORT MODAL ----------

function openReportModal(placeKey) {
    if (!token()) {
        afterLogin = () => openReportModal(placeKey);
        openAuth();
        return;
    }

    if (places.length === 0) {
        showToast("Search for a place first, then report an update.");
        return;
    }

    const select = document.getElementById("reportFacility");

    select.innerHTML = `
        <option value="">Choose a place</option>
        ${places.map(place => `
            <option value="${escapeHTML(place.place_key)}">${escapeHTML(place.name)} — ${escapeHTML(place.address.split(",").slice(1, 3).join(","))}</option>
        `).join("")}
    `;

    if (typeof placeKey === "string") select.value = placeKey;

    document.getElementById("reportError").textContent = "";
    document.getElementById("reportForm").classList.remove("hidden");
    document.getElementById("reportSuccess").classList.add("hidden");

    openModal(modal);
}

function closeReportModal() {
    closeModal(modal);
}

document.getElementById("navReport").addEventListener("click", () => openReportModal());
document.getElementById("ctaReport").addEventListener("click", () => openReportModal());
document.getElementById("modalClose").addEventListener("click", closeReportModal);
document.getElementById("successDone").addEventListener("click", closeReportModal);

modal.addEventListener("click", event => {
    if (event.target === modal) closeReportModal();
});

document.getElementById("reportForm").addEventListener("submit", async event => {
    event.preventDefault();

    const errorBox = document.getElementById("reportError");
    errorBox.textContent = "";

    const placeKey = document.getElementById("reportFacility").value;
    const place = places.find(item => item.place_key === placeKey);
    const type = document.getElementById("reportType").value;
    const details = document.getElementById("reportDetails").value.trim();

    if (!place || !type || !details) {
        errorBox.textContent = "Please choose a place, what changed, and add a few details.";
        return;
    }

    const submitButton = event.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "Sending…";

    try {
        const photo = await readPhoto(document.getElementById("reportPhoto").files[0]);

        const response = await fetch("/api/reports", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token()
            },
            body: JSON.stringify({
                place_key: place.place_key,
                place_name: place.name,
                latitude: place.latitude,
                longitude: place.longitude,
                report_type: type,
                details: details,
                photo: photo
            })
        });

        if (response.status === 401) {
            localStorage.removeItem("aw_token");
            closeReportModal();
            afterLogin = () => openReportModal(place.place_key);
            openAuth();
            return;
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.message || "Report could not be saved.");
        }

        document.getElementById("reportResult").innerHTML = `
            <p><strong>Report #${escapeHTML(data.id)}</strong> saved for <strong>${escapeHTML(place.name)}</strong>.</p>
            <p>Status: <span class="status-chip pending">Pending admin review</span></p>
            <p>Rule-based classification: <strong>${escapeHTML(data.category)} · ${escapeHTML(data.issue)}</strong> (confidence ${escapeHTML(data.confidence)}%)</p>
            ${data.duplicate ? "<p>A similar report is already waiting, so the admin will see both together.</p>" : ""}
            <p class="hint">This is only a suggestion. The hospital card changes after an admin checks and approves it.</p>
        `;

        document.getElementById("reportForm").reset();
        document.getElementById("reportForm").classList.add("hidden");
        document.getElementById("reportSuccess").classList.remove("hidden");
        document.getElementById("successDone").focus();

    } catch (error) {
        console.error("Report submission error:", error);
        errorBox.textContent = (error.message || "Report could not be saved.") + " Nothing was lost, so please try again.";
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Submit for Review →";
    }
});

// ---------- MY REPORTS (follow a report from pending to verified) ----------

async function openMine() {
    if (!token()) {
        afterLogin = openMine;
        openAuth();
        return;
    }

    const list = document.getElementById("mineList");
    list.innerHTML = "<p>Loading…</p>";
    openModal(mineModal);

    try {
        const response = await fetch("/api/reports/mine", {
            headers: { "Authorization": "Bearer " + token() }
        });

        if (response.status === 401) {
            localStorage.removeItem("aw_token");
            closeModal(mineModal);
            afterLogin = openMine;
            openAuth();
            return;
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.success) {
            throw new Error(data.message || "Could not load your reports.");
        }

        if (!data.reports.length) {
            list.innerHTML = "<p>You have not sent any reports yet.</p>";
            return;
        }

        const words = {
            pending: "Pending admin review",
            verified: "Verified: the listing was updated",
            rejected: "Rejected by the admin"
        };

        list.innerHTML = data.reports.map(r => `
            <div class="mine-item">
                <strong>${escapeHTML(r.place_name)}</strong>
                <span class="status-chip ${escapeHTML(r.status)}">${escapeHTML(words[r.status] || r.status)}</span>
                <small>#${escapeHTML(r.id)} · ${escapeHTML(r.report_type)} · ${escapeHTML(formatDate(r.created_at))}</small>
                <small>Rule-based classification: ${escapeHTML(r.parsed_text || "—")}</small>
            </div>
        `).join("");
    } catch (error) {
        list.innerHTML = `<p role="alert">${escapeHTML(error.message)}</p>`;
    }
}

document.getElementById("navMine").addEventListener("click", openMine);
document.getElementById("trackBtn").addEventListener("click", () => {
    closeReportModal();
    openMine();
});
document.getElementById("mineClose").addEventListener("click", () => closeModal(mineModal));

mineModal.addEventListener("click", event => {
    if (event.target === mineModal) closeModal(mineModal);
});

authModal.addEventListener("click", event => {
    if (event.target === authModal) closeModal(authModal);
});

// ---------- TOAST + MOBILE NAV ----------

function showToast(message) {
    const toast = document.getElementById("toast");

    toast.textContent = message;
    toast.classList.remove("hidden");

    clearTimeout(showToast.timer);

    showToast.timer = setTimeout(() => {
        toast.classList.add("hidden");
    }, 4500);
}

document.getElementById("menuToggle").addEventListener("click", () => {
    const nav = document.getElementById("navLinks");
    const open = nav.classList.toggle("open");
    document.getElementById("menuToggle").setAttribute("aria-expanded", String(open));
});

document.querySelectorAll("#navLinks a").forEach(link => {
    link.addEventListener("click", () => {
        document.getElementById("navLinks").classList.remove("open");
    });
});

// ---------- START ----------

initMap();
showMessage("Search any place in the world", "Type a name above, for example KMC Hospital Manipal.");

// ---------- INSTALLABLE APP (PWA basics) ----------
// The app shell is saved so the page opens offline. Search, maps and reports still need internet.
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
}

window.addEventListener("offline", () => {
    showToast("You are offline. The page opens, but search and reports need internet.");
});

window.addEventListener("online", () => {
    showToast("You are back online.");
});