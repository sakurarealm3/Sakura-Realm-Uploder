// --- SAKURA REALM: CLOUDINARY & FIREBASE UPLOADER ENGINE ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getDatabase, ref, set, get, update, remove, child } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js";
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
const CLOUD_NAME = "dxbelpram";
const UPLOAD_PRESET = "sakura_uploads_1"; 

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

onAuthStateChanged(auth, async (user) => {
    if (user) {
        // Session guard: if the user did NOT choose Remember Me and this is a
        // brand-new browser session, they must log in again.
        const remembered = store.local.get(REMEMBER_KEY) === "1";
        const sessionActive = store.session.get(SESSION_KEY) === "1";
        if (!remembered && !sessionActive && !loginInProgress) {
            try { await signOut(auth); } catch (e) { console.error(e); }
            return; // onAuthStateChanged fires again with user = null
        }
        showAuthScreen(true, user);
        if (!appDataLoaded) {
            appDataLoaded = true;
            renderManagedCovers();
            populateMangaDropdown();
        }
    } else {
        appDataLoaded = false;
        showAuthScreen(false);
    }
});

window.togglePasswordVisibility = function() {
    const input = document.getElementById("loginPassword");
    const btn = document.getElementById("togglePasswordBtn");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.innerHTML = ic(show ? "eye-off" : "eye");
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
};

window.handleLogin = async function(event) {
    event.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const rememberMe = document.getElementById("rememberMeCheckbox").checked;
    const submitBtn = document.getElementById("loginSubmitBtn");

    showLoginError("");
    if (!email || !password) {
        showLoginError("Please enter your email and password.");
        return;
    }

    loginInProgress = true;
    submitBtn.disabled = true;
    submitBtn.innerHTML = `${ic('loader','ic-spin')} Logging in...`;

    try {
        // Choose where Firebase keeps the login BEFORE signing in
        const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
        await setPersistence(auth, persistence);

        // Mark choice (guards in onAuthStateChanged read these)
        store.session.set(SESSION_KEY, "1");
        if (rememberMe) {
            store.local.set(REMEMBER_KEY, "1");
            store.local.set(REMEMBER_EMAIL_KEY, email);
        } else {
            store.local.del(REMEMBER_KEY);
            store.local.del(REMEMBER_EMAIL_KEY);
        }

        await signInWithEmailAndPassword(auth, email, password);
        document.getElementById("loginPassword").value = "";
    } catch (err) {
        store.session.del(SESSION_KEY);
        showLoginError(friendlyAuthError(err));
    } finally {
        loginInProgress = false;
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${ic('log-in')} Sign in`;
    }
};

window.handleLogout = async function() {
    try {
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
function uploadToCloudinaryOnce(fileOrDataUrl, onProgress, job) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        if (typeof fileOrDataUrl === "string") formData.append("file", fileOrDataUrl);
        else formData.append("file", fileOrDataUrl, "page.webp");
        formData.append("upload_preset", UPLOAD_PRESET);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`);
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
async function uploadToCloudinary(fileOrDataUrl, onProgress, retries = 2, job = null) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (job && job.cancelled) throw cancelError();
        try {
            if (onProgress) onProgress(0);
            return await uploadToCloudinaryOnce(fileOrDataUrl, onProgress, job);
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
    const btnManga = document.getElementById("btnMangaTab");
    const btnChapter = document.getElementById("btnChapterTab");
    const formManga = document.getElementById("mangaUploadForm");
    const formChapter = document.getElementById("chapterUploadForm");
    if (tabName === 'mangaTab') {
        btnManga.classList.add("is-active");
        btnChapter.classList.remove("is-active");
        formManga.classList.remove("hidden");
        formChapter.classList.add("hidden");
    } else {
        btnChapter.classList.add("is-active");
        btnManga.classList.remove("is-active");
        formChapter.classList.remove("hidden");
        formManga.classList.add("hidden");
        populateMangaDropdown();
    }
}

let mangaPickData = [];

async function populateMangaDropdown() {
    if (!document.getElementById("chapterMangaSelect")) return;
    try {
        const snapshot = await get(child(ref(database), 'manga_list'));
        mangaPickData = [];
        if (snapshot.exists()) {
            const data = snapshot.val();
            Object.keys(data).forEach(id => {
                const m = data[id] || {};
                mangaPickData.push({
                    id,
                    title: m.title || id,
                    image: m.image || m.cover_image || "",
                    status: m.status || m.chapter || "Ongoing",
                    type: m.coverType || "Manga",
                    chapters: Object.keys(m.chapters || {}).length
                });
            });
        }
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
        const coverImageUrl = await uploadToCloudinary(imageFile);
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
            chapters: {}
        };
        
        await set(ref(database, 'manga_list/' + mangaId), newMangaData);
        
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
    if (finalSelectedChapterImages.length === 0) { await uiAlert("Please select chapter images first.", { title: "No images selected" }); return; }
    
    submitBtn.disabled = true;
    const ui = getProgressUI();
    const job = startJob();
    const total = finalSelectedChapterImages.length;
    const batchSize = Math.max(1, uploadBatchSize);
    const mode = compressMode;
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
                uploadedPagesUrls[idx] = await uploadToCloudinary(packed.file, null, 2, job);
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
            pages: uploadedPagesUrls
        };
        
        await set(ref(database, `manga_list/${mangaId}/chapters/${chapterId}`), newChapterData);
        
        if (chapterTitleInput) chapterTitleInput.value = "";
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
async function renderManagedCovers() {
    const listContainer = document.getElementById("managedCoversList");
    const countBadge = document.getElementById("totalUploadsCount");
    if (!listContainer) return;
    
    try {
        const snapshot = await get(child(ref(database), 'manga_list'));
        listContainer.innerHTML = "";
        if (!snapshot.exists()) {
            if (countBadge) countBadge.textContent = "0 Items";
            updateStats(0, 0, 0);
            listContainer.innerHTML = `
                <div class="empty">
                    ${ic('folder-open')}
                    No manga uploaded yet.
                </div>
            `;
            return;
        }
        
        const data = snapshot.val();
        const mangaKeys = Object.keys(data);
        if (countBadge) countBadge.textContent = `${mangaKeys.length} Mangas`;
        let totalChapters = 0, totalOngoing = 0;
        mangaKeys.forEach(k => {
            const mg = data[k] || {};
            totalChapters += Object.keys(mg.chapters || {}).length;
            if ((mg.status || mg.chapter || 'Ongoing') === 'Ongoing') totalOngoing++;
        });
        updateStats(mangaKeys.length, totalChapters, totalOngoing);
        
        mangaKeys.forEach((mangaId) => {
            const manga = data[mangaId] || {};
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
                            <span class="chapter-name">${esc(ch.chapter_title || chId)}<span class="chapter-pages">${pagesLen} pages</span></span>
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
                        </div>
                    </div>
                    <div class="manga-actions">
                        <button type="button" onclick="openEditModal('${safeId}', '${esc(mangaStatus)}')" class="icon-btn is-teal" title="Edit Status">
                            ${ic('pencil')}
                        </button>
                        <button type="button" onclick="promptDelete('manga', '${safeId}')" class="icon-btn is-red" title="Delete Manga">
                            ${ic('trash')}
                        </button>
                    </div>
                </div>
                <details class="chapters">
                    <summary>${ic('chevron-right')} Chapters (${chapterKeys.length})</summary>
                    <div class="chapter-list">
                        ${chaptersHtml}
                    </div>
                </details>
            `;
            listContainer.appendChild(mangaCard);
        });
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
        await update(ref(database, `manga_list/${mangaId}`), {
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
    document.getElementById("deleteConfirmModal").classList.remove("hidden");
}

window.closeDeleteModal = function() {
    document.getElementById("deleteConfirmModal").classList.add("hidden");
}

window.confirmDelete = async function() {
    const targetType = document.getElementById("deleteTargetType").value;
    const parentId = document.getElementById("deleteTargetParentId").value;
    const targetId = document.getElementById("deleteTargetId").value;
    try {
        if (targetType === 'manga') {
            await remove(ref(database, `manga_list/${parentId}`));
        } else if (targetType === 'chapter') {
            await remove(ref(database, `manga_list/${parentId}/chapters/${targetId}`));
        }
        closeDeleteModal();
        renderManagedCovers();
    } catch (err) {
        uiAlert("Error deleting item: " + err.message);
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
