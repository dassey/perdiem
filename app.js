const map = L.map('map').setView([39.5, -98.35], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let targetLayer = null;
let surroundingLayer = L.layerGroup().addTo(map);

const statusEl = document.getElementById('status');
const ratePanel = document.getElementById('rates');
const rateList = document.getElementById('rate-list');
const locationInput = document.getElementById('location-input');

// --- SEARCH HANDLER ---
document.getElementById('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = locationInput.value.trim();
    if (!query) return;

    clearLayers();
    updateStatus('Searching for location...', false, true);
    ratePanel.style.display = 'none';
    rateList.innerHTML = '';

    try {
        const place = await geocode(query);
        if (!place) throw new Error('No matching location found.');

        const lat = parseFloat(place.lat);
        const lon = parseFloat(place.lon);

        const targetZip = await resolveZip(place);
        if (!targetZip) throw new Error('Could not determine a Zip Code for this location.');

        await updateView(lat, lon, targetZip, place.display_name);

    } catch (err) {
        console.error(err);
        updateStatus(err.message, true);
    }
});

// --- LOCATE ME BUTTON HANDLER ---
const locateBtn = document.getElementById('locate-btn');
if (locateBtn) {
    locateBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            updateStatus('Geolocation is not supported by your browser.', true);
            return;
        }

        updateStatus('Locating...', false, true);
        navigator.geolocation.getCurrentPosition(async (pos) => {
            try {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;

                clearLayers();
                updateStatus('Found location. Finding Zip Code...', false, true);
                ratePanel.style.display = 'none';
                rateList.innerHTML = '';

                const place = { lat, lon };
                const targetZip = await resolveZip(place);

                if (!targetZip) throw new Error('Could not determine a Zip Code for your location.');

                await updateView(lat, lon, targetZip, "Your Location");

            } catch (err) {
                console.error(err);
                updateStatus(err.message, true);
            }
        }, (err) => {
            updateStatus('Unable to retrieve your location.', true);
        });
    });
}

// --- CORE VIEW UPDATE ---
async function updateView(lat, lon, zip, label) {
    const center = [lat, lon];
    map.setView(center, 11);
    updateStatus(`Centering map on ${label} (Zip ${zip})...`, false, true);

    // 1. Get Boundary
    const targetGeojson = await fetchZipBoundary(zip);
    drawTarget(targetGeojson, center, zip);

    // 2. Get Rates (From your Worker)
    const mainRates = await fetchPerDiem(zip);
    displayRates(zip, mainRates);

    // 3. Get Neighbors
    await renderSurrounding(center, zip);
    updateStatus('Click any shaded area to see its per diem rate.');
}

function clearLayers() {
    if (targetLayer) {
        targetLayer.remove();
        targetLayer = null;
    }
    surroundingLayer.clearLayers();
}

function updateStatus(message, isError = false, isLoading = false) {
    statusEl.textContent = '';
    if (isLoading) {
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        statusEl.appendChild(spinner);
    }
    statusEl.appendChild(document.createTextNode(message));
    statusEl.classList.toggle('error', Boolean(isError));
}

// --- API HELPERS ---

async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Geocoding failed. Please try again later.');
    const data = await res.json();
    return data[0];
}

async function resolveZip(place) {
    if (place.address && place.address.postcode) return place.address.postcode;
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${place.lat}&lon=${place.lon}&zoom=18&addressdetails=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.address?.postcode || null;
}

async function fetchZipBoundary(zip) {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=USA&polygon_geojson=1&format=json&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load boundary for the target Zip Code.');
    const data = await res.json();
    return data[0]?.geojson || null;
}

// --- CLOUDFLARE WORKER CONNECTION ---
async function fetchPerDiem(zip) {
    // Get year from dropdown, default to 2025 if missing
    const yearSelect = document.getElementById('year-select');
    const year = yearSelect ? yearSelect.value : '2025';

    // DIRECT LINK TO YOUR WORKER
    const workerUrl = `https://bushes.dassey.workers.dev`;
    const url = `${workerUrl}?zip=${zip}&year=${year}`;

    // --- LOGGING ADDED HERE ---
    console.log("Attempting to fetch from:", url);

    try {
        const res = await fetch(url);

        // Log the status to see if it connected
        console.log("Response status:", res.status);

        if (!res.ok) {
            console.error("Fetch failed with status:", res.status);
            return [];
        }

        const data = await res.json();
        console.log("Data received:", data); // Optional: See the raw data

        // Handle GSA API structure
        const rawRates = data?.rates || data?.rate || [];
        return normalizeRates(rawRates);
    } catch (e) {
        console.error("Worker Error:", e);
        return [];
    }
}

function normalizeRates(rawRates) {
    const normalized = [];
    // Ensure we have a list to iterate
    const list = Array.isArray(rawRates) ? rawRates : [rawRates];

    list.forEach(mainItem => {
        // GSA V2 structure often has a 'rate' array inside the main item
        // e.g. { rate: [ { meals: 80, months: { month: [...] } } ] }
        const subRates = mainItem.rate || [];

        subRates.forEach(r => {
            // Meals (M&IE)
            const mie = r.meals;

            // Lodging - typically in months.month array
            let lodging = 'N/A';
            if (r.months && r.months.month && Array.isArray(r.months.month)) {
                // Extract all values
                const prices = r.months.month.map(m => m.value);
                const min = Math.min(...prices);
                const max = Math.max(...prices);
                // If flat rate, show one price. If seasonal, show range.
                lodging = (min === max) ? min : `${min}-${max}`;
            }

            normalized.push({ lodging: lodging, mie: mie });
        });
    });

    return normalized;
}

// --- UI / MAPPING HELPERS ---

function dedupeRates(rates) {
    const seen = new Set();
    const unique = [];
    for (const r of rates) {
        const key = `${r.lodging || 'N/A'}-${r.mie || 'N/A'}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(r);
        }
    }
    return unique;
}

function displayRates(zip, rates) {
    ratePanel.style.display = 'block';
    rateList.innerHTML = '';
    const unique = dedupeRates(rates);
    if (!unique.length) {
        rateList.innerHTML = '<li>No per diem data for this zip.</li>';
        return;
    }
    unique.forEach(r => {
        const li = document.createElement('li');
        li.textContent = `Zip ${zip}: Lodging $${r.lodging} / M&IE $${r.mie}`;
        rateList.appendChild(li);
    });
}

function drawTarget(geojson, fallbackCenter, zip) {
    if (geojson) {
        targetLayer = L.geoJSON(geojson, {
            style: { color: '#2563eb', weight: 2, fillColor: '#60a5fa', fillOpacity: 0.35 },
            onEachFeature: (feature, layer) => {
                layer.on('click', () => {
                    showPopup(layer.getBounds().getCenter(), zip);
                });
            }
        }).addTo(map);
        map.fitBounds(targetLayer.getBounds(), { padding: [20, 20] });
    } else {
        targetLayer = L.circleMarker(fallbackCenter, {
            radius: 10, color: '#2563eb', fillColor: '#60a5fa', fillOpacity: 0.6
        }).addTo(map);
        targetLayer.on('click', () => showPopup(fallbackCenter, zip));
    }
}

async function renderSurrounding(center, targetZip) {
    updateStatus('Loading surrounding Zip Codes...', false, true);
    const neighbors = await fetchSurroundingZips(center, targetZip);
    if (!neighbors.length) {
        updateStatus('No nearby postal boundaries found. Showing target only.');
        return;
    }

    neighbors.forEach(async (zone) => {
        const layer = toLeafletShape(zone);
        if (!layer) return;
        layer.setStyle({ color: '#16a34a', weight: 1.5, fillColor: '#34d399', fillOpacity: 0.28 });
        layer.on('click', async () => {
            const rates = await fetchPerDiem(zone.postalCode);
            const content = buildPopupContent(zone.postalCode, rates);
            layer.bindPopup(content).openPopup();
        });
        surroundingLayer.addLayer(layer);
    });
}

function toLeafletShape(zone) {
    if (zone.geojson) {
        return L.geoJSON(zone.geojson);
    }
    if (zone.geometry && zone.geometry.length) {
        return L.polygon(zone.geometry.map(pt => [pt.lat, pt.lon]));
    }
    return null;
}

async function fetchSurroundingZips(center, targetZip) {
    const [lat, lon] = center;
    const radiusMeters = 15000; // 15 km neighborhood
    const query = `data=[out:json][timeout:25];(relation["boundary"="postal_code"](around:${radiusMeters},${lat},${lon});way["postal_code"](around:${radiusMeters},${lat},${lon}););out geom;`;
    const url = `https://overpass-api.de/api/interpreter?${query}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const zones = [];
    const seen = new Set();
    for (const el of data.elements || []) {
        const code = el.tags?.postal_code;
        if (!code || code === targetZip || seen.has(code)) continue;
        seen.add(code);
        zones.push({ postalCode: code, geometry: el.geometry });
    }
    return zones;
}

function buildPopupContent(zip, rates) {
    const unique = dedupeRates(rates);
    if (!unique.length) {
        return `<strong>Zip ${zip}</strong><br>No per diem data.`;
    }
    const lines = unique.map(r => `<div>Lodging $${r.lodging} | M&IE $${r.mie}</div>`).join('');
    return `<strong>Zip ${zip}</strong><br>${lines}`;
}

async function showPopup(latlng, zip) {
    const rates = await fetchPerDiem(zip);
    const content = buildPopupContent(zip, rates);
    L.popup().setLatLng(latlng).setContent(content).openOn(map);
}
