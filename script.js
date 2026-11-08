// --- SAKURA REALM: CLOUDINARY & FIREBASE UPLOADER ENGINE ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getDatabase, ref, set, get, update, remove, child } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBAyTxN3YWVFzkmyAsd6SWF8f2YYpbc0T8",
  authDomain: "sakura-realm.firebaseapp.com",
  databaseURL: "https://sakura-realm-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sakura-realm",
  storageBucket: "sakura-realm.firebasestorage.app",
  messagingSenderId: "1033024958998",
  appId: "1:1033024958998:web:5f6dab22aebd6b9fc83b37",
  measurementId: "G-7VZ07WZK6D"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

// Cloudinary Configuration Constants
// Cloudinary accounts: "cloud name": "unsigned upload preset".
// To add an account just add one line here. Names ("Account 1", "Account 2", ...),
// colours and the dropdowns are made automatically from the order of this list.
const CLOUD_ACCOUNTS = {
    "dxbelpram": "sakura_uploads_1",
    "des4futwk": "sakura_uploads_2",
    "fr6tdunm": "sakura_uploads_3",
    "duez2cni": "sakura_uploads_4", 
};
const CLOUD_IDS = Object.keys(CLOUD_ACCOUNTS);
// Which Cloudinary account an image URL belongs to (the cloud name is inside the URL)
function cloudFromUrl(u) {
    try {
        const url = new URL(String(u));
        return url.hostname === "res.cloudinary.com" ? (url.pathname.split("/").filter(Boolean)[0] || "") : "";
    } catch (_) { return ""; }
}
// Shown name: only "Account N" (never the cloud name / keys). Unknown clouds -> "Other".
const cloudLabel = (cloud) => { const i = CLOUD_IDS.indexOf(cloud); return i >= 0 ? "Account " + (i + 1) : "Other"; };
// Small coloured tag: "Account 2" (colour is generated per account, works for any number of accounts)
function cloudTag(cloud) {
    if (!cloud) return "";
    const i = CLOUD_IDS.indexOf(cloud);
    const hue = i >= 0 ? (170 + i * 137) % 360 : 215;
    return `<span class="cloud-tag" style="--h:${hue}">${esc(cloudLabel(cloud))}</span>`;
}
// Address of the Cloudflare Worker that deletes images from Cloudinary (see cloudinary-cleaner/README).
// Leave "" to keep the old behaviour (delete from Firebase only, Cloudinary images stay).
const CLEANER_URL = "https://sakura-cloudinary-cleaner.sawzinminkhand321.workers.dev";

// Local IndexedDB for temporary gallery staging
const DB_NAME = "SakuraRealmUploaderDB";
const DB_VERSION = 1;
const STORE_NAME = "galleryImages";
let db = null;
let tempModalSelectedImages = [];
let finalSelectedChapterImages = [];

// --- SMALL HELPERS ---
// Inline SVG icon (symbols live in the sprite at the top of index.html)
const ic = (name, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// Escape text coming from Firebase before putting it into innerHTML
function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

// Safe wrappers (storage can throw in private mode / blocked cookies)
const store = {
    local: {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
        del(k) { try { localStorage.removeItem(k); } catch (e) {} }
    },
    session: {
        get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
        del(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
    }
};

// --- LOGIN: "REMEMBER ME" RULES ---
// Remember Me ON  -> stay logged in on this device (Firebase local persistence)
// Remember Me OFF -> logged in for this browser session only; next time the
//                    browser/tab is opened fresh, the login screen is shown again.
const REMEMBER_KEY = "sakura_remember_me";      // localStorage: "1" when Remember Me was ticked
const REMEMBER_EMAIL_KEY = "sakura_remember_email";
const SESSION_KEY = "sakura_session_active";    // sessionStorage: set while this browser session is logged in

function showLoginError(message) {
    const box = document.getElementById("loginError");
    const text = document.getElementById("loginErrorText");
    if (!box || !text) return;
    if (!message) { box.classList.add("hidden"); return; }
    text.textContent = message;
    box.classList.remove("hidden");
    // restart the little shake animation
    box.style.animation = "none"; void box.offsetWidth; box.style.animation = "";
}

function friendlyAuthError(err) {
    switch (err && err.code) {
        case "auth/invalid-email": return "Please enter a valid email address.";
        case "auth/user-disabled": return "This account has been disabled.";
        case "auth/user-not-found":
        case "auth/wrong-password":
        case "auth/invalid-credential":
        case "auth/invalid-login-credentials": return "Incorrect email or password.";
        case "auth/too-many-requests": return "Too many attempts. Please wait a moment and try again.";
        case "auth/network-request-failed": return "Network error. Please check your connection.";
        case "auth/timeout": return "Connection is slow. Please tap Sign in again.";
        default: return "Unable to sign in. " + ((err && err.message) || "");
    }
}

function showAuthScreen(loggedIn, user) {
    const splash = document.getElementById("authSplash");
    const loginModal = document.getElementById("loginModal");
    const appShell = document.getElementById("appShell");
    if (splash) splash.classList.add("hidden");
    if (loggedIn) {
        if (loginModal) loginModal.classList.add("hidden");
        if (appShell) appShell.classList.remove("hidden");
    } else {
        if (appShell) appShell.classList.add("hidden");
        if (loginModal) loginModal.classList.remove("hidden");
    }
}

// Pre-fill email + tick checkbox if the user chose Remember Me last time
(function restoreRememberedLogin() {
    const emailEl = document.getElementById("loginEmail");
    const checkEl = document.getElementById("rememberMeCheckbox");
    if (store.local.get(REMEMBER_KEY) === "1") {
        if (checkEl) checkEl.checked = true;
        const savedEmail = store.local.get(REMEMBER_EMAIL_KEY);
        if (emailEl && savedEmail) emailEl.value = savedEmail;
    }
})();

let loginInProgress = false;
let appDataLoaded = false;
let loggedInThisPage = false;      // in-memory flag: survives blocked sessionStorage / late auth callbacks

onAuthStateChanged(auth, async (user) => {
    if (user) {
        // Session guard: if the user did NOT choose Remember Me and this is a
        // brand-new browser session, they must log in again.
        const remembered = store.local.get(REMEMBER_KEY) === "1";
        const sessionActive = store.session.get(SESSION_KEY) === "1";
        if (!remembered && !sessionActive && !loginInProgress && !loggedInThisPage) {
            try { await signOut(auth); } catch (e) { console.error(e); }
            return; // onAuthStateChanged fires again with user = null
        }
        showAuthScreen(true, user);
        if (!appDataLoaded) {
            appDataLoaded = true;
            loadAppDataSafely();
        }
    } else {
        appDataLoaded = false;
        loggedInThisPage = false;
        showAuthScreen(false);
    }
});

// Loads the lists after login. Waits for the page + local DB to be ready and retries once,
// so a slow token / slow start never shows a random error.
async function loadAppDataSafely() {
    if (document.readyState === "loading") await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await Promise.all([renderManagedCovers(), populateMangaDropdown()]);
            return;
        } catch (e) {
            console.warn("Data load retry:", e);
            await new Promise(r => setTimeout(r, 600));
        }
    }
}

window.togglePasswordVisibility = function() {
    const input = document.getElementById("loginPassword");
    const btn = document.getElementById("togglePasswordBtn");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.innerHTML = ic(show ? "eye-off" : "eye");
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
};

// never let a login step hang forever (slow autofill / network): give up after ms
function withTimeout(promise, ms, code) {
    let t;
    const timer = new Promise((_, rej) => { t = setTimeout(() => rej({ code }), ms); });
    return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}
let loginBusy = false;

window.handleLogin = async function(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (loginBusy) return;                       // tap + submit can both fire: only run once
    loginBusy = true;
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const rememberMe = document.getElementById("rememberMeCheckbox").checked;
    const submitBtn = document.getElementById("loginSubmitBtn");

    showLoginError("");
    if (!email || !password) {
        loginBusy = false;
        showLoginError("Please enter your email and password.");
        return;
    }

    loginInProgress = true;
    submitBtn.disabled = true;
    submitBtn.innerHTML = `${ic('loader','ic-spin')} Logging in...`;

    try {
        // Choose where Firebase keeps the login BEFORE signing in
        const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
        try { await withTimeout(setPersistence(auth, persistence), 5000, "auth/timeout"); } catch (e) { console.warn("setPersistence skipped:", e); }

        // Mark choice (guards in onAuthStateChanged read these)
        loggedInThisPage = true;
        store.session.set(SESSION_KEY, "1");
        if (rememberMe) {
            store.local.set(REMEMBER_KEY, "1");
            store.local.set(REMEMBER_EMAIL_KEY, email);
        } else {
            store.local.del(REMEMBER_KEY);
            store.local.del(REMEMBER_EMAIL_KEY);
        }

        // temporary network hiccups: try once more before showing an error
        const TEMP = ["auth/network-request-failed", "auth/internal-error", "auth/timeout"];
        try {
            await withTimeout(signInWithEmailAndPassword(auth, email, password), 10000, "auth/timeout");
        } catch (e1) {
            if (!TEMP.includes(e1 && e1.code)) throw e1;
            await new Promise(r => setTimeout(r, 500));
            await withTimeout(signInWithEmailAndPassword(auth, email, password), 12000, "auth/timeout");
        }
        document.getElementById("loginPassword").value = "";
    } catch (err) {
        loggedInThisPage = false;
        store.session.del(SESSION_KEY);
        showLoginError(friendlyAuthError(err));
    } finally {
        // keep the guard on a little longer: the auth callback can arrive after sign-in resolves
        loginBusy = false;
        setTimeout(() => { loginInProgress = false; }, 1500);
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${ic('log-in')} Sign in`;
    }
};

// Saved-password (autofill) fix: the first tap on Sign in is often swallowed while the keyboard /
// autofill bar closes and the layout shifts. React on pointerup of the button itself instead.
(function wireLoginTap() {
    const btn = document.getElementById("loginSubmitBtn");
    const form = document.getElementById("loginForm");
    if (!btn || !form) return;
    btn.addEventListener("pointerup", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        window.handleLogin(e);
    });
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (e.detail === 0) window.handleLogin(e);   // Enter key / keyboard "Go" (no pointer): still sign in
    });
    // some browsers fill the password without telling the page: re-read it on blur / change
    ["loginEmail", "loginPassword"].forEach(id => {
        const el = document.getElementById(id);
        if (el) ["change", "animationstart"].forEach(ev => el.addEventListener(ev, () => {}));
    });
})();

window.handleLogout = async function() {
    try {
        loggedInThisPage = false;
        store.session.del(SESSION_KEY);
        // Logging out manually forgets "Remember Me" so the next visit asks for login again
        store.local.del(REMEMBER_KEY);
        await signOut(auth);
    } catch (err) {
        uiAlert("Logout Error: " + err.message);
    }
};

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const dbInstance = e.target.result;
            if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
                dbInstance.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject("IndexedDB Error: " + e.target.error);
    });
}

function addSingleItemToDB(item) {
    return new Promise((resolve, reject) => {
        if (!db) { reject("DB not initialized"); return; }
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

function getAllGalleryItemsDB() {
    return new Promise((resolve, reject) => {
        if (!db) { resolve([]); return; }
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = (e) => reject(e.target.error);
    });
}

function deleteGalleryItemDB(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

function clearGalleryStoreDB() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

// --- Pretty dialog (replaces the browser's confirm()/uiAlert()) ---
// showDialog({title, message, confirmText, cancelText, tone, icon}) -> Promise<boolean>
// No cancelText => info box with one button.
let dialogResolve = null;
function closeDialog(result) {
    const el = document.getElementById("appDialog");
    if (el) el.classList.add("hidden");
    const r = dialogResolve; dialogResolve = null;
    if (r) r(result);
}
function showDialog({ title, message = "", confirmText = "OK", cancelText = null, tone = "danger", icon = "alert-triangle", confirmIcon = null }) {
    if (dialogResolve) closeDialog(false);   // only one at a time
    const el = document.getElementById("appDialog");
    document.getElementById("appDialogIcon").className = `dlg-icon is-${tone}`;
    document.getElementById("appDialogIcon").innerHTML = ic(icon);
    document.getElementById("appDialogTitle").textContent = title;
    const msgEl = document.getElementById("appDialogMsg");
    msgEl.textContent = message;
    msgEl.classList.toggle("hidden", !message);
    const okBtn = document.getElementById("appDialogOk");
    okBtn.className = `btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`;
    okBtn.innerHTML = `${confirmIcon ? ic(confirmIcon) : ""} ${confirmText}`;
    const noBtn = document.getElementById("appDialogCancel");
    noBtn.textContent = cancelText || "";
    noBtn.classList.toggle("hidden", !cancelText);
    document.getElementById("appDialogFoot").classList.toggle("is-single", !cancelText);
    el.classList.remove("hidden");
    setTimeout(() => (cancelText ? noBtn : okBtn).focus(), 30);
    return new Promise(resolve => { dialogResolve = resolve; });
}
window.appDialogOk = () => closeDialog(true);
window.appDialogCancel = () => closeDialog(false);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dialogResolve) closeDialog(false);
});
document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "appDialog") closeDialog(false);   // tap outside = cancel
});
// Simple message box used instead of uiAlert()
window.uiAlert = function(message, opts = {}) {
    const isErr = /error|မရ|fail/i.test(message);
    return showDialog({
        title: opts.title || (isErr ? "Something went wrong" : "Notice"),
        message,
        confirmText: "OK",
        tone: opts.tone || (isErr ? "danger" : "info"),
        icon: opts.icon || (isErr ? "alert-circle" : "check-circle")
    });
};

// --- Cancellable job (staging photos / uploading chapter) ---
let activeJob = null;
const cancelError = () => { const e = new Error("Cancelled"); e.name = "Cancelled"; return e; };
const isCancel = (err) => err && err.name === "Cancelled";
function startJob(kind = "upload") { activeJob = { kind, cancelled: false, locked: false, xhrs: new Set() }; return activeJob; }
function abortJob(job) { job.cancelled = true; job.xhrs.forEach(x => { try { x.abort(); } catch (_) {} }); }
window.cancelCurrentJob = async function() {
    const job = activeJob;
    if (!job || job.locked || job.cancelled) return;
    const isUpload = job.kind === "upload";
    const ok = await showDialog(isUpload ? {
        title: "Upload ကို ရပ်မလား?",
        message: "Chapter ကို မသိမ်းတော့ပါဘူး။ ရွေးထားတဲ့ပုံတွေတော့ ကျန်ပါသေးတယ်။",
        confirmText: "Stop upload", cancelText: "Keep going", icon: "alert-triangle", confirmIcon: "x"
    } : {
        title: "ထည့်နေတာကို ရပ်မလား?",
        message: "အခုထည့်ပြီးသွားတဲ့ ပုံတွေကို ပြန်ဖျက်ပါမယ်။",
        confirmText: "Stop", cancelText: "Keep going", icon: "alert-triangle", confirmIcon: "x"
    });
    // the job may have finished (or locked into saving) while the box was open
    if (!ok || activeJob !== job || job.locked || job.cancelled) return;
    abortJob(job);
    document.querySelectorAll(".progress-cancel").forEach(b => { b.disabled = true; b.textContent = "Cancelling..."; });
};

// Upload file directly to Cloudinary (Unsigned Upload) - XHR so we get REAL byte progress
function uploadToCloudinaryOnce(fileOrDataUrl, onProgress, job, cloud) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        if (typeof fileOrDataUrl === "string") formData.append("file", fileOrDataUrl);
        else formData.append("file", fileOrDataUrl, "page.webp");
        formData.append("upload_preset", CLOUD_ACCOUNTS[cloud]);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `https://api.cloudinary.com/v1_1/${cloud}/image/upload`);
        if (job) job.xhrs.add(xhr);
        const done = () => { if (job) job.xhrs.delete(xhr); };
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        };
        xhr.onabort = () => { done(); reject(cancelError()); };
        xhr.onload = () => {
            done();
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch (_) {}
            if (data.secure_url) {
                if (onProgress) onProgress(1);
                resolve(data.secure_url);
            } else {
                reject(new Error(data.error?.message || "Cloudinary upload failed"));
            }
        };
        xhr.onerror = () => { done(); reject(new Error("Network error")); };
        xhr.ontimeout = () => { done(); reject(new Error("Upload timed out")); };
        xhr.send(formData);
    });
}

// Retries up to 2 extra times so one flaky request doesn't kill the whole chapter
async function uploadToCloudinary(fileOrDataUrl, onProgress, retries = 2, job = null, cloud = CLOUD_IDS[0]) {
    if (!CLOUD_ACCOUNTS[cloud]) throw new Error("Unknown Cloudinary account: " + cloud);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (job && job.cancelled) throw cancelError();
        try {
            if (onProgress) onProgress(0);
            return await uploadToCloudinaryOnce(fileOrDataUrl, onProgress, job, cloud);
        } catch (err) {
            if (isCancel(err) || (job && job.cancelled)) throw cancelError();
            lastErr = err;
            if (attempt < retries) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
        }
    }
    throw lastErr;
}

// --- Image compression (done in the browser before upload) ---
// off  : send the original file untouched
// high : WebP 92%  (visually lossless, recommended)
// small: WebP 82%  (smaller files, still clean)
let compressMode = "high";
const COMPRESS_PRESETS = { off: null, high: { quality: 0.92, maxWidth: 2400 }, small: { quality: 0.82, maxWidth: 1800 } };
const COMPRESS_LABELS = { off: "Original (no compression)", high: "High quality (recommended)", small: "Smaller size" };

const dataUrlBytes = (u) => typeof u === "string" ? Math.round((u.length - u.indexOf(",") - 1) * 0.75) : (u.size || 0);

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("decode failed"));
        img.src = dataUrl;
    });
}

// Returns { file, before, after }. Never makes a file bigger: if the result isn't clearly
// smaller (or anything goes wrong) the ORIGINAL is sent instead.
async function compressForUpload(dataUrl, mode) {
    const before = dataUrlBytes(dataUrl);
    const preset = COMPRESS_PRESETS[mode];
    const original = { file: dataUrl, before, after: before };
    if (!preset) return original;
    if (/^data:image\/(gif|svg)/i.test(dataUrl)) return original;   // keep animated/vector as is
    try {
        const img = await loadImageFromDataUrl(dataUrl);
        let w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return original;
        if (w > preset.maxWidth) { h = Math.round(h * preset.maxWidth / w); w = preset.maxWidth; }
        if (w * h > 16000000) return original;                       // too big for a phone canvas
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        const blob = await new Promise(res => canvas.toBlob(res, "image/webp", preset.quality));
        canvas.width = 0; canvas.height = 0;
        if (!blob || blob.type !== "image/webp") return original;    // browser can't encode WebP
        if (blob.size > before * 0.9) return original;               // not worth it
        return { file: blob, before, after: blob.size };
    } catch (err) {
        console.warn("Compression skipped:", err);
        return original;
    }
}
const fmtMB = (b) => (b / 1048576).toFixed(b >= 1048576 * 10 ? 0 : 1) + " MB";

window.selectCompress = function(mode) {
    compressMode = mode;
    document.getElementById("compressText").textContent = COMPRESS_LABELS[mode];
    document.querySelectorAll("#compressMenu .select-option").forEach(o => {
        o.classList.toggle("is-current", o.dataset.value === mode);
    });
    document.getElementById("compressMenu").classList.add("hidden");
    document.getElementById("compressTrigger").classList.remove("is-open");
};
window.toggleCompressMenu = function() {
    const menu = document.getElementById("compressMenu");
    const opening = menu.classList.contains("hidden");
    const sm = document.getElementById("uploadSpeedMenu");
    if (sm) { sm.classList.add("hidden"); document.getElementById("uploadSpeedTrigger").classList.remove("is-open"); }
    menu.classList.toggle("hidden", !opening);
    document.getElementById("compressTrigger").classList.toggle("is-open", opening);
};
document.addEventListener("click", (e) => {
    if (!e.target.closest("#compressWrap")) {
        const m = document.getElementById("compressMenu");
        const t = document.getElementById("compressTrigger");
        if (m) m.classList.add("hidden");
        if (t) t.classList.remove("is-open");
    }
});

// --- Upload speed (how many images are sent at once) ---
let uploadBatchSize = 2;
window.selectUploadSpeed = function(value) {
    uploadBatchSize = value;
    const label = value === 1 ? "1 image at a time" : `${value} images at a time`;
    document.getElementById("uploadSpeedText").textContent = label;
    document.querySelectorAll("#uploadSpeedMenu .select-option").forEach(o => {
        o.classList.toggle("is-current", Number(o.dataset.value) === value);
    });
    document.getElementById("uploadSpeedMenu").classList.add("hidden");
    document.getElementById("uploadSpeedTrigger").classList.remove("is-open");
};
window.toggleUploadSpeedMenu = function() {
    const menu = document.getElementById("uploadSpeedMenu");
    const opening = menu.classList.contains("hidden");
    const cm = document.getElementById("compressMenu");
    if (cm) { cm.classList.add("hidden"); document.getElementById("compressTrigger").classList.remove("is-open"); }
    menu.classList.toggle("hidden", !opening);
    document.getElementById("uploadSpeedTrigger").classList.toggle("is-open", opening);
};
document.addEventListener("click", (e) => {
    if (!e.target.closest("#uploadSpeedWrap")) {
        const m = document.getElementById("uploadSpeedMenu");
        const t = document.getElementById("uploadSpeedTrigger");
        if (m) m.classList.add("hidden");
        if (t) t.classList.remove("is-open");
    }
});

// --- Library: show the Normal box OR the Adult box ---
let libMode = "normal";
try { if (localStorage.getItem("sakura_lib_mode") === "adult") libMode = "adult"; } catch (e) {}
window.switchLib = function(mode) {
    libMode = mode === "adult" ? "adult" : "normal";
    try { localStorage.setItem("sakura_lib_mode", libMode); } catch (e) {}
    document.getElementById("libBoxNormal").classList.toggle("hidden", libMode !== "normal");
    document.getElementById("libBoxAdult").classList.toggle("hidden", libMode !== "adult");
    document.getElementById("btnLibNormal").classList.toggle("is-active", libMode === "normal");
    document.getElementById("btnLibAdult").classList.toggle("is-active", libMode === "adult");
};
switchLib(libMode);

// --- Cloudinary account pickers (one for the cover form, one for the chapter form) ---
const cloudChoice = { cover: CLOUD_IDS[0], chapter: CLOUD_IDS[0] };
(function () {
    ["cover", "chapter"].forEach(kind => {
        try { const saved = localStorage.getItem("sakura_cloud_" + kind); if (saved && CLOUD_ACCOUNTS[saved]) cloudChoice[kind] = saved; } catch (e) {}
    });
})();
const currentCloud = (kind) => cloudChoice[kind];
function renderCloudMenu(kind) {
    const menu = document.getElementById(kind + "CloudMenu");
    const text = document.getElementById(kind + "CloudText");
    if (!menu || !text) return;
    menu.innerHTML = CLOUD_IDS.map(cloud =>
        `<div class="select-option${cloud === cloudChoice[kind] ? " is-current" : ""}" data-value="${esc(cloud)}" onclick="selectCloud('${kind}','${esc(cloud)}')">${esc(cloudLabel(cloud))}</div>`
    ).join("");
    text.textContent = cloudLabel(cloudChoice[kind]);
}
window.selectCloud = function(kind, cloud) {
    if (!CLOUD_ACCOUNTS[cloud]) return;
    cloudChoice[kind] = cloud;
    try { localStorage.setItem("sakura_cloud_" + kind, cloud); } catch (e) {}
    renderCloudMenu(kind);
    document.getElementById(kind + "CloudMenu").classList.add("hidden");
    document.getElementById(kind + "CloudTrigger").classList.remove("is-open");
};
window.toggleCloudMenu = function(kind) {
    const menu = document.getElementById(kind + "CloudMenu");
    const opening = menu.classList.contains("hidden");
    ["uploadSpeedMenu", "compressMenu", "coverCloudMenu", "chapterCloudMenu"].forEach(id => {
        const m = document.getElementById(id), t = document.getElementById(id.replace("Menu", "Trigger"));
        if (m) m.classList.add("hidden");
        if (t) t.classList.remove("is-open");
    });
    menu.classList.toggle("hidden", !opening);
    document.getElementById(kind + "CloudTrigger").classList.toggle("is-open", opening);
};
document.addEventListener("click", (e) => {
    ["cover", "chapter"].forEach(kind => {
        if (!e.target.closest("#" + kind + "CloudWrap")) {
            const m = document.getElementById(kind + "CloudMenu");
            const t = document.getElementById(kind + "CloudTrigger");
            if (m) m.classList.add("hidden");
            if (t) t.classList.remove("is-open");
        }
    });
});
renderCloudMenu("cover");
renderCloudMenu("chapter");

// --- Progress helper: uses the bar inside the gallery modal when it is open, otherwise the form bar ---
function getProgressUI() {
    const modalOpen = !document.getElementById("sakuraGalleryModal").classList.contains("hidden");
    const p = modalOpen ? "modalProgress" : "zipProgress";
    const wrapper = document.getElementById(p + "Wrapper");
    const bar = document.getElementById(p + "Bar");
    const percentEl = document.getElementById(p + "Percent");
    const textEl = document.getElementById(p + "Text");
    return {
        show(text, percent = 0) {
            wrapper.classList.remove("hidden");
            document.querySelectorAll(".progress-cancel").forEach(b => { b.disabled = false; b.textContent = "Cancel"; });
            this.set(text, percent);
        },
        set(text, percent) {
            const pct = Math.max(0, Math.min(100, Math.round(percent)));
            bar.style.width = pct + "%";
            percentEl.textContent = pct + "%";
            if (text) textEl.innerHTML = `${ic('loader','ic-spin')} ${text}`;
        },
        hide() { wrapper.classList.add("hidden"); }
    };
}

window.switchTab = function(tabName) {
    const tabs = { mangaTab: ["btnMangaTab", "mangaUploadForm"], chapterTab: ["btnChapterTab", "chapterUploadForm"], layoutTab: ["btnLayoutTab", "layoutPanel"] };
    Object.entries(tabs).forEach(([name, [btnId, panelId]]) => {
        document.getElementById(btnId).classList.toggle("is-active", name === tabName);
        document.getElementById(panelId).classList.toggle("hidden", name !== tabName);
    });
    if (tabName === 'chapterTab') populateMangaDropdown();
    if (tabName === 'layoutTab') lcOpen();
}

// --- Firebase nodes: normal manga and adult manga are kept in two separate places ---
const MAIN_NODE = 'manga_list';
const ADULT_NODE = 'adult_list';
const ADULT_TYPES = ['Doujin', 'Pornhwa'];                       // these Types go to ADULT_NODE
const nodeForType = (t) => ADULT_TYPES.includes(String(t || '')) ? ADULT_NODE : MAIN_NODE;
const mangaNodeById = {};                                        // manga id -> node it lives in

// read both nodes and merge them: [{ id, node, data }]
async function readAllMangaNodes() {
    const out = [];
    for (const node of [MAIN_NODE, ADULT_NODE]) {
        const snap = await get(child(ref(database), node));
        if (!snap.exists()) continue;
        const data = snap.val() || {};
        Object.keys(data).forEach(id => { mangaNodeById[id] = node; out.push({ id, node, data: data[id] || {} }); });
    }
    return out;
}
const nodeOf = (id) => mangaNodeById[id] || MAIN_NODE;
let chapterPriceMap = {};   // chapterPrices from Data B: "mangaId__chapterId" -> coins
const priceKey = (m, c) => String(m + "__" + c).replace(/[.#$\[\]\/]/g, "_");
async function loadChapterPrices() {
    try { const s = await get(ref(dbB, "chapterPrices")); chapterPriceMap = s.exists() ? (s.val() || {}) : {}; }
    catch (e) { chapterPriceMap = chapterPriceMap || {}; }
}

let mangaPickData = [];

async function populateMangaDropdown() {
    if (!document.getElementById("chapterMangaSelect")) return;
    try {
        const all = await readAllMangaNodes();
        mangaPickData = [];
        all.forEach(({ id, data: m }) => {
            mangaPickData.push({
                id,
                title: m.title || id,
                image: m.image || m.cover_image || "",
                status: m.status || m.chapter || "Ongoing",
                type: m.coverType || "Manga",
                chapters: Object.keys(m.chapters || {}).length
            });
        });
        // keep the current choice if it still exists
        const cur = document.getElementById("chapterMangaSelect");
        if (cur.value && !mangaPickData.some(x => x.id === cur.value)) cur.value = "";
        updateMangaPickerTrigger();
        renderMangaPicker();
    } catch (err) {
        console.error("Error loading mangas from Firebase:", err);
    }
}

function mangaThumb(m, cls) {
    return m.image
        ? `<img class="${cls}" src="${esc(m.image)}" alt="" loading="lazy">`
        : `<span class="${cls} pick-noimg">${ic('image')}</span>`;
}

function updateMangaPickerTrigger() {
    const box = document.getElementById("mangaPickSelected");
    const id = document.getElementById("chapterMangaSelect").value;
    const m = mangaPickData.find(x => x.id === id);
    box.innerHTML = m
        ? `${mangaThumb(m, "pick-thumb")}<span class="pick-text"><strong>${esc(m.title)}</strong><small>${esc(m.status)} · ${esc(m.type)} · ${m.chapters} ch</small></span>`
        : `<span class="pick-ph">${ic('book-open')} Select manga</span>`;
}

window.renderMangaPicker = function() {
    const list = document.getElementById("mangaPickList");
    const q = (document.getElementById("mangaPickSearch").value || "").trim().toLowerCase();
    const cur = document.getElementById("chapterMangaSelect").value;
    const items = mangaPickData.filter(m => !q || m.title.toLowerCase().includes(q));
    document.getElementById("mangaPickCount").textContent = items.length;
    if (!items.length) {
        list.innerHTML = `<div class="pick-empty">${ic('folder-open')}${mangaPickData.length ? "No manga found" : "No manga uploaded yet"}</div>`;
        return;
    }
    list.innerHTML = items.map(m => `
        <button type="button" class="pick-item${m.id === cur ? " is-selected" : ""}" role="option" data-id="${esc(m.id)}">
            ${mangaThumb(m, "pick-thumb")}
            <span class="pick-text"><strong>${esc(m.title)}</strong>
                <small><span class="status-text" data-status="${esc(m.status)}">${esc(m.status)}</span> · ${esc(m.type)} · ${m.chapters} ch</small></span>
            <span class="pick-check">${ic('check')}</span>
        </button>`).join("");
}

window.toggleMangaPicker = function() {
    const menu = document.getElementById("mangaPickMenu");
    ['statusMenu', 'coverTypeMenu', 'modalStatusMenu'].forEach(m => { const el = document.getElementById(m); if (el) el.classList.add('hidden'); });
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !opening);
    document.getElementById("mangaPickTrigger").classList.toggle("is-open", opening);
    if (opening) {
        document.getElementById("mangaPickSearch").value = "";
        renderMangaPicker();
        const sel = menu.querySelector(".pick-item.is-selected");
        if (sel) sel.scrollIntoView({ block: "nearest" });
    }
};

(function initMangaPicker() {
    const list = document.getElementById("mangaPickList");
    if (!list) return;
    list.addEventListener("click", (e) => {
        const item = e.target.closest(".pick-item");
        if (!item) return;
        document.getElementById("chapterMangaSelect").value = item.dataset.id;
        updateMangaPickerTrigger();
        document.getElementById("mangaPickMenu").classList.add("hidden");
        document.getElementById("mangaPickTrigger").classList.remove("is-open");
    });
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#mangaPick")) {
            document.getElementById("mangaPickMenu").classList.add("hidden");
            document.getElementById("mangaPickTrigger").classList.remove("is-open");
        }
    });
})();

window.startGalleryPickerProcess = function() {
    openSakuraGalleryModal();
}

window.openSakuraGalleryModal = async function() {
    const modal = document.getElementById("sakuraGalleryModal");
    modal.classList.remove("hidden");
    if (tempModalSelectedImages.length === 0) {
        tempModalSelectedImages = [...finalSelectedChapterImages];
    }
    await renderSakuraGalleryGrid();
}

window.closeSakuraGalleryModal = function() {
    document.getElementById("sakuraGalleryModal").classList.add("hidden");
}

// Cancel / X: throw away every photo in the box that was NOT confirmed with "Select & Add"
window.cancelSakuraGalleryModal = async function() {
    const keep = new Set(finalSelectedChapterImages.map(i => i.id));
    let all = [];
    try { all = await getAllGalleryItemsDB(); } catch (_) {}
    const extra = all.filter(i => !keep.has(i.id));
    const staging = activeJob && activeJob.kind === "stage" && !activeJob.cancelled;
    if (extra.length > 0 || staging) {
        const ok = await showDialog({
            title: "Discard these photos?",
            message: extra.length > 0
                ? `"Select & Add" မနှိပ်ရသေးတဲ့ ပုံ ${extra.length} ပုံကို Box ထဲကနေ ဖျက်မှာပါ။`
                : "ထည့်နေတာကို ရပ်လိုက်ပါမယ်။",
            confirmText: "Discard", cancelText: "Keep editing", icon: "trash", confirmIcon: "trash"
        });
        if (!ok) return;
    }
    if (activeJob && !activeJob.locked && activeJob.kind === "stage") abortJob(activeJob);
    try {
        const now = await getAllGalleryItemsDB();
        for (const it of now) { if (!keep.has(it.id)) { try { await deleteGalleryItemDB(it.id); } catch (_) {} } }
    } catch (err) { console.error(err); }
    tempModalSelectedImages = [...finalSelectedChapterImages];
    closeSakuraGalleryModal();
}

// Clean all: empty the whole box (and the current selection)
window.cleanAllGalleryPhotos = async function() {
    const ok = await showDialog({
        title: "Clean all photos?",
        message: "Box ထဲက ပုံအားလုံးနဲ့ ရွေးထားတဲ့ပုံတွေကိုပါ ဖျက်မှာပါ။ ပြန်ယူလို့ မရပါဘူး။",
        confirmText: "Clean all", cancelText: "Keep them", icon: "trash", confirmIcon: "trash"
    });
    if (!ok) return;
    try { await clearGalleryStoreDB(); } catch (err) { uiAlert("ဖျက်လို့မရပါ: " + err.message); return; }
    tempModalSelectedImages = [];
    finalSelectedChapterImages = [];
    renderSakuraSelectedPreview();
    await renderSakuraGalleryGrid();
}

window.triggerDevicePhotoPicker = function() {
    document.getElementById("realGalleryFileInput").click();
}

window.triggerZipFilePicker = function() {
    document.getElementById("realZipFileInput").click();
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(reader.error || new Error("Read failed"));
        reader.readAsDataURL(file);
    });
}

// Retry a failing step a few times before giving up
async function withRetry(fn, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); }
        catch (err) { lastErr = err; await new Promise(r => setTimeout(r, 300 * (i + 1))); }
    }
    throw lastErr;
}

async function rollbackSaved(items) {
    for (const it of items) { try { await deleteGalleryItemDB(it.id); } catch (_) {} }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ALL-OR-NOTHING: if any image fails, everything added in this batch is rolled back
window.loadDevicePhotosToGallery = async function(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    const ui = getProgressUI();
    const job = startJob("stage");
    const total = files.length;
    const saved = [];
    ui.show(`Adding Photos (0/${total})...`, 0);
    try {
        for (let i = 0; i < total; i++) {
            if (job.cancelled) throw cancelError();
            const file = files[i];
            let dataUrl;
            try { dataUrl = await withRetry(() => readFileAsDataURL(file)); }
            catch (err) { throw new Error(`"${file.name}" ကို ဖတ်လို့မရပါ`); }
            const item = { id: 'gal-' + Date.now() + '-' + Math.random(), name: file.name, data: dataUrl };
            try { await withRetry(() => addSingleItemToDB(item)); }
            catch (err) { throw new Error(`"${file.name}" ကို သိမ်းလို့မရပါ`); }
            saved.push(item);
            ui.set(`Adding Photos (${saved.length}/${total})...`, (saved.length / total) * 100);
        }
        document.getElementById("realGalleryFileInput").value = "";
        tempModalSelectedImages = [...tempModalSelectedImages, ...saved];
        await wait(400);
        ui.hide();
        activeJob = null;
        await openSakuraGalleryModal();
    } catch (err) {
        await rollbackSaved(saved);
        ui.hide();
        document.getElementById("realGalleryFileInput").value = "";
        if (isCancel(err)) { await renderSakuraGalleryGrid(); activeJob = null; return; }
        uiAlert("ပုံတွေ မထည့်ပေးနိုင်ပါ (ဘာမှ မထည့်ထားပါ)\n" + err.message + "\nပြန်ရွေးပြီး ထပ်စမ်းကြည့်ပါ။");
    }
}

window.loadZipFileToGallery = async function(event) {
    const file = event.target.files[0];
    if (!file) return;
    const ui = getProgressUI();
    const job = startJob("stage");
    const saved = [];
    ui.show("Reading ZIP...", 0);
    try {
        const zip = await JSZip.loadAsync(file);
        if (job.cancelled) throw cancelError();
        let zipFiles = [];
        zip.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && /\.(jpe?g|png|webp|gif)$/i.test(zipEntry.name)) zipFiles.push(zipEntry);
        });
        zipFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        if (zipFiles.length === 0) {
            ui.hide();
            document.getElementById("realZipFileInput").value = "";
            uiAlert("No valid images (jpg, png, webp, gif) found in the ZIP file.");
            return;
        }
        const total = zipFiles.length;
        ui.set(`Extracting ZIP (0/${total})...`, 0);
        for (let i = 0; i < total; i++) {
            if (job.cancelled) throw cancelError();
            const zipEntry = zipFiles[i];
            const fileName = zipEntry.name.split('/').pop();
            let rawDataUrl;
            try {
                const base64Data = await withRetry(() => zipEntry.async("base64"));
                const lowerName = zipEntry.name.toLowerCase();
                const mimeType = lowerName.endsWith('.png') ? 'image/png' : lowerName.endsWith('.webp') ? 'image/webp' : lowerName.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
                rawDataUrl = `data:${mimeType};base64,${base64Data}`;
            } catch (err) { throw new Error(`"${fileName}" ကို ZIP ထဲကနေ ဖတ်လို့မရပါ`); }
            const item = { id: 'gal-zip-' + Date.now() + '-' + Math.random(), name: fileName, data: rawDataUrl };
            try { await withRetry(() => addSingleItemToDB(item)); }
            catch (err) { throw new Error(`"${fileName}" ကို သိမ်းလို့မရပါ`); }
            saved.push(item);
            ui.set(`Extracting ZIP (${saved.length}/${total})...`, (saved.length / total) * 100);
        }
        document.getElementById("realZipFileInput").value = "";
        tempModalSelectedImages = [...tempModalSelectedImages, ...saved];
        await wait(400);
        ui.hide();
        activeJob = null;
        await openSakuraGalleryModal();
    } catch (err) {
        await rollbackSaved(saved);
        ui.hide();
        document.getElementById("realZipFileInput").value = "";
        if (isCancel(err)) { await renderSakuraGalleryGrid(); activeJob = null; return; }
        uiAlert("ZIP ထဲက ပုံတွေ မထည့်ပေးနိုင်ပါ (ဘာမှ မထည့်ထားပါ)\n" + err.message + "\nပြန်ထပ်စမ်းကြည့်ပါ။");
    }
}

async function renderSakuraGalleryGrid() {
    const grid = document.getElementById("sakuraGalleryGrid");
    const countBadge = document.getElementById("modalSelectedCount");
    if (!grid) return;
    const gallery = await getAllGalleryItemsDB();
    grid.innerHTML = "";
    if (gallery.length === 0) {
        grid.innerHTML = `
            <div class="gallery-empty">
                ${ic('images')}
                No photos yet. Use "Add Photos" or "Upload ZIP" above.
            </div>
        `;
        countBadge.textContent = "0 selected";
        return;
    }
    gallery.forEach((item) => {
        const isSelected = tempModalSelectedImages.some(sel => sel.id === item.id);
        const card = document.createElement("div");
        card.className = `gitem${isSelected ? ' is-selected' : ''}`;
        card.onclick = () => toggleModalImageSelection(item.id);
        card.innerHTML = `
            <img src="${item.data}" alt="${esc(item.name)}">
            <div class="gcheck">${isSelected ? ic('check') : ''}</div>
            <button type="button" onclick="event.stopPropagation(); deletePhotoFromSakuraGallery('${item.id}')" class="gdel" title="Delete Photo">
                ${ic('trash')}
            </button>
            <div class="gname">${esc(item.name)}</div>
        `;
        grid.appendChild(card);
    });
    countBadge.textContent = `${tempModalSelectedImages.length} selected`;
}

window.toggleModalImageSelection = async function(itemId) {
    const gallery = await getAllGalleryItemsDB();
    const item = gallery.find(g => g.id === itemId);
    if (!item) return;
    const index = tempModalSelectedImages.findIndex(sel => sel.id === itemId);
    if (index !== -1) {
        tempModalSelectedImages.splice(index, 1);
    } else {
        tempModalSelectedImages.push(item);
    }
    await renderSakuraGalleryGrid();
}

window.deletePhotoFromSakuraGallery = async function(itemId) {
    await deleteGalleryItemDB(itemId);
    tempModalSelectedImages = tempModalSelectedImages.filter(sel => sel.id !== itemId);
    await renderSakuraGalleryGrid();
}

window.confirmSakuraGallerySelection = function() {
    finalSelectedChapterImages = [...tempModalSelectedImages];
    closeSakuraGalleryModal();
    renderSakuraSelectedPreview();
}

function renderSakuraSelectedPreview() {
    const wrapper = document.getElementById("sakuraSelectedPreviewWrapper");
    const grid = document.getElementById("sakuraSelectedGridContainer");
    const badge = document.getElementById("sakuraSelectedCountBadge");
    const triggerText = document.getElementById("galleryTriggerText");
    if (finalSelectedChapterImages.length === 0) {
        wrapper.classList.add("hidden");
        triggerText.textContent = "Open Gallery";
        return;
    }
    wrapper.classList.remove("hidden");
    badge.textContent = `${finalSelectedChapterImages.length} image(s) selected`;
    triggerText.textContent = `Add more images (${finalSelectedChapterImages.length} ready)`;
    grid.innerHTML = "";
    finalSelectedChapterImages.forEach((imgObj, index) => {
        const card = document.createElement("div");
        card.className = "thumb";
        card.innerHTML = `
            <img src="${imgObj.data}" alt="Preview">
            <button type="button" onclick="removeSakuraSelectedImage(${index})" class="thumb-remove" title="Remove">
                ${ic('x')}
            </button>
        `;
        grid.appendChild(card);
    });
}

window.removeSakuraSelectedImage = function(index) {
    finalSelectedChapterImages.splice(index, 1);
    renderSakuraSelectedPreview();
}

window.clearSakuraSelection = function() {
    finalSelectedChapterImages = [];
    renderSakuraSelectedPreview();
}

window.toggleCustomDropdown = function(menuId) {
    const menus = ['statusMenu', 'coverTypeMenu', 'modalStatusMenu'];
    menus.forEach(m => {
        if (m !== menuId) {
            const el = document.getElementById(m);
            if (el) el.classList.add('hidden');
        }
    });
    const targetMenu = document.getElementById(menuId);
    if (targetMenu) targetMenu.classList.toggle('hidden');
    syncDropdownTriggers();
}

function syncDropdownTriggers() {
    document.querySelectorAll('.select-wrap').forEach(wrap => {
        const menu = wrap.querySelector('.select-menu');
        const trigger = wrap.querySelector('.select-trigger');
        if (menu && trigger) trigger.classList.toggle('is-open', !menu.classList.contains('hidden'));
    });
}

window.selectCustomOption = function(hiddenInputId, displayTextId, value, menuId) {
    document.getElementById(hiddenInputId).value = value;
    const textEl = document.getElementById(displayTextId);
    textEl.textContent = value;
    // Colour is driven by CSS via data-status (Complete = blue, Pause = amber, otherwise teal)
    textEl.dataset.status = value;
    document.getElementById(menuId).classList.add('hidden');
    syncDropdownTriggers();
}

document.addEventListener('click', function(e) {
    if (!e.target.closest('.select-wrap')) {
        ['statusMenu', 'coverTypeMenu', 'modalStatusMenu'].forEach(m => {
            const el = document.getElementById(m);
            if (el) el.classList.add('hidden');
        });
        syncDropdownTriggers();
    }
});

// --- GENRES (grouped, searchable box) ---
const GENRE_GROUPS = [
    ["Popular", ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Romance", "Sci-Fi", "Horror", "Mystery", "Thriller"]],
    ["Audience", ["Shonen", "Shoujo", "Seinen", "Josei", "Kids"]],
    ["Setting & Theme", ["Isekai", "School Life", "Slice of Life", "Supernatural", "Historical", "Martial Arts", "Magic", "Mecha", "Sports", "Cultivation", "Reincarnation", "Time Travel", "Post-Apocalyptic", "Survival", "Superhero", "Game", "Military", "Crime"]],
    ["Adult (18+)", ["Adult", "Mature", "Smut", "Erotica", "Uncensored", "Yaoi", "Yuri", "NTR", "Netorare", "Cheating", "Vanilla", "Femdom", "BDSM", "Milf", "Office Romance", "Forbidden Love", "Revenge", "Dark", "Full Color"]],
    ["Mood & Style", ["Psychological", "Tragedy", "Gore", "Ecchi", "Harem", "Reverse Harem", "Villainess", "Demons", "Vampire", "Music", "Cooking", "Medical", "Office Life"]]
];

function renderGenreBox() {
    const box = document.getElementById("genreScroll");
    if (!box || box.dataset.ready) return;
    box.dataset.ready = "1";
    box.innerHTML = GENRE_GROUPS.map(([title, items]) => `
        <section class="genre-group">
            <h4 class="genre-title">${esc(title)}</h4>
            <div class="chips">
                ${items.map(g => `<label class="chip" data-name="${esc(g.toLowerCase())}"><input type="checkbox" name="genreCheckbox" value="${esc(g)}"><span>${esc(g)}</span></label>`).join("")}
            </div>
        </section>`).join("") + `<div id="genreEmpty" class="genre-empty hidden">No genre found</div>`;
    // Lock scroll positions while toggling chips so nothing jumps
    box.addEventListener("pointerdown", () => {
        box._st = box.scrollTop; box._wy = window.scrollY;
    });
    box.addEventListener("change", () => {
        updateGenreCount();
        const st = box._st, wy = box._wy;
        if (st != null) { box.scrollTop = st; window.scrollTo(window.scrollX, wy); }
        requestAnimationFrame(() => { if (st != null) { box.scrollTop = st; window.scrollTo(window.scrollX, wy); } });
    });
    const form = document.getElementById("mangaUploadForm");
    if (form) form.addEventListener("reset", () => setTimeout(() => { filterGenres(); updateGenreCount(); }, 0));
    updateGenreCount();
}

function updateGenreCount() {
    const n = document.querySelectorAll('input[name="genreCheckbox"]:checked').length;
    const el = document.getElementById("genreCount");
    if (el) { el.textContent = `${n} selected`; el.classList.toggle("is-on", n > 0); }
    const btn = document.getElementById("genreClearBtn");
    const num = document.getElementById("genreClearNum");
    if (btn) btn.disabled = n === 0;
    if (num) num.textContent = n;
}

window.filterGenres = function() {
    const q = (document.getElementById("genreSearch").value || "").trim().toLowerCase();
    let any = false;
    document.querySelectorAll("#genreScroll .genre-group").forEach(group => {
        let shown = 0;
        group.querySelectorAll(".chip").forEach(chip => {
            const ok = !q || chip.dataset.name.includes(q);
            chip.classList.toggle("hidden", !ok);
            if (ok) shown++;
        });
        group.classList.toggle("hidden", shown === 0);
        if (shown) any = true;
    });
    const empty = document.getElementById("genreEmpty");
    if (empty) empty.classList.toggle("hidden", any);
}

window.clearGenres = function() {
    document.querySelectorAll('input[name="genreCheckbox"]:checked').forEach(c => { c.checked = false; });
    const btn = document.getElementById("genreClearBtn");
    if (btn) { btn.classList.remove("is-pop"); void btn.offsetWidth; btn.classList.add("is-pop"); }
    updateGenreCount();
}

renderGenreBox();

window.previewCoverImage = function(event) {
    const file = event.target.files[0];
    const previewContainer = document.getElementById("imagePreviewContainer");
    const previewImg = document.getElementById("imagePreview");
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            previewImg.src = e.target.result;
            previewContainer.classList.remove("hidden");
        };
        reader.readAsDataURL(file);
    } else {
        previewImg.src = "";
        previewContainer.classList.add("hidden");
    }
}

// --- MANGA COVER UPLOAD (CLOUDINARY & FIREBASE) ---
window.handleMangaUpload = async function(event) {
    event.preventDefault();
    const title = document.getElementById("upTitle").value.trim();
    const status = document.getElementById("upStatus").value;
    const coverType = document.getElementById("upCoverType").value;
    const rating = document.getElementById("upRating").value.trim();
    const description = document.getElementById("upDescription").value.trim();
    const imageFile = document.getElementById("upImageFile").files[0];
    const successMsg = document.getElementById("successMsg");
    const submitBtn = document.getElementById("mangaSubmitBtn");
    
    const selectedGenres = [];
    document.querySelectorAll('input[name="genreCheckbox"]:checked').forEach((checkbox) => {
        selectedGenres.push(checkbox.value);
    });
    const genresString = selectedGenres.length > 0 ? selectedGenres.join(', ') : 'Action';
    if (!imageFile || !title) return;
    
    submitBtn.disabled = true;
    submitBtn.innerHTML = `${ic('loader','ic-spin')} Uploading...`;
    try {
        const coverCloud = currentCloud("cover");
        const coverImageUrl = await uploadToCloudinary(imageFile, null, 2, null, coverCloud);
        const mangaId = 'manga-' + Date.now();
        
        const newMangaData = {
            id: mangaId,
            title: title,
            status: status,
            chapter: status,
            genre: genresString,
            coverType: coverType,
            rating: rating,
            description: description,
            image: coverImageUrl,
            cloud: coverCloud,
            chapters: {}
        };
        
        const targetNode = nodeForType(coverType);
        if (targetNode === ADULT_NODE) newMangaData.adult = true;
        await set(ref(database, targetNode + '/' + mangaId), newMangaData);
        mangaNodeById[mangaId] = targetNode;
        
        document.getElementById("mangaUploadForm").reset();
        document.getElementById("imagePreviewContainer").classList.add("hidden");
        selectCustomOption('upStatus', 'statusSelectedText', 'Ongoing', 'statusMenu');
        selectCustomOption('upCoverType', 'coverTypeSelectedText', 'Manga', 'coverTypeMenu');
        
        showSuccessNotice(successMsg);
        renderManagedCovers();
    } catch (err) {
        uiAlert("Upload Error: " + err.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${ic('upload')} Upload Manga Cover`;
    }
}

// --- CHAPTER UPLOAD (CLOUDINARY & FIREBASE) ---
window.handleChapterUpload = async function(event) {
    event.preventDefault();
    const mangaSelectEl = document.getElementById("chapterMangaSelect");
    const mangaId = mangaSelectEl ? mangaSelectEl.value.trim() : "";
    const chapterTitleInput = document.getElementById("chapterTitleInput");
    const chapterTitle = chapterTitleInput ? chapterTitleInput.value.trim() : "";
    const successMsg = document.getElementById("successMsg");
    const submitBtn = document.getElementById("chapterSubmitBtn");
    
    if (!mangaId) { await uiAlert("Please select a manga.", { title: "Select a manga" }); return; }
    if (!chapterTitle) { await uiAlert("Please enter a chapter name or number.", { title: "Chapter name needed" }); return; }
    const coinsInputEl = document.getElementById("chapterCoinsInput");
    const chapterCoins = coinsInputEl && coinsInputEl.value.trim() !== "" ? Math.floor(Number(coinsInputEl.value)) : 0;
    if (!isFinite(chapterCoins) || chapterCoins < 0) { await uiAlert("Coins must be 0 or a positive number.", { title: "Invalid coins" }); return; }
    if (chapterCoins > 0 && !authBAdmin.currentUser) { await uiAlert("The coins list is saved in Project B. Open User Accounts Manage and sign in to B first, then upload again.", { title: "Sign in to B first" }); return; }
    if (finalSelectedChapterImages.length === 0) { await uiAlert("Please select chapter images first.", { title: "No images selected" }); return; }
    
    submitBtn.disabled = true;
    const ui = getProgressUI();
    const job = startJob();
    const total = finalSelectedChapterImages.length;
    const batchSize = Math.max(1, uploadBatchSize);
    const mode = compressMode;
    const chapterCloud = currentCloud("chapter");
    let bytesBefore = 0, bytesAfter = 0;
    ui.show(`Uploading to Cloudinary (0/${total})...`, 0);

    try {
        const uploadedPagesUrls = new Array(total);   // keeps the original page order
        let doneCount = 0;
        // Counter and % come from the same number: only FINISHED images count.
        // Capped at 99% until the chapter is really saved in Firebase.
        const refresh = () => {
            ui.set(`Uploading to Cloudinary (${doneCount}/${total})...`, Math.min(99, (doneCount / total) * 100));
        };

        for (let i = 0; i < total; i += batchSize) {
            const batch = finalSelectedChapterImages.slice(i, i + batchSize);
            await Promise.all(batch.map(async (imgObj, k) => {
                const idx = i + k;
                if (job.cancelled) throw cancelError();
                const packed = await compressForUpload(imgObj.data, mode);
                if (job.cancelled) throw cancelError();
                bytesBefore += packed.before;
                bytesAfter += packed.after;
                uploadedPagesUrls[idx] = await uploadToCloudinary(packed.file, null, 2, job, chapterCloud);
                doneCount++;
                refresh();
            }));
        }
        if (job.cancelled) throw cancelError();
        job.locked = true;   // too late to cancel once we start saving
        document.querySelectorAll(".progress-cancel").forEach(b => { b.disabled = true; });
        ui.set(`Saving chapter (${total}/${total})...`, 99);

        const chapterId = 'ch-' + Date.now();
        const newChapterData = {
            chapter_number: chapterTitle,
            chapter_title: chapterTitle,
            created_at: Date.now(),
            cloud: chapterCloud,
            pages: uploadedPagesUrls
        };
        // locked chapter: the price goes to the coins list in Firebase B (saved BEFORE the chapter so it can never appear free)
        if (chapterCoins > 0) await set(ref(dbB, "chapterPrices/" + String(mangaId + "__" + chapterId).replace(/[.#$\[\]\/]/g, "_")), chapterCoins);
        
        await set(ref(database, `${nodeOf(mangaId)}/${mangaId}/chapters/${chapterId}`), newChapterData);
        
        if (chapterTitleInput) chapterTitleInput.value = "";
        if (coinsInputEl) coinsInputEl.value = "";
        if (mangaSelectEl) mangaSelectEl.selectedIndex = 0;
        
        finalSelectedChapterImages = [];
        tempModalSelectedImages = [];
        clearSakuraSelection();
        await clearGalleryStoreDB();
        
        const saving = bytesBefore - bytesAfter;
        const note = mode !== "off" && saving > 0 ? ` · ${fmtMB(bytesBefore)} → ${fmtMB(bytesAfter)}` : "";
        ui.set(`Done (${total}/${total})${note}`, 100);
        await wait(note ? 1800 : 700);
        ui.hide();
        showSuccessNotice(successMsg);
        renderManagedCovers();
    } catch (err) {
        abortJob(job);   // stop any image still uploading in the background
        ui.hide();
        if (isCancel(err)) {
            await uiAlert("Chapter ကို မသိမ်းထားပါ။ ရွေးထားတဲ့ပုံတွေ ကျန်ပါသေးတယ်။", { title: "Upload ရပ်လိုက်ပါပြီ", tone: "info", icon: "check-circle" });
        } else {
            uiAlert("Chapter Upload Error: " + err.message);
        }
    } finally {
        submitBtn.disabled = false;
        activeJob = null;
    }
}

function showSuccessNotice(msgEl) {
    if (!msgEl) return;
    msgEl.classList.remove("hidden");
    setTimeout(() => { msgEl.classList.add("hidden"); }, 3000);
}

function updateStats(mangas, chapters, ongoing) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("statMangaCount", mangas);
    set("statChapterCount", chapters);
    set("statOngoingCount", ongoing);
}

// --- RENDER MANAGED COVERS FROM FIREBASE ---
// The Library is split in two boxes:  Normal (manga_list)  and  Adult (adult_list)
const coinsOfCh = (m, c) => Math.max(0, Math.floor(Number(chapterPriceMap[priceKey(m, c)]) || 0));
function buildMangaCard(mangaId, manga) {
    const mangaCard = document.createElement("div");
    mangaCard.className = "manga";

    const mangaStatus = manga.status || manga.chapter || 'Ongoing';
    const chaptersObj = manga.chapters || {};
    const chapterKeys = Object.keys(chaptersObj);
    const safeId = esc(mangaId);

    let chaptersHtml = '';
    if (chapterKeys.length > 0) {
        chapterKeys.forEach(chId => {
            const ch = chaptersObj[chId] || {};
            const pagesLen = ch.pages ? ch.pages.length : 0;
            chaptersHtml += `
                <div class="chapter-row">
                    <span class="chapter-name"><span class="chapter-title">${esc(ch.chapter_title || "Chapter")}</span><span class="chapter-tags"><span class="chapter-pages">${pagesLen} pages</span>${cloudTag(ch.cloud || cloudFromUrl(ch.pages && ch.pages[0]))}${coinsOfCh(mangaId, chId) > 0 ? `<span class="chapter-coin" title="Locked: ${coinsOfCh(mangaId, chId)} coins">${ic("coins")}${coinsOfCh(mangaId, chId)}</span>` : ""}</span></span>
                    <button type="button" onclick="promptDelete('chapter', '${safeId}', '${esc(chId)}')" class="icon-btn is-red" title="Delete Chapter">
                        ${ic('trash')}
                    </button>
                </div>
            `;
        });
    } else {
        chaptersHtml = `<div class="chapter-none">No chapters yet.</div>`;
    }

    mangaCard.innerHTML = `
        <div class="manga-main">
            <img class="manga-cover" src="${esc(manga.image || manga.cover_image || '')}" alt="${esc(manga.title)}" loading="lazy">
            <div class="manga-info">
                <span class="manga-title">${esc(manga.title)}</span>
                <div class="manga-meta">
                    <span class="status-text" data-status="${esc(mangaStatus)}">${esc(mangaStatus)}</span>
                    <span class="dot"></span>
                    <span class="type">${esc(manga.coverType || 'Manga')}</span>
                    <span class="cloud-inline">${cloudTag(manga.cloud || cloudFromUrl(manga.image || manga.cover_image))}</span>
                </div>
            </div>
            <div class="manga-side">
              <div class="cloud-top">${cloudTag(manga.cloud || cloudFromUrl(manga.image || manga.cover_image))}</div>
              <div class="manga-actions">
                <button type="button" onclick="openEditModal('${safeId}', '${esc(mangaStatus)}')" class="icon-btn is-teal" title="Edit Status">
                    ${ic('pencil')}
                </button>
                <button type="button" onclick="promptDelete('manga', '${safeId}')" class="icon-btn is-red" title="Delete Manga">
                    ${ic('trash')}
                </button>
              </div>
            </div>
        </div>
        <details class="chapters">
            <summary>${ic('chevron-right')} Chapters (${chapterKeys.length})</summary>
            <div class="chapter-list">
                ${chaptersHtml}
            </div>
        </details>
    `;
    return mangaCard;
}

async function renderManagedCovers() {
    const boxes = [
        { node: MAIN_NODE,  list: document.getElementById("managedCoversListNormal"), badge: document.getElementById("normalCountBadge"), empty: "No normal manga uploaded yet." },
        { node: ADULT_NODE, list: document.getElementById("managedCoversListAdult"),  badge: document.getElementById("adultCountBadge"),  empty: "No adult manga uploaded yet." }
    ];
    if (!boxes[0].list || !boxes[1].list) return;
    const countBadge = document.getElementById("totalUploadsCount");

    try {
        await loadChapterPrices();
        const allItems = await readAllMangaNodes();
        let totalChapters = 0, totalOngoing = 0;
        renderCoinHistory(allItems);

        boxes.forEach(box => {
            const items = allItems.filter(it => it.node === box.node);
            box.list.innerHTML = "";
            if (box.badge) box.badge.textContent = String(items.length);
            if (items.length === 0) {
                box.list.innerHTML = `<div class="empty">${ic('folder-open')}${box.empty}</div>`;
                return;
            }
            items.forEach(({ id, data }) => {
                const mg = data || {};
                totalChapters += Object.keys(mg.chapters || {}).length;
                if ((mg.status || mg.chapter || 'Ongoing') === 'Ongoing') totalOngoing++;
                box.list.appendChild(buildMangaCard(id, mg));
            });
        });

        if (countBadge) countBadge.textContent = allItems.length === 0 ? "0 Items" : `${allItems.length} Mangas`;
        updateStats(allItems.length, totalChapters, totalOngoing);
    } catch (err) {
        console.error("Error fetching managed covers:", err);
    }
}

window.openEditModal = function(mangaId, currentStatus) {
    document.getElementById("editMangaId").value = mangaId;
    selectCustomOption('modalStatusValue', 'modalStatusText', currentStatus, 'modalStatusMenu');
    document.getElementById("editStatusModal").classList.remove("hidden");
}

window.closeEditModal = function() {
    document.getElementById("editStatusModal").classList.add("hidden");
}

window.saveMangaStatus = async function() {
    const mangaId = document.getElementById("editMangaId").value;
    const newStatus = document.getElementById("modalStatusValue").value;
    try {
        await update(ref(database, `${nodeOf(mangaId)}/${mangaId}`), {
            status: newStatus,
            chapter: newStatus
        });
        closeEditModal();
        renderManagedCovers();
    } catch (err) {
        uiAlert("Error updating status: " + err.message);
    }
}

window.promptDelete = function(targetType, parentId, targetId = '') {
    document.getElementById("deleteTargetType").value = targetType;
    document.getElementById("deleteTargetParentId").value = parentId;
    document.getElementById("deleteTargetId").value = targetId;
    const descEl = document.getElementById("deleteModalDesc");
    if (targetType === 'manga') {
        descEl.textContent = "Are you sure you want to delete this manga and all its chapters from Firebase?";
    } else {
        descEl.textContent = "Are you sure you want to delete this chapter from Firebase?";
    }
    delReset();
    document.getElementById("deleteConfirmModal").classList.remove("hidden");
}

let delBusy = false;
window.closeDeleteModal = function() {
    if (delBusy) return;   // can't close while deleting
    document.getElementById("deleteConfirmModal").classList.add("hidden");
}

// --- Delete progress UI (Cloudinary -> Firebase) ---
function delReset() {
    delBusy = false;
    const box = document.getElementById("delProgress");
    box.classList.add("hidden");
    box.classList.remove("is-error", "is-done");
    delSetStep("delStepCloud", "", "");
    delSetStep("delStepFb", "", "");
    delSetBar(0, "Starting...");
    document.getElementById("deleteModalDesc").classList.remove("hidden");
    const ok = document.getElementById("delConfirmBtn"), no = document.getElementById("delCancelBtn");
    ok.disabled = false; no.disabled = false; no.classList.remove("hidden");
    ok.innerHTML = `${ic("trash")} Delete`;
}
function delSetStep(id, state, countText) {
    const el = document.getElementById(id);
    el.className = "del-step" + (state ? " is-" + state : "");
    const icons = { active: ic("loader", "ic-spin"), done: ic("check-circle"), error: ic("alert-circle"), skip: "" };
    el.querySelector(".del-ico").innerHTML = icons[state] || "";
    el.querySelector(".del-count").textContent = countText || "";
}
function delSetBar(pct, text) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    document.getElementById("delBar").style.width = p + "%";
    document.getElementById("delPercent").textContent = p + "%";
    if (text) document.getElementById("delStatusText").textContent = text;
}

// Every Cloudinary image that belongs to a manga (cover + all chapter pages) or to one chapter
function collectImageUrls(targetType, node) {
    const urls = [];
    if (!node) return urls;
    const addChapter = (ch) => { if (ch && Array.isArray(ch.pages)) ch.pages.forEach(u => { if (typeof u === "string") urls.push(u); }); };
    if (targetType === "manga") {
        if (typeof node.image === "string") urls.push(node.image);
        if (typeof node.cover_image === "string") urls.push(node.cover_image);
        Object.values(node.chapters || {}).forEach(addChapter);
    } else {
        addChapter(node);
    }
    return urls;
}

// Ask the Worker to delete these images from Cloudinary (in small batches so we can show real progress).
// Throws if anything could not be deleted.
const CLEAN_BATCH = 10;
async function deleteImagesFromCloudinary(urls, onProgress) {
    if (!CLEANER_URL || urls.length === 0) return;
    const user = auth.currentUser;
    if (!user) throw new Error("Please sign in again.");
    let done = 0;
    for (let i = 0; i < urls.length; i += CLEAN_BATCH) {
        const batch = urls.slice(i, i + CLEAN_BATCH);
        const token = await user.getIdToken();   // cached; refreshes automatically when needed
        let res, data = {};
        try {
            res = await fetch(CLEANER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
                body: JSON.stringify({ urls: batch })
            });
        } catch (e) { throw new Error("Cannot reach the Cloudinary cleaner (network)."); }
        try { data = await res.json(); } catch (_) {}
        if (!res.ok || !data.ok) throw new Error(data.error || ("Cloudinary cleaner error " + res.status));
        done += batch.length;
        if (onProgress) onProgress(done, urls.length);
    }
}

window.confirmDelete = async function() {
    if (delBusy) return;
    const targetType = document.getElementById("deleteTargetType").value;
    const parentId = document.getElementById("deleteTargetParentId").value;
    const targetId = document.getElementById("deleteTargetId").value;
    const path = targetType === 'manga'
        ? `${nodeOf(parentId)}/${parentId}`
        : `${nodeOf(parentId)}/${parentId}/chapters/${targetId}`;

    // lock the dialog + show progress
    delBusy = true;
    const box = document.getElementById("delProgress");
    const okBtn = document.getElementById("delConfirmBtn"), noBtn = document.getElementById("delCancelBtn");
    box.classList.remove("hidden", "is-error", "is-done");
    document.getElementById("deleteModalDesc").classList.add("hidden");
    okBtn.disabled = true; noBtn.disabled = true;
    okBtn.innerHTML = `${ic("loader", "ic-spin")} Deleting...`;

    let stage = "cloud";
    try {
        // 1) Cloudinary first: if it fails we stop, so Firebase still points to the images and you can retry.
        let urls = [];
        if (CLEANER_URL) {
            delSetStep("delStepCloud", "active", "");
            delSetStep("delStepFb", "", "");
            delSetBar(2, "Reading item...");
            const snap = await get(ref(database, path));
            urls = collectImageUrls(targetType, snap.val());
        }
        if (CLEANER_URL && urls.length > 0) {
            delSetBar(5, `Deleting from Cloudinary (0/${urls.length})...`);
            delSetStep("delStepCloud", "active", `0/${urls.length}`);
            await deleteImagesFromCloudinary(urls, (d, t) => {
                delSetStep("delStepCloud", "active", `${d}/${t}`);
                delSetBar(5 + (d / t) * 85, `Deleting from Cloudinary (${d}/${t})...`);
            });
            delSetStep("delStepCloud", "done", `${urls.length}/${urls.length}`);
        } else {
            delSetStep("delStepCloud", "skip", CLEANER_URL ? "no images" : "skipped");
        }

        // 2) then remove from Firebase
        stage = "firebase";
        delSetStep("delStepFb", "active", "");
        delSetBar(92, "Deleting from Firebase...");
        await remove(ref(database, path));
        delSetStep("delStepFb", "done", "");
        box.classList.add("is-done");
        delSetBar(100, "Deleted successfully");
        okBtn.innerHTML = `${ic("check-circle")} Done`;

        await new Promise(r => setTimeout(r, 900));
        delBusy = false;
        closeDeleteModal();
        renderManagedCovers();
    } catch (err) {
        delBusy = false;
        box.classList.add("is-error");
        delSetStep(stage === "cloud" ? "delStepCloud" : "delStepFb", "error", "failed");
        document.getElementById("delStatusText").textContent =
            (stage === "cloud" ? "Cloudinary delete failed - nothing removed from Firebase. " : "Firebase delete failed. ") + (err.message || "");
        okBtn.disabled = false; noBtn.disabled = false;
        okBtn.innerHTML = `${ic("trash")} Retry`;
    }
}

function initSakuraPetals() {
    const canvas = document.getElementById('sakuraCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    const petals = Array.from({ length: 15 }, () => ({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        size: Math.random() * 3.5 + 2,
        speedY: Math.random() * 0.6 + 0.2,
        speedX: Math.random() * 0.3 - 0.15,
        rotation: Math.random() * 360,
        rotationSpeed: Math.random() * 1 - 0.5,
        opacity: Math.random() * 0.3 + 0.12
    }));
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        petals.forEach(p => {
            p.y += p.speedY;
            p.x += p.speedX;
            p.rotation += p.rotationSpeed;
            if (p.y > canvas.height) {
                p.y = -10;
                p.x = Math.random() * canvas.width;
            }
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.globalAlpha = p.opacity;
            ctx.fillStyle = '#2dd4bf';
            ctx.beginPath();
            ctx.ellipse(0, 0, p.size, p.size * 1.5, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
        requestAnimationFrame(animate);
    }
    animate();
}

window.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    initSakuraPetals();
});


/* =====================================================================
   LAYOUT CONTROL  -  size / position of Reze, Makima and the Adult pictures
   Saved in Firebase "layoutControl" -> { normal:{hero,history}, adult:{hero,history} }, each {size,x,y}
   Same numbers as the website:  size = % (100 = normal) | x = px (+ right) | y = px (+ down)
   ===================================================================== */
const LC_SITE = 'https://tomatomanga.github.io/Sakura-Realm/';        // where reze.webp / makima.webp / adult-*.webp live
const LC_IMG = { normal: { hero: 'reze.webp', history: 'makima.webp' }, adult: { hero: 'adult-hero.webp', history: 'adult-history.webp' } };
const LC_DEFAULT = {
    normal: { hero: { size: 100, x: 0, y: 0 },  history: { size: 100, x: 0, y: 0 } },
    adult:  { hero: { size: 100, x: 0, y: 14 }, history: { size: 100, x: 0, y: 0 } }      // = the website's built-in adult defaults
};
const LC_LIMITS = { size: [20, 300, 1], x: [-500, 500, 1], y: [-500, 500, 1] };          // min, max, step
const lcClone = (o) => JSON.parse(JSON.stringify(o));
let lcState = lcClone(LC_DEFAULT);
let lcMode = 'normal';
let lcLoaded = false;

const lcClamp = (key, v) => { const [lo, hi] = LC_LIMITS[key]; v = Number(v); if (!isFinite(v)) v = 0; return Math.min(hi, Math.max(lo, Math.round(v * 10) / 10)); };

function lcBuildControls() {
    document.querySelectorAll('.lc-ctrls').forEach(box => {
        if (box.dataset.built) return; box.dataset.built = '1';
        const part = box.dataset.lcPart;
        const rows = [['size', 'Size %'], ['x', 'Left / Right'], ['y', 'Up / Down']];
        box.innerHTML = rows.map(([k, label]) => {
            const [lo, hi, st] = LC_LIMITS[k];
            return `<div class="lc-row">
                <label>${label}</label>
                <button type="button" class="lc-nudge" data-part="${part}" data-key="${k}" data-d="-1">&minus;</button>
                <input type="range" min="${lo}" max="${hi}" step="${st}" data-part="${part}" data-key="${k}">
                <button type="button" class="lc-nudge" data-part="${part}" data-key="${k}" data-d="1">+</button>
                <input type="number" step="0.5" data-part="${part}" data-key="${k}" inputmode="decimal">
            </div>`;
        }).join('') + `<button type="button" class="lc-reset" data-reset="${part}">Reset this box</button>`;
    });
}

// load a picture from the site, then from the local folder; never leave a broken image on screen
function lcSetPic(img, file) {
    if (img.dataset.file === file) return;
    img.dataset.file = file;
    const tries = [LC_SITE + file, file];
    const next = () => {
        if (img.dataset.file !== file) return;
        const url = tries.shift();
        if (!url) { img.style.visibility = 'hidden'; return; }
        const t = new Image();
        t.onload = () => { if (img.dataset.file === file) { img.src = url; img.style.visibility = ''; } };
        t.onerror = next;
        t.src = url;
    };
    next();
}

function lcRender() {
    const adult = lcMode === 'adult';
    document.querySelectorAll('[data-lc-mode]').forEach(b => b.classList.toggle('is-active', b.dataset.lcMode === lcMode));
    document.getElementById('lcHeroBox').classList.toggle('is-adult', adult);
    document.getElementById('lcHistBox').classList.toggle('is-adult', adult);

    // --- Home hero: identical formulas to the website CSS ---
    const h = lcState[lcMode].hero, hp = document.getElementById('lcHeroPic');
    const hurl = LC_SITE + LC_IMG[lcMode].hero;
    if (hp.dataset.src !== hurl) { hp.dataset.src = hurl; hp.style.backgroundImage = `url("${hurl}")`; }
    hp.style.backgroundSize = `auto ${h.size * (adult ? 1.37 : 1)}%`;
    hp.style.backgroundPosition = `calc(100% + ${h.x}px) ${h.y}px`;

    // --- History: right / bottom / height exactly like the website. Picture follows Normal / Adult ---
    const m = lcState[lcMode].history, mp = document.getElementById('lcHistPic');
    lcSetPic(mp, LC_IMG[lcMode].history);
    document.querySelector('#lcHistBox .lc-hist-name').textContent = adult ? 'Adult history' : 'Nothing read yet';
    mp.style.right = `calc(${adult ? 5 : -4}px - ${m.x}px)`;
    mp.style.bottom = `${-m.y}px`;
    mp.style.height = `${m.size}%`;

    // --- sliders / numbers ---
    document.querySelectorAll('.lc-ctrls input').forEach(inp => {
        const v = lcState[lcMode][inp.dataset.part][inp.dataset.key];
        if (document.activeElement !== inp || inp.type === 'range') inp.value = v;
    });
}

function lcSet(part, key, value) {
    lcState[lcMode][part][key] = lcClamp(key, value);
    lcRender();
    const st = document.getElementById('lcStatus'); st.textContent = 'Not saved yet'; st.className = 'lc-status';
}

window.lcSetMode = (mode) => { lcMode = mode === 'adult' ? 'adult' : 'normal'; lcRender(); };

async function lcOpen() {
    lcBuildControls(); lcRender();
    if (lcLoaded) return;
    const st = document.getElementById('lcStatus'); st.textContent = 'Loading saved layout...'; st.className = 'lc-status';
    try {
        const snap = await get(ref(database, 'layoutControl'));
        const v = snap.exists() ? snap.val() : {};
        ['normal', 'adult'].forEach(mode => ['hero', 'history'].forEach(part => ['size', 'x', 'y'].forEach(k => {
            const n = v && v[mode] && v[mode][part] && Number(v[mode][part][k]);
            if (v && v[mode] && v[mode][part] && isFinite(n)) lcState[mode][part][k] = lcClamp(k, n);
        })));
        lcLoaded = true; lcRender(); st.textContent = snap.exists() ? 'Loaded saved layout' : 'No saved layout yet - showing defaults';
    } catch (e) {
        st.textContent = 'Could not load saved layout (' + (e && e.code || 'error') + ')'; st.className = 'lc-status is-err';
    }
}

window.lcSave = async () => {
    const btn = document.getElementById('lcSaveBtn'), st = document.getElementById('lcStatus');
    btn.disabled = true; st.textContent = 'Saving...'; st.className = 'lc-status';
    try {
        await set(ref(database, 'layoutControl'), lcClone(lcState));
        lcLoaded = true;
        st.textContent = 'Saved - the website updates on next open'; st.className = 'lc-status is-ok';
    } catch (e) {
        st.textContent = 'Save failed (' + (e && e.code || 'error') + '). Check the Firebase rules for layoutControl.'; st.className = 'lc-status is-err';
    } finally { btn.disabled = false; }
};

// sliders, number boxes, +/- buttons, reset
document.addEventListener('input', (e) => {
    const t = e.target; if (!t.closest || !t.closest('.lc-ctrls')) return;
    lcSet(t.dataset.part, t.dataset.key, t.value);
});
document.addEventListener('click', (e) => {
    const n = e.target.closest && e.target.closest('.lc-nudge');
    if (n) { const p = n.dataset.part, k = n.dataset.key; lcSet(p, k, lcState[lcMode][p][k] + Number(n.dataset.d)); return; }
    const r = e.target.closest && e.target.closest('[data-reset]');
    if (r) { const p = r.dataset.reset; lcState[lcMode][p] = Object.assign({}, LC_DEFAULT[lcMode][p]); lcRender(); }
});

// drag the picture with finger / mouse
(function lcDrag() {
    let drag = null;
    document.addEventListener('pointerdown', (e) => {
        const el = e.target.closest && e.target.closest('[data-lc-drag]'); if (!el) return;
        const part = el.dataset.lcDrag, s = lcState[lcMode][part];
        drag = { el, part, id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: s.x, y0: s.y };
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        el.classList.add('lc-dragging'); e.preventDefault();
    });
    document.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        lcSet(drag.part, 'x', drag.x0 + (e.clientX - drag.sx));
        lcSet(drag.part, 'y', drag.y0 + (e.clientY - drag.sy));
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) { drag.el.classList.remove('lc-dragging'); drag = null; } };
    document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
})();

// =====================================================================
// USER ACCOUNTS MANAGE (Firebase project B)
// Auth (B)            : email + password login (Firebase keeps the real password hash)
// B DB users/{uid}    : { email, active, createdAt }   (profile only)
// B DB coinAccounts/{uid} : { coins }                        <- Coins accounts only
// B DB paidAccounts/{uid} : { days, startedAt }              <- Paid accounts only (days only: 1 month = 30 days; days 0 = No active)
// B DB userSecrets/{uid} : { password }  (ENCRYPTED, admin-only; the database never shows the real password, the Uploader decrypts it for you)
// =====================================================================
const firebaseConfigB = {
  apiKey: "AIzaSyD2D-QH6R-90PTn5mN0OG4QHLT8cCoJaBA",
  authDomain: "sakura-realm-user.firebaseapp.com",
  databaseURL: "https://sakura-realm-user-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sakura-realm-user",
  storageBucket: "sakura-realm-user.firebasestorage.app",
  messagingSenderId: "685194449190",
  appId: "1:685194449190:web:ac83e1db140662bc5171e7"
};
const appBAdmin = initializeApp(firebaseConfigB, "bAdmin");     // signed in as the B admin
const authBAdmin = getAuth(appBAdmin);
const dbB = getDatabase(appBAdmin);
const appBCreate = initializeApp(firebaseConfigB, "bCreate");   // only creates accounts, then signs out
const authBCreate = getAuth(appBCreate);

const UM_MONTHS = [[1, "1 Month"], [2, "2 Months"], [3, "3 Months"], [5, "5 Months"], [12, "1 Year"]];
const umEl = (id) => document.getElementById(id);
const umEsc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let umToastT = null;
// bottom toast: tells what was just done (icon + short title + detail), slides up from the bottom
function umToast(title, detail, kind, icon) {
    const el = umEl("umToast"); if (!el || !title) return;
    el.className = "um-toast " + (kind || "ok");
    el.innerHTML = `<span class="um-toast-ico">${umIcon(icon || (kind === "bad" ? "alert-circle" : "check-circle"))}</span><span class="um-toast-txt"><b>${umEsc(title)}</b>${detail ? `<small>${umEsc(detail)}</small>` : ""}</span>`;
    void el.offsetWidth; el.classList.add("show");
    clearTimeout(umToastT); umToastT = setTimeout(() => el.classList.remove("show"), 3600);
}
const umSay = (t, bad, icon, detail) => { if (t) umToast(t, detail, bad ? "bad" : "ok", icon); };
const umIcon = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const umPlanText = (p) => p.type === "coins" ? p.coins + " coins" : "Paid · " + p.days + " days";
const umMonthLabel = (m) => (UM_MONTHS.find(x => x[0] === m) || [m, m + " Months"])[1];
const umDate = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const UM_DAYS_PER_MONTH = 30;   // 1 month = 30 days (saved in Data B)
const umDays = (months) => months * UM_DAYS_PER_MONTH;
// Paid plan in Data B is saved as DAYS only: paidAccounts/{uid} = { days, startedAt }.  Days left = days - elapsed (0 => "No active").
const umPaidInfo = (p, createdAt) => {
    let days = 0, exp = 0;
    if (p && p.days !== undefined && p.days !== null) {
        days = Math.max(0, Number(p.days) || 0);
        const st = Number(p.startedAt) || (p.expiresAt ? Number(p.expiresAt) - (Number(p.months) ? Number(p.months) * 30 : days) * 86400000 : 0) || Number(createdAt) || Date.now();
        exp = st + days * 86400000;
    } else if (p) { exp = Number(p.expiresAt) || 0; days = Number(p.months) ? Number(p.months) * 30 : 0; }   // old accounts (months + expiresAt)
    const left = Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
    return { days, exp, left, active: exp > Date.now() };
};

window.umSetOpen = function (open) {
    document.querySelector(".layout").classList.toggle("um-open", open);
    umEl("umSwitchA").classList.toggle("is-on", open);
    umEl("umSwitchA").setAttribute("aria-pressed", String(open));
    window.scrollTo({ top: 0, behavior: "smooth" });
};

// ---- plan picker (Coins / Paid) shared by "New account" and "Manage plan" ----
function umPicker(box, st) {
    const draw = () => {
        box.innerHTML = `
          <div class="um-seg"><button type="button" data-t="coins" class="${st.type === "coins" ? "on" : ""}">${umIcon("coins")} Coins</button><button type="button" data-t="paid" class="${st.type === "paid" ? "on" : ""}">${umIcon("crown")} Paid</button></div>
          <div class="um-pick-body">${st.type === "coins"
            ? `<label class="um-field is-gold">${umIcon("coins")}<input type="number" min="0" step="1" inputmode="numeric" data-coins placeholder="How many coins?" value="${umEsc(st.coins)}"></label>`
            : `<div class="um-months">${UM_MONTHS.map(([m, l]) => `<button type="button" data-m="${m}" class="${st.months === m ? "on" : ""}"><b>${l}</b><small>${m * 30} days</small></button>`).join("")}</div>`}</div>`;
    };
    box.onclick = (e) => {
        const t = e.target.closest("[data-t]"), m = e.target.closest("[data-m]");
        if (t) { st.type = t.dataset.t; draw(); }
        if (m) { st.months = Number(m.dataset.m); draw(); }
    };
    box.oninput = (e) => { if (e.target.matches("[data-coins]")) st.coins = e.target.value; };
    draw();
}
function umPlanFrom(st) {
    if (st.type === "coins") {
        const n = Math.floor(Number(st.coins));
        if (st.coins === "" || !isFinite(n) || n < 0) return null;
        return { type: "coins", coins: n };
    }
    if (!st.months) return null;
    return { type: "paid", days: umDays(st.months) };
}
const umCreatePick = { type: "coins", coins: "", months: 1 };
const umEditPick = { type: "coins", coins: "", months: 1 };
umPicker(umEl("umPickCreate"), umCreatePick);

// ---- admin login to B ----
onAuthStateChanged(authBAdmin, (u) => {
    umEl("umLogin").classList.toggle("hidden", !!u);
    umEl("umBody").classList.toggle("hidden", !u);
    if (u) { umLoad(); }
    
});
window.umAdminLogin = async function (e) {
    e.preventDefault();
    const b = umEl("umLoginBtn"); b.disabled = true;
    try { await signInWithEmailAndPassword(authBAdmin, umEl("umAdminEmail").value.trim(), umEl("umAdminPass").value); umEl("umAdminPass").value = ""; }
    catch (err) { umSay("Login failed", true, "lock", err.code || err.message); }
    finally { b.disabled = false; }
};
window.umAdminLogout = () => signOut(authBAdmin);

// ---- create account ----
window.umCreate = async function (e) {
    e.preventDefault();
    const email = umEl("umEmail").value.trim(), pass = umEl("umPass").value, plan = umPlanFrom(umCreatePick);
    if (!/^\S+@\S+\.\S+$/.test(email)) return umSay("Invalid Gmail", true, "mail", "Enter a valid Gmail address.");
    if (pass.length < 6) return umSay("Password too short", true, "key", "Use 6 or more characters.");
    if (!plan) return umSay(umCreatePick.type === "coins" ? "Coins missing" : "Plan length missing", true, umCreatePick.type === "coins" ? "coins" : "calendar", umCreatePick.type === "coins" ? "Enter how many coins to give." : "Pick a plan length.");
    await umReady;
    if (!umKey) return umSay("Encryption unavailable", true, "lock", "Open the Uploader over https so passwords can be saved safely.");
    const btn = umEl("umCreateBtn"); btn.disabled = true;
    let uid = null;
    try {
        const cred = await createUserWithEmailAndPassword(authBCreate, email, pass);
        uid = cred.user.uid;
        await signOut(authBCreate);
        await set(ref(dbB, "users/" + uid), { email, active: true, createdAt: Date.now() });
        await umWritePlan(uid, plan);
        await set(ref(dbB, "userSecrets/" + uid), { password: await umEnc(pass) });
        umSay("Account created", false, "user-plus", email + " · " + umPlanText(plan));
        umEl("umEmail").value = ""; umEl("umPass").value = "";
        umLoad();
    } catch (err) {
        umSay(err.code === "auth/email-already-in-use" ? "Gmail already used" : (uid ? "Created, but saving failed" : "Create failed"), true, "alert-circle", err.code === "auth/email-already-in-use" ? "That Gmail already has an account." : (err.code || err.message));
    } finally { btn.disabled = false; }
};

// Coins accounts -> coinAccounts/{uid} = { coins } ; Paid accounts -> paidAccounts/{uid} = { months, days, expiresAt }
// An account lives in exactly ONE of the two; saving a plan moves it and clears the other + any old users/{uid}/plan.
async function umWritePlan(uid, plan) {
    const upd = { ["users/" + uid + "/plan"]: null };
    if (plan.type === "coins") { upd["coinAccounts/" + uid] = { coins: plan.coins }; upd["paidAccounts/" + uid] = null; }
    else { upd["paidAccounts/" + uid] = { days: plan.days, startedAt: Date.now() }; upd["coinAccounts/" + uid] = null; }
    await update(ref(dbB), upd);
}

// ---- password vault: passwords are stored ENCRYPTED in Data B (userSecrets); the Uploader opens them with your vault key ----
const UM_PFX = "enc1:";
let umKey = null;
const umB64 = (u8) => { let s = ""; u8.forEach(c => s += String.fromCharCode(c)); return btoa(s); };
const umUnB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function umDeriveKey(pass) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: new TextEncoder().encode("sakura-realm-vault-v1"), iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function umEnc(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, umKey, new TextEncoder().encode(text)));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return UM_PFX + umB64(all);
}
// returns the plain text, "" for nothing, or null when it is locked / cannot be opened
async function umDec(s) {
    if (!s) return "";
    if (!String(s).startsWith(UM_PFX)) return String(s);   // old plain value (gets encrypted on the next unlock)
    if (!umKey) return null;
    try {
        const all = umUnB64(String(s).slice(UM_PFX.length));
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, umKey, all.slice(12)));
    } catch (e) { return null; }
}
// no vault key to type: the Uploader opens the passwords by itself, the database only ever holds the encrypted text
const UM_SECRET = "sakura-realm-uploader::user-password-vault::v2";
const umReady = umDeriveKey(UM_SECRET).then(k => { umKey = k; }).catch(e => console.warn("crypto unavailable:", e && e.message));

// ---- history list (search + render) ----
let umData = {}, umRows = [];
function umHay(uid, u) {
    const p = u.plan || {}, pi = p.type === "paid" ? umPaidInfo(p, u.createdAt) : null;
    const bits = [u.email, p.type === "coins" ? "coins coin " + p.coins : p.type === "paid" ? "paid plan " + pi.left + " days " + (pi.active ? "active" : "no active inactive expired") : "no plan", u.createdAt ? umDate(u.createdAt) : ""];
    return bits.join(" ").toLowerCase();
}
function umRender() {
    const box = umEl("umList"), qi = umEl("umSearch"), q = (qi.value || "").trim().toLowerCase();
    umEl("umSearchClear").classList.toggle("hidden", !q);
    const toks = q ? q.split(/\s+/) : [];
    const rows = toks.length ? umRows.filter(([uid, u]) => { const h = umHay(uid, u); return toks.every(t => h.includes(t)); }) : umRows;
    umEl("umResult").textContent = q ? rows.length + " of " + umRows.length + " accounts" : umRows.length + " accounts";
    box.innerHTML = rows.length ? rows.map(([uid, u]) => {
        const p = u.plan || {};
        const tag = p.type === "coins" ? `<span class="um-tag coins">${umIcon("coins")} Coins</span>`
            : p.type === "paid" ? (umPaidInfo(p, u.createdAt).active ? `<span class="um-tag paid">${umIcon("crown")} Paid</span>` : `<span class="um-tag off">${umIcon("crown")} Paid · No active</span>`) : `<span class="um-tag none">No plan</span>`;
        let stats = "";
        if (p.type === "coins") stats = `<div class="um-kv is-gold">${umIcon("coins")}<span>Coins left</span><b>${umEsc(p.coins)}</b></div>`;
        else if (p.type === "paid") {
            const pi = umPaidInfo(p, u.createdAt);
            stats = `<div class="um-kv ${pi.active ? "is-teal" : "is-bad"}">${umIcon("calendar")}<span>Days left</span><b>${pi.left} days${pi.active ? ` <em>until ${umDate(pi.exp)}</em>` : ` <em>No active</em>`}</b></div>`;
        }
        if (u.createdAt) stats += `<div class="um-kv">${umIcon("history")}<span>Created</span><b>${umDate(u.createdAt)}</b></div>`;
        const pw = u.pwLocked
            ? `<span class="um-locked">${umIcon("lock")} unreadable</span>`
            : `<span data-real="${umEsc(u.password)}" data-hidden="1">${u.password ? "••••••••" : "—"}</span>${u.password ? `<button type="button" data-act="eye" title="Show / hide password">${umIcon("eye")}</button>` : ""}`;
        return `<div class="um-item" data-uid="${umEsc(uid)}">
          <div class="um-av">${umEsc((u.email || "?").charAt(0).toUpperCase())}</div>
          <div class="um-main"><div class="um-mail">${umEsc(u.email)}</div>
            <div class="um-pass">${umIcon("key")}${pw}</div></div>
          <div class="um-side"><button type="button" class="um-act edit" data-act="edit" title="Manage Coins / Paid">${umIcon("pencil")}</button><button type="button" class="um-act del" data-act="del" title="Delete account">${umIcon("trash")}</button></div>
          <div class="um-meta">${tag}<div class="um-kvs">${stats}</div></div></div>`;
    }).join("") : (q ? `<div class="um-empty">${umIcon("search")} No account matches "${umEsc(q)}".</div>` : '<div class="um-empty">No accounts yet. Create the first one above.</div>');
}
umEl("umSearch").addEventListener("input", umRender);
umEl("umSearchClear").addEventListener("click", () => { umEl("umSearch").value = ""; umRender(); umEl("umSearch").focus(); });

async function umLoad() {
    const box = umEl("umList");
    try {
        await umReady;
        const [us, ss, cs, ps] = await Promise.all([get(ref(dbB, "users")), get(ref(dbB, "userSecrets")), get(ref(dbB, "coinAccounts")), get(ref(dbB, "paidAccounts"))]);
        const users = us.exists() ? us.val() : {}, secrets = ss.exists() ? ss.val() : {};
        const coinAcc = cs.exists() ? cs.val() : {}, paidAcc = ps.exists() ? ps.val() : {};
        // Daily countdown: write the REAL days left back into Data B (30 -> 29 -> 28 ... -> 0). The end date never moves (startedAt is shifted with it).
        try {
            const upd = {};
            Object.entries(paidAcc).forEach(([uid, p]) => {
                const pi = umPaidInfo(p, (users[uid] || {}).createdAt);
                const legacy = p.months !== undefined || p.expiresAt !== undefined || p.days === undefined;
                if (legacy || Number(p.days) !== pi.left) {
                    const np = { days: pi.left, startedAt: pi.exp - pi.left * 86400000 };
                    upd["paidAccounts/" + uid] = np; paidAcc[uid] = np;
                }
            });
            if (Object.keys(upd).length) await update(ref(dbB), upd);
        } catch (e) { console.warn("days sync skipped:", e && e.message); }
        // old plain-text passwords get encrypted automatically
        const pws = {};
        for (const uid of Object.keys(users)) {
            const raw = (secrets[uid] || {}).password || "";
            const val = await umDec(raw);
            pws[uid] = { val: val === null ? "" : val, locked: val === null };
        }
        if (umKey) {
            try {
                const mig = {};
                for (const uid of Object.keys(users)) { const raw = (secrets[uid] || {}).password; if (raw && !String(raw).startsWith(UM_PFX)) mig["userSecrets/" + uid + "/password"] = await umEnc(raw); }
                if (Object.keys(mig).length) await update(ref(dbB), mig);
            } catch (e) { console.warn("vault migrate skipped:", e && e.message); }
        }
        umData = {};
        Object.entries(users).forEach(([uid, u]) => { const plan = coinAcc[uid] ? { type: "coins", coins: coinAcc[uid].coins } : paidAcc[uid] ? { type: "paid", ...paidAcc[uid] } : (u.plan || null);   // u.plan = old accounts not moved yet
            umData[uid] = { ...u, plan, password: pws[uid].val, pwLocked: pws[uid].locked }; });
        umRows = Object.entries(umData).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
        umEl("umCntAll").textContent = umRows.length;
        umEl("umCntCoins").textContent = umRows.filter(r => r[1].plan && r[1].plan.type === "coins").length;
        umEl("umCntPaid").textContent = umRows.filter(r => r[1].plan && r[1].plan.type === "paid").length;
        umRender();
    } catch (err) { box.innerHTML = ""; umSay("Could not load users", true, "alert-circle", err.code || err.message); }
}

let umEditUid = null;
umEl("umList").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const item = b.closest(".um-item"), uid = item.dataset.uid, u = umData[uid];
    if (b.dataset.act === "eye") {
        const sp = item.querySelector("[data-real]"), hidden = sp.dataset.hidden === "1";
        sp.textContent = hidden ? sp.dataset.real : "••••••••"; sp.dataset.hidden = hidden ? "0" : "1";
    }
    if (b.dataset.act === "edit") {
        umEditUid = uid; umEl("umEditMail").textContent = u.email;
        const p = u.plan || {};
        umEditPick.type = p.type === "paid" ? "paid" : "coins";
        umEditPick.coins = p.type === "coins" ? String(p.coins) : "";
        { const dd = p.type === "paid" ? umPaidInfo(p, u.createdAt).days : 0; umEditPick.months = (UM_MONTHS.find(x => x[0] * 30 === dd) || [1])[0]; }
        umPicker(umEl("umPickEdit"), umEditPick);
        umEl("umModal").classList.remove("hidden");
    }
    if (b.dataset.act === "del") {
        const ok = await showDialog({ title: "Delete this account?", message: u.email + " will lose access to Sakura Realm. (The login itself stays in B Authentication; remove it in the Firebase Console if you want it gone completely.)", confirmText: "Delete", cancelText: "Cancel" });
        if (!ok) return;
        try { await remove(ref(dbB, "users/" + uid)); await remove(ref(dbB, "userSecrets/" + uid)); await remove(ref(dbB, "coinAccounts/" + uid)); await remove(ref(dbB, "paidAccounts/" + uid)); umSay("Account deleted", false, "trash", u.email); umLoad(); }
        catch (err) { umSay("Delete failed", true, "alert-circle", err.code || err.message); }
    }
});
window.umCloseEdit = () => { umEl("umModal").classList.add("hidden"); umEditUid = null; };
window.umSaveEdit = async function () {
    const plan = umPlanFrom(umEditPick);
    if (!plan) return umSay(umEditPick.type === "coins" ? "Coins missing" : "Plan length missing", true, umEditPick.type === "coins" ? "coins" : "calendar", umEditPick.type === "coins" ? "Enter how many coins to give." : "Pick a plan length.");
    try { await umWritePlan(umEditUid, plan); const em = umData[umEditUid] && umData[umEditUid].email; umCloseEdit(); umSay("Plan updated", false, plan.type === "coins" ? "coins" : "crown", (em ? em + " · " : "") + umPlanText(plan)); umLoad(); }
    catch (err) { umSay("Save failed", true, "alert-circle", err.code || err.message); }
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape") umCloseEdit(); });


// ---- Coins chapter history (chapters uploaded with a coin price: Data A chapters + Data B chapterPrices) ----
function renderCoinHistory(allItems) {
    const box = document.getElementById("chHistList"), cnt = document.getElementById("chHistCount");
    if (!box) return;
    const rows = [];
    (allItems || []).forEach(({ id, data }) => {
        Object.entries((data && data.chapters) || {}).forEach(([chId, ch]) => {
            const coins = coinsOfCh(id, chId);
            if (coins > 0) rows.push({ manga: data.title || id, cover: data.image || data.cover_image || "", title: (ch && ch.chapter_title) || "Chapter", at: (ch && ch.created_at) || 0, coins, adult: data && mangaNodeById[id] === ADULT_NODE });
        });
    });
    rows.sort((a, b) => b.at - a.at);
    if (cnt) cnt.textContent = rows.length;
    box.innerHTML = rows.length ? rows.map(r => `
        <div class="ch-hist-item">
            ${r.cover ? `<img class="ch-hist-cover" src="${esc(r.cover)}" alt="" loading="lazy">` : `<span class="ch-hist-cover ph">${ic("book-open")}</span>`}
            <div class="ch-hist-main"><div class="ch-hist-manga">${esc(r.manga)}</div><div class="ch-hist-ch">${ic("hash")}${esc(r.title)}</div>${r.at ? `<div class="ch-hist-date">${ic("clock")}${new Date(r.at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</div>` : ""}</div>
            <span class="ch-hist-coins">${ic("coins")}<b>${r.coins}</b></span>
        </div>`).join("") : `<div class="um-empty">${ic("coins")} No coin chapters yet. Chapters uploaded with Coins show up here.</div>`;
}
