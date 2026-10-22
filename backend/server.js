// ACCESSWAY - BACKEND SERVER

const express = require("express");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const zlib = require("zlib");

dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "..");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const USER_AGENT = `AccessWay/1.0 (${process.env.CONTACT_EMAIL || "student-project"})`;
const FIELDS = ["ramp", "lift", "entrance", "restroom", "parking"];

app.use(express.json({ limit: "4mb" }));

// Serve ONLY the website files
["style.css", "script.js", "accessway-upgrade.css", "accessway-upgrade.js", "manifest.json", "sw.js"].forEach(file => {
    app.get("/" + file, (req, res) => res.sendFile(path.join(ROOT, file)));
});

app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(ROOT, "admin.html")));

// ---------- APP ICONS (drawn by the server, so no image files are needed) ----------
function crc32(buf) {
    let crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        crc ^= buf[n];
        for (let k = 0; k < 8; k++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function makeIcon(size) {
    const stride = size * 3 + 1;
    const raw = Buffer.alloc(stride * size);
    const c = size / 2, radius = size * 0.30, line = size * 0.045;

    for (let y = 0; y < size; y++) {
        raw[y * stride] = 0;
        for (let x = 0; x < size; x++) {
            let color = [67, 33, 125];                          // purple background
            if (Math.hypot(x - c, y - c) <= radius) color = [240, 122, 106];   // coral circle
            const d = Math.min(
                distToSegment(x, y, size * 0.36, size * 0.50, size * 0.46, size * 0.60),
                distToSegment(x, y, size * 0.46, size * 0.60, size * 0.65, size * 0.38)
            );
            if (d <= line) color = [255, 255, 255];             // white check mark
            raw.set(color, y * stride + 1 + x * 3);
        }
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;   // 8 bits per colour
    header[9] = 2;   // RGB

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
}

const ICON_192 = makeIcon(192);
const ICON_512 = makeIcon(512);

app.get("/icon-192.png", (req, res) => res.type("png").send(ICON_192));
app.get("/icon-512.png", (req, res) => res.type("png").send(ICON_512));

// Uploaded report photos
const UP = path.join(ROOT, "uploads");
fs.mkdirSync(UP, { recursive: true });
app.use("/uploads", express.static(UP));

// DATABASE
const dbConfig = {
    host: process.env.DB_HOST || "127.0.0.1",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "accessway",
    port: Number(process.env.DB_PORT) || 3307,
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 10
};

let db;

// ---------- OpenStreetMap search (Nominatim) ----------
const cache = new Map();
let lastCall = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function nominatim(query, extra = "") {
    const key = (query + extra).toLowerCase();
    const hit = cache.get(key);

    if (hit && Date.now() - hit.time < 10 * 60 * 1000) {
        return hit.data;
    }

    const slot = Math.max(Date.now(), lastCall + 1100);
    lastCall = slot;
    await sleep(slot - Date.now());

    const url =
        "https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&addressdetails=1&limit=10&q=" +
        encodeURIComponent(query) + extra;

    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" }
    });

    if (!response.ok) {
        throw new Error("Search service returned " + response.status);
    }

    const data = await response.json();
    cache.set(key, { time: Date.now(), data });
    return data;
}

function yesNo(value) {
    if (value === undefined || value === null) return null;
    const v = String(value).toLowerCase();
    if (v === "yes" || v === "designated") return 1;
    if (v === "no" || v === "limited") return 0;
    return null;
}

function normalize(result) {
    const t = result.extratags || {};

    let parking = null;
    if (t["capacity:disabled"] !== undefined) {
        const cap = String(t["capacity:disabled"]).toLowerCase();
        parking = (cap === "no" || Number(cap) === 0) ? 0 : 1;
    }

    return {
        place_key: `${result.osm_type}/${result.osm_id}`,
        name: result.name || String(result.display_name || "").split(",")[0] || "Unnamed place",
        type: String(result.type || "place").replace(/_/g, " "),
        raw_type: result.type || "place",
        address: result.display_name || "",
        latitude: Number(result.lat),
        longitude: Number(result.lon),
        ramp: yesNo(t["ramp:wheelchair"] ?? t["ramp"]),
        lift: yesNo(t["elevator"] ?? t["lift"]),
        entrance: yesNo(t["wheelchair"]),
        restroom: yesNo(t["toilets:wheelchair"]),
        parking,
        note: t["wheelchair:description"] || null,
        source: "osm",
        verified_at: null
    };
}

// Admin-verified values override OpenStreetMap values
async function applyVerified(places) {
    if (!places.length) return;

    const [rows] = await db.query(
        "SELECT * FROM verified_places WHERE place_key IN (?)",
        [places.map(p => p.place_key)]
    );
    const byKey = new Map(rows.map(r => [r.place_key, r]));

    places.forEach(place => {
        const v = byKey.get(place.place_key);
        if (!v) return;

        FIELDS.forEach(field => {
            if (v[field] !== null && v[field] !== undefined) {
                place[field] = v[field];
            }
        });

        if (v.note) place.note = v.note;

        place.source = "verified";
        place.verified_at = v.verified_at;
    });
}

// SEARCH ANY PLACE IN THE WORLD
app.get("/api/places/search", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim().slice(0, 120);

        if (q.length < 3) {
            return res.status(400).json({ success: false, message: "Type at least 3 letters." });
        }

        const raw = await nominatim(q);
        const skip = ["boundary", "place", "natural", "waterway", "landuse", "highway"];
        const places = raw.filter(r => !skip.includes(r.category)).map(normalize);

        await applyVerified(places);

        res.json({ success: true, count: places.length, places });
    } catch (error) {
        console.error("Place search error:", error.message);
        res.status(502).json({
            success: false,
            message: "Place search is unavailable right now. Please try again."
        });
    }
});

// PLACES NEAR ME (uses MySQL ST_Distance_Sphere)
app.get("/api/places/nearby", async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const kind = ["hospital", "library", "bus station", "railway station", "post office"].includes(req.query.kind)
            ? req.query.kind
            : "hospital";

        if (!isFinite(lat) || !isFinite(lng)) {
            return res.status(400).json({ success: false, message: "Location missing." });
        }

        const d = 0.06;
        const raw = await nominatim(
            kind,
            `&viewbox=${lng - d},${lat + d},${lng + d},${lat - d}&bounded=1`
        );
        const places = raw.map(normalize);

        if (places.length) {
            const sql = "SELECT " +
                places.map((_, i) => `ST_Distance_Sphere(POINT(?, ?), POINT(?, ?)) AS d${i}`).join(", ");
            const params = places.flatMap(p => [lng, lat, p.longitude, p.latitude]);
            const [[row]] = await db.query(sql, params);

            places.forEach((p, i) => { p.distance_m = Math.round(row["d" + i]); });
            places.sort((a, b) => a.distance_m - b.distance_m);

            await applyVerified(places);
        }

        res.json({ success: true, count: places.length, places });
    } catch (error) {
        console.error("Nearby error:", error.message);
        res.status(502).json({ success: false, message: "Nearby search is unavailable right now." });
    }
});

// ---------- LOGIN ----------
const SECRET = ADMIN_KEY + "-accessway";

function sign(uid) {
    const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })).toString("base64url");
    return p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
}

function verifyToken(t) {
    if (!t) return null;
    const [p, s] = t.split(".");
    if (!p || !s) return null;

    const expected = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
    if (s.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;

    try {
        const data = JSON.parse(Buffer.from(p, "base64url"));
        return data.exp > Date.now() ? data.uid : null;
    } catch (e) {
        return null;
    }
}

function hashPw(pw) {
    const salt = crypto.randomBytes(16).toString("hex");
    return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}

function checkPw(pw, stored) {
    const [salt, key] = stored.split(":");
    return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(key, "hex"));
}

app.post("/api/auth/register", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim().slice(0, 80);
        const email = String(req.body.email || "").trim().toLowerCase().slice(0, 120);
        const pw = String(req.body.password || "");

        if (!name || !/^\S+@\S+\.\S+$/.test(email) || pw.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Enter your name, a valid email and a password of 6+ characters."
            });
        }

        const [r] = await db.query(
            "INSERT INTO users (name, email, pass_hash) VALUES (?, ?, ?)",
            [name, email, hashPw(pw)]
        );

        res.json({ success: true, token: sign(r.insertId), name });
    } catch (e) {
        const dup = e.code === "ER_DUP_ENTRY";
        res.status(dup ? 409 : 500).json({
            success: false,
            message: dup ? "This email is already registered." : "Could not register."
        });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);

        if (!rows.length || !checkPw(String(req.body.password || ""), rows[0].pass_hash)) {
            return res.status(401).json({ success: false, message: "Wrong email or password." });
        }

        res.json({ success: true, token: sign(rows[0].id), name: rows[0].name });
    } catch (e) {
        res.status(500).json({ success: false, message: "Could not log in." });
    }
});

// ---------- RULE-BASED REPORT CLASSIFICATION (keyword rules, not a trained AI model) ----------
// Reads a community report and SUGGESTS: category, issue, status and a confidence.
// It never verifies anything. An admin must approve every change.
const LABELS = {
    ramp: "Ramp", lift: "Lift", entrance: "Entrance",
    restroom: "Restroom", parking: "Parking"
};

// word lists for each category (words people really write in reports)
const CATEGORY_WORDS = {
    ramp: /\bramps?\b|slope/,
    lift: /\blifts?\b|elevators?/,
    entrance: /entrance|\bdoors?\b|\bgate\b|\bsteps?\b|stairs/,
    restroom: /restrooms?|toilets?|washrooms?|bathrooms?/,
    parking: /parking|car park/
};

const NEGATED_PROBLEM = /\b(not|no longer|isn'?t|is not|never)\s+(blocked|broken|closed|locked|damaged|out of order|under repair)/;
const PROBLEM_WORDS = /blocked|broken|not working|doesn'?t work|out of order|closed|locked|under repair|damaged|missing|unavailable|not available|not accessible|cannot|can'?t|stuck|crowded with|\bno (ramp|lift|elevator|toilet|restroom|parking)|without|only stairs|steps only/;
const GOOD_WORDS = /available|working|works|present|there is|there are|has a|have a|installed|functional|open|accessible|fixed|repaired|restored|reopened|new (ramp|lift)/;
const TEMPORARY_WORDS = /today|currently|right now|at the moment|temporar|this week|under repair|blocked|crowded|stuck|out of order/;
const PERMANENT_WORDS = /\bno (ramp|lift|elevator|toilet|restroom|parking)|does not have|doesn'?t have|never had|without|only stairs|steps only/;

function parseReport(type, details) {
    const typeText = String(type || "").toLowerCase();
    const detailText = String(details || "").toLowerCase();
    const all = typeText + " " + detailText;

    // 1. Category: the chosen update type wins, otherwise read the details
    let field = null;
    let fieldFrom = null;

    for (const key of Object.keys(CATEGORY_WORDS)) {
        if (CATEGORY_WORDS[key].test(typeText)) { field = key; fieldFrom = "type"; break; }
    }
    if (!field) {
        for (const key of Object.keys(CATEGORY_WORDS)) {
            if (CATEGORY_WORDS[key].test(detailText)) { field = key; fieldFrom = "details"; break; }
        }
    }

    // 2. Status: read what the person WROTE first; use the chosen update type only if the text has no clue
    function readStatus(text) {
        if (NEGATED_PROBLEM.test(text)) return 1;
        if (PROBLEM_WORDS.test(text)) return 0;
        if (GOOD_WORDS.test(text)) return 1;
        return null;
    }

    let value = readStatus(detailText);
    if (value === null) value = readStatus(typeText);
    const cue = value !== null;

    // 3. Issue wording
    let issue;
    if (value === 0) {
        issue = PERMANENT_WORDS.test(all) && !TEMPORARY_WORDS.test(all) ? "not available" : "temporarily unavailable";
    } else if (value === 1) {
        issue = "available";
    } else {
        issue = "unclear, needs checking";
    }

    // 4. Confidence (a simple score, not a probability)
    let confidence = 25;
    if (field) confidence += fieldFrom === "type" ? 35 : 25;
    if (cue) confidence += 25;
    if (field && cue && CATEGORY_WORDS[field].test(detailText)) confidence += 10;
    confidence = Math.min(confidence, 95);

    const text = field
        ? `${LABELS[field]}: ${issue} (confidence ${confidence}%)`
        : `Other update: needs admin review (confidence ${confidence}%)`;

    return { field, value, issue, confidence, text };
}

// ---------- SUBMIT A REPORT (login required, photo optional) ----------
app.post("/api/reports", async (req, res) => {
    try {
        const uid = verifyToken((req.get("authorization") || "").replace("Bearer ", ""));

        if (!uid) {
            return res.status(401).json({ success: false, message: "Please log in to report an update." });
        }

        const placeKey = String(req.body.place_key || "").trim().slice(0, 40);
        const placeName = String(req.body.place_name || "").trim().slice(0, 200);
        const reportType = String(req.body.report_type || "").trim().slice(0, 100);
        const details = String(req.body.details || "").trim().slice(0, 1000);

        if (!placeKey || !placeName || !reportType || !details) {
            return res.status(400).json({ success: false, message: "Please complete all report fields." });
        }

        let photo = null;
        const img = String(req.body.photo || "");

        if (img) {
            const m = img.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);

            if (!m || m[1].length > 2000000) {
                return res.status(400).json({ success: false, message: "Photo must be a JPEG under 1.5 MB." });
            }

            photo = crypto.randomBytes(12).toString("hex") + ".jpg";
            fs.writeFileSync(path.join(UP, photo), Buffer.from(m[1], "base64"));
        }

        const p = parseReport(reportType, details);

        const [dup] = await db.query(
            "SELECT id FROM reports WHERE place_key = ? AND status = 'pending' AND parsed_field <=> ? AND parsed_value <=> ? LIMIT 1",
            [placeKey, p.field, p.value]
        );

        const [ins] = await db.query(
            `INSERT INTO reports
             (place_key, place_name, report_type, details, user_id, photo, latitude, longitude,
              parsed_field, parsed_value, parsed_text, duplicate_of)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [placeKey, placeName, reportType, details, uid, photo,
             Number(req.body.latitude) || null, Number(req.body.longitude) || null,
             p.field, p.value, p.text, dup.length ? dup[0].id : null]
        );

        res.status(201).json({
            success: true,
            message: "Report saved for review",
            id: ins.insertId,
            status: "pending",
            smart_reading: p.text,
            category: p.field ? LABELS[p.field] : "Other",
            issue: p.issue,
            confidence: p.confidence,
            duplicate: dup.length > 0
        });
    } catch (error) {
        console.error("Report API error:", error.message);
        res.status(500).json({ success: false, message: "Report could not be saved." });
    }
});

// ---------- MY REPORTS (so a user can follow a report's status) ----------
app.get("/api/reports/mine", async (req, res) => {
    try {
        const uid = verifyToken((req.get("authorization") || "").replace("Bearer ", ""));

        if (!uid) {
            return res.status(401).json({ success: false, message: "Please log in to see your reports." });
        }

        const [rows] = await db.query(
            `SELECT id, place_name, report_type, status, parsed_text, duplicate_of, created_at
             FROM reports WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
            [uid]
        );

        res.json({ success: true, reports: rows });
    } catch (error) {
        console.error("My reports error:", error.message);
        res.status(500).json({ success: false, message: "Could not load your reports." });
    }
});

// ---------- ADMIN ----------
function sameKey(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function adminOnly(req, res, next) {
    if (!ADMIN_KEY) {
        return res.status(503).json({ success: false, message: "ADMIN_KEY is not set in .env" });
    }
    if (!sameKey(req.get("x-admin-key") || "", ADMIN_KEY)) {
        return res.status(401).json({ success: false, message: "Wrong admin key" });
    }
    next();
}

function toValue(x) {
    return (x === 1 || x === 0 || x === "1" || x === "0") ? Number(x) : null;
}

// Checks the admin key (used by the admin login screen)
app.get("/api/admin/check", adminOnly, (req, res) => {
    res.json({ success: true });
});

async function saveVerified(key, name, lat, lng, values, note) {
    await db.query(
        `INSERT INTO verified_places
         (place_key, place_name, latitude, longitude, ramp, lift, entrance, restroom, parking, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           place_name = VALUES(place_name),
           latitude = VALUES(latitude),
           longitude = VALUES(longitude),
           ramp = COALESCE(VALUES(ramp), ramp),
           lift = COALESCE(VALUES(lift), lift),
           entrance = COALESCE(VALUES(entrance), entrance),
           restroom = COALESCE(VALUES(restroom), restroom),
           parking = COALESCE(VALUES(parking), parking),
           note = COALESCE(VALUES(note), note),
           verified_at = NOW()`,
        [key, name, lat, lng, ...values, note]
    );
}

app.get("/api/admin/reports", adminOnly, async (req, res) => {
    try {
        const status = ["pending", "verified", "rejected"].includes(req.query.status)
            ? req.query.status
            : "pending";

        const [rows] = await db.query(
            "SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 100",
            [status]
        );

        res.json({ success: true, reports: rows });
    } catch (error) {
        console.error("Admin list error:", error.message);
        res.status(500).json({ success: false, message: "Could not load reports" });
    }
});

app.post("/api/admin/reports/:id/verify", adminOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query("SELECT * FROM reports WHERE id = ?", [id]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Report not found" });
        }

        const report = rows[0];
        const values = FIELDS.map(field => toValue(req.body[field]));
        const note = String(req.body.note || "").trim().slice(0, 255) || null;

        // The classifier only suggests. The admin must say how they checked it.
        if (!note) {
            return res.status(400).json({
                success: false,
                message: "Write a source note (for example: confirmed by phone) before verifying."
            });
        }

        await saveVerified(report.place_key, report.place_name, report.latitude, report.longitude, values, note);
        await db.query("UPDATE reports SET status = 'verified' WHERE id = ?", [id]);

        res.json({ success: true });
    } catch (error) {
        console.error("Admin verify error:", error.message);
        res.status(500).json({ success: false, message: "Could not verify report" });
    }
});

app.post("/api/admin/reports/:id/reject", adminOnly, async (req, res) => {
    try {
        await db.query("UPDATE reports SET status = 'rejected' WHERE id = ?", [Number(req.params.id)]);
        res.json({ success: true });
    } catch (error) {
        console.error("Admin reject error:", error.message);
        res.status(500).json({ success: false, message: "Could not reject report" });
    }
});

// HOW MANY REPORTS ARE STORED IN MYSQL (shown on the admin page)
app.get("/api/admin/stats", adminOnly, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT status, COUNT(*) AS n FROM reports GROUP BY status");
        const [[places]] = await db.query("SELECT COUNT(*) AS n FROM verified_places");

        const counts = { pending: 0, verified: 0, rejected: 0 };
        rows.forEach(r => { counts[r.status] = Number(r.n); });

        res.json({ success: true, reports: counts, verified_places: Number(places.n) });
    } catch (error) {
        console.error("Admin stats error:", error.message);
        res.status(500).json({ success: false, message: "Could not load the database counts" });
    }
});

// ADD VERIFIED DATA DIRECTLY (admin confirmed it by phone or visit)
app.post("/api/admin/places", adminOnly, async (req, res) => {
    try {
        const key = String(req.body.place_key || "").trim().slice(0, 40);
        const name = String(req.body.place_name || "").trim().slice(0, 200);
        const lat = Number(req.body.latitude);
        const lng = Number(req.body.longitude);
        const values = FIELDS.map(field => toValue(req.body[field]));
        const note = String(req.body.note || "").trim().slice(0, 255) || null;

        if (!key || !name) {
            return res.status(400).json({ success: false, message: "Choose a place first." });
        }

        if (values.every(v => v === null)) {
            return res.status(400).json({ success: false, message: "Choose Yes or No for at least one check." });
        }

        await saveVerified(key, name, isFinite(lat) ? lat : null, isFinite(lng) ? lng : null, values, note);

        res.json({ success: true });
    } catch (error) {
        console.error("Admin place error:", error.message);
        res.status(500).json({ success: false, message: "Could not save this place." });
    }
});

// HEALTH
app.get("/api/health", async (req, res) => {
    try {
        await db.query("SELECT 1");
        res.json({ success: true, database: "Connected" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Database connection failed" });
    }
});

// START
async function startServer() {
    try {
        db = mysql.createPool(dbConfig);
        await db.query("SELECT 1");

        console.log("✅ Database connected successfully!");

        app.listen(PORT, () => {
            console.log("----------------------------------");
            console.log("💜 ACCESSWAY SERVER STARTED");
            console.log(`Website: http://localhost:${PORT}`);
            console.log(`Admin:   http://localhost:${PORT}/admin`);
            console.log("----------------------------------");
        });
    } catch (error) {
        console.error("❌ Database connection failed!");
        console.error(error.message);
        console.log("Check your .env settings and XAMPP MySQL status.");
        process.exit(1);
    }
}

startServer();