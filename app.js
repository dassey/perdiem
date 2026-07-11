const map = L.map('map').setView([39.5, -98.35], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Keep the map sized correctly on mobile (orientation changes, keyboard, etc.)
window.addEventListener('resize', () => map.invalidateSize());
setTimeout(() => map.invalidateSize(), 200);

let targetLayer = null;
let surroundingLayer = L.layerGroup().addTo(map);

const statusEl = document.getElementById('status');
const ratePanel = document.getElementById('rates');
const rateList = document.getElementById('rate-list');
const locationInput = document.getElementById('location-input');

// US Census TIGERweb ZIP Code Tabulation Areas (ZCTA) polygon layer.
// This is the authoritative free source for US ZIP boundaries (CORS-enabled, no key).
const CENSUS_ZCTA =
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query';

const isZip = (q) => /^\d{5}$/.test(q.trim());

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
        const point = await geocodeToPoint(query);
        if (!point) throw new Error('No matching location found. Try "City, State" or a 5-digit ZIP.');

        // Resolve the target ZIP. If the user typed a ZIP, trust it; otherwise
        // find the ZCTA that actually contains the geocoded point so it matches
        // the boundary we can draw.
        let zip = isZip(query) ? query.trim() : null;
        if (!zip) zip = await zctaAtPoint(point.lat, point.lon);
        if (!zip) zip = point.zip;
        if (!zip) throw new Error('Could not determine a ZIP code for this location.');

        await updateView(point.lat, point.lon, zip, point.label);
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
                updateStatus('Found location. Finding ZIP code...', false, true);
                ratePanel.style.display = 'none';
                rateList.innerHTML = '';

                const zip = await zctaAtPoint(lat, lon);
                if (!zip) throw new Error('Could not determine a ZIP code for your location.');

                await updateView(lat, lon, zip, 'Your Location');
            } catch (err) {
                console.error(err);
                updateStatus(err.message, true);
            }
        }, () => {
            updateStatus('Unable to retrieve your location.', true);
        });
    });
}

// --- CORE VIEW UPDATE ---
async function updateView(lat, lon, zip, label) {
    const center = [lat, lon];
    map.setView(center, 11);
    updateStatus(`Loading ${label} (ZIP ${zip})...`, false, true);

    // 1. Target ZIP boundary
    const targetFeature = await fetchZctaBoundary(zip);
    drawTarget(targetFeature, center, zip);

    // 2. Rates for the target ZIP (from the Cloudflare Worker)
    const mainRates = await fetchPerDiem(zip);
    displayRates(zip, mainRates);

    // 3. Surrounding ZIPs (clickable, recolored amber where the rate beats the target)
    await renderSurrounding(center, zip, mainRates);
    updateStatus('Tap any shaded ZIP area on the map to see its per diem rate.');
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

// --- GEOCODING HELPERS ---

// Turn any user query (ZIP or "City, State") into { lat, lon, zip?, label }.
async function geocodeToPoint(query) {
    const q = query.trim();

    if (isZip(q)) {
        try {
            const res = await fetch(`https://api.zippopotam.us/us/${q}`);
            if (res.ok) {
                const d = await res.json();
                const p = d.places && d.places[0];
                if (p) {
                    return {
                        lat: parseFloat(p.latitude),
                        lon: parseFloat(p.longitude),
                        zip: q,
                        label: `${p['place name']}, ${p['state abbreviation']}`
                    };
                }
            }
        } catch (e) {
            console.warn('Zippopotam lookup failed, falling back to Nominatim.', e);
        }
        // fall through to Nominatim if Zippopotam has no data
    }

    // City / state / free-form (restricted to the US)
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=us&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Location search failed. Please try again later.');
    const data = await res.json();
    const place = data[0];
    if (!place) return null;

    const postcode = place.address && place.address.postcode;
    return {
        lat: parseFloat(place.lat),
        lon: parseFloat(place.lon),
        zip: postcode && isZip(postcode) ? postcode : null,
        label: shortLabel(place)
    };
}

function shortLabel(place) {
    const a = place.address || {};
    const city = a.city || a.town || a.village || a.hamlet || a.county;
    const state = a.state;
    if (city && state) return `${city}, ${state}`;
    return (place.display_name || '').split(',').slice(0, 2).join(',');
}

// Find the ZCTA (ZIP) that contains a lat/lon.
async function zctaAtPoint(lat, lon) {
    try {
        const url = `${CENSUS_ZCTA}?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ZCTA5&returnGeometry=false&f=json`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        return (data.features && data.features[0] && data.features[0].attributes.ZCTA5) || null;
    } catch (e) {
        console.error('ZCTA point lookup failed.', e);
        return null;
    }
}

// GeoJSON Feature for a single ZIP boundary.
async function fetchZctaBoundary(zip) {
    try {
        const url = `${CENSUS_ZCTA}?where=ZCTA5%3D'${zip}'&outFields=ZCTA5&returnGeometry=true&outSR=4326&f=geojson`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        return (data.features && data.features[0]) || null;
    } catch (e) {
        console.error('ZCTA boundary fetch failed.', e);
        return null;
    }
}

// GeoJSON Features for ZIP boundaries surrounding a center point.
async function fetchSurroundingZctas(lat, lon, targetZip) {
    try {
        const dLat = 0.11;
        const dLon = 0.13;
        const bbox = `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`;
        const url = `${CENSUS_ZCTA}?geometry=${bbox}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ZCTA5&returnGeometry=true&outSR=4326&resultRecordCount=50&f=geojson`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.features || []).filter(
            (f) => f.properties && f.properties.ZCTA5 && f.properties.ZCTA5 !== targetZip
        );
    } catch (e) {
        console.error('Surrounding ZCTA fetch failed.', e);
        return [];
    }
}

// --- CLOUDFLARE WORKER CONNECTION ---
const rateCache = new Map(); // key: `${zip}-${year}` -> normalized rates

async function fetchPerDiem(zip) {
    const yearSelect = document.getElementById('year-select');
    const year = yearSelect ? yearSelect.value : '2025';
    const key = `${zip}-${year}`;
    if (rateCache.has(key)) return rateCache.get(key);

    const workerUrl = `https://bushes.dassey.workers.dev`;
    const url = `${workerUrl}?zip=${zip}&year=${year}`;

    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.error('Per diem fetch failed with status:', res.status);
            return [];
        }
        const data = await res.json();
        const rawRates = (data && (data.rates || data.rate)) || [];
        const normalized = normalizeRates(rawRates);
        rateCache.set(key, normalized);
        return normalized;
    } catch (e) {
        console.error('Worker Error:', e);
        return [];
    }
}

// Highest daily allowance (max lodging + M&IE) represented by a set of rates.
// Used to compare ZIPs. Returns 0 when there is no usable data.
function rateScore(rates) {
    let best = 0;
    for (const r of dedupeRates(rates)) {
        best = Math.max(best, parseLodging(r.lodging) + (parseFloat(r.mie) || 0));
    }
    return best;
}

function parseLodging(lodging) {
    if (typeof lodging === 'number') return lodging;
    if (typeof lodging === 'string') {
        // Handles flat values and seasonal ranges like "165-215"
        const nums = lodging.split('-').map((s) => parseFloat(s)).filter((n) => !isNaN(n));
        if (nums.length) return Math.max(...nums);
    }
    return 0;
}

function normalizeRates(rawRates) {
    const normalized = [];
    const list = Array.isArray(rawRates) ? rawRates : [rawRates];

    list.forEach((mainItem) => {
        const subRates = mainItem.rate || [];
        subRates.forEach((r) => {
            const mie = r.meals;
            let lodging = 'N/A';
            if (r.months && r.months.month && Array.isArray(r.months.month)) {
                const prices = r.months.month.map((m) => m.value);
                const min = Math.min(...prices);
                const max = Math.max(...prices);
                lodging = min === max ? min : `${min}-${max}`;
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
        rateList.innerHTML = '<li>No per diem data for this ZIP.</li>';
        return;
    }
    unique.forEach((r) => {
        const li = document.createElement('li');
        li.textContent = `ZIP ${zip}: Lodging $${r.lodging} / M&IE $${r.mie}`;
        rateList.appendChild(li);
    });
}

function drawTarget(feature, fallbackCenter, zip) {
    if (feature && feature.geometry) {
        targetLayer = L.geoJSON(feature, {
            style: { color: '#2563eb', weight: 2, fillColor: '#60a5fa', fillOpacity: 0.35 }
        }).addTo(map);
        targetLayer.on('click', () => showPopup(targetLayer.getBounds().getCenter(), zip));
        map.fitBounds(targetLayer.getBounds(), { padding: [24, 24], maxZoom: 13 });
    } else {
        targetLayer = L.circleMarker(fallbackCenter, {
            radius: 10, color: '#2563eb', fillColor: '#60a5fa', fillOpacity: 0.6
        }).addTo(map);
        targetLayer.on('click', () => showPopup(fallbackCenter, zip));
    }
}

const GREEN_STYLE = { color: '#16a34a', weight: 1.5, fillColor: '#34d399', fillOpacity: 0.25 };
const AMBER_STYLE = { color: '#b45309', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 0.45 };

async function renderSurrounding(center, targetZip, targetRates) {
    updateStatus('Loading surrounding ZIP codes...', false, true);
    const neighbors = await fetchSurroundingZctas(center[0], center[1], targetZip);
    if (!neighbors.length) {
        updateStatus('No surrounding ZIP boundaries found. Showing target only.');
        return;
    }

    const entries = [];
    neighbors.forEach((feature) => {
        const zip = feature.properties.ZCTA5;
        const layer = L.geoJSON(feature, { style: GREEN_STYLE });
        layer.on('click', async () => {
            layer.bindPopup(`<strong>ZIP ${zip}</strong><br><em>Loading rates…</em>`).openPopup();
            const rates = await fetchPerDiem(zip);
            layer.setPopupContent(buildPopupContent(zip, rates));
        });
        surroundingLayer.addLayer(layer);
        entries.push({ zip, layer });
    });

    // Recolor neighbors whose per diem beats the target's, in the background so
    // the map stays responsive. Skipped if the target has no rate to compare.
    const targetScore = rateScore(targetRates);
    if (targetScore > 0) highlightHigherRates(entries, targetScore);
}

async function highlightHigherRates(entries, targetScore) {
    const queue = entries.slice();
    const worker = async () => {
        while (queue.length) {
            const { zip, layer } = queue.shift();
            const rates = await fetchPerDiem(zip);
            if (rateScore(rates) > targetScore) layer.setStyle(AMBER_STYLE);
        }
    };
    // Limited concurrency to avoid hammering the worker with ~40 requests at once.
    const pool = Array.from({ length: Math.min(6, queue.length) }, worker);
    await Promise.all(pool);
}

function buildPopupContent(zip, rates) {
    const unique = dedupeRates(rates);
    if (!unique.length) {
        return `<strong>ZIP ${zip}</strong><br>No per diem data.`;
    }
    const lines = unique.map((r) => `<div>Lodging $${r.lodging} | M&IE $${r.mie}</div>`).join('');
    return `<strong>ZIP ${zip}</strong><br>${lines}`;
}

async function showPopup(latlng, zip) {
    L.popup().setLatLng(latlng).setContent(`<strong>ZIP ${zip}</strong><br><em>Loading rates…</em>`).openOn(map);
    const rates = await fetchPerDiem(zip);
    L.popup().setLatLng(latlng).setContent(buildPopupContent(zip, rates)).openOn(map);
}
