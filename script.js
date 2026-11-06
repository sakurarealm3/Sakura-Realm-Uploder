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

// --- Security helpers: everything read from the database / file names is untrusted ---
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsArg = (v) => esc(JSON.stringify(String(v == null ? '' : v)));   // safe value inside onclick="fn(...)"
const safeUrl = (u) => { try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; } };
// Only this account may use the uploader (the Firebase rules enforce the same UID on the server)
const ADMIN_UID = 'FAuHEJDN2bepag6m6bFaGbrNdkq2';

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

// --- FIREBASE AUTHENTICATION STATE & LOGIN HANDLERS ---
onAuthStateChanged(auth, (user) => {
    const loginModal = document.getElementById("loginModal");
    const logoutBtn = document.getElementById("logoutBtn");
    if (user && user.uid !== ADMIN_UID) {
        signOut(auth).finally(() => alert("This account is not allowed to use the uploader."));
        return;
    }
    if (user) {
        if (loginModal) loginModal.classList.add("hidden");
        if (logoutBtn) logoutBtn.classList.remove("hidden");
        renderManagedCovers();
        populateMangaDropdown();
    } else {
        if (loginModal) loginModal.classList.remove("hidden");
        if (logoutBtn) logoutBtn.classList.add("hidden");
    }
});

window.handleLogin = async function(event) {
    event.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const rememberMe = document.getElementById("rememberMeCheckbox").checked;
    const submitBtn = document.getElementById("loginSubmitBtn");

    // Slow down guessing: 5 wrong tries -> wait 60 seconds (Firebase also rate-limits on the server)
    const lockUntil = Number(sessionStorage.getItem("sk_lock") || 0);
    if (Date.now() < lockUntil) { alert("Too many attempts. Please wait " + Math.ceil((lockUntil - Date.now()) / 1000) + "s."); return; }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;

    try {
        const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
        await setPersistence(auth, persistence);
        await signInWithEmailAndPassword(auth, email, password);
        sessionStorage.removeItem("sk_fail");
        document.getElementById("loginForm").reset();
    } catch (err) {
        const fails = Number(sessionStorage.getItem("sk_fail") || 0) + 1;
        sessionStorage.setItem("sk_fail", String(fails));
        if (fails >= 5) { sessionStorage.setItem("sk_lock", String(Date.now() + 60000)); sessionStorage.setItem("sk_fail", "0"); }
        alert(err && err.code === "auth/too-many-requests" ? "Too many attempts. Try again later." : "Login failed. Check your email and password.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i> Login to Uploader`;
    }
};

window.handleLogout = async function() {
    try {
        await signOut(auth);
    } catch (err) {
        alert("Logout Error: " + err.message);
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

// Upload file directly to Cloudinary via Fetch API (Unsigned Upload)
async function uploadToCloudinary(fileOrDataUrl) {
    const formData = new FormData();
    formData.append("file", fileOrDataUrl);
    formData.append("upload_preset", UPLOAD_PRESET);
    
    const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
        method: "POST",
        body: formData
    });
    
    const data = await response.json();
    if (data.secure_url) {
        return data.secure_url;
    } else {
        throw new Error(data.error?.message || "Cloudinary upload failed");
    }
}

window.switchTab = function(tabName) {
    const btnManga = document.getElementById("btnMangaTab");
    const btnChapter = document.getElementById("btnChapterTab");
    const formManga = document.getElementById("mangaUploadForm");
    const formChapter = document.getElementById("chapterUploadForm");
    if (tabName === 'mangaTab') {
        btnManga.className = "py-2 rounded-lg text-xs font-bold text-white bg-sakura-600 shadow-md transition";
        btnChapter.className = "py-2 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition";
        formManga.classList.remove("hidden");
        formChapter.classList.add("hidden");
    } else {
        btnChapter.className = "py-2 rounded-lg text-xs font-bold text-white bg-sakura-600 shadow-md transition";
        btnManga.className = "py-2 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition";
        formChapter.classList.remove("hidden");
        formManga.classList.add("hidden");
        populateMangaDropdown();
    }
}

async function populateMangaDropdown() {
    const select = document.getElementById("chapterMangaSelect");
    if (!select) return;
    try {
        const snapshot = await get(child(ref(database), 'manga_list'));
        select.innerHTML = '<option value="" disabled selected>-- Select target manga --</option>';
        if (snapshot.exists()) {
            const data = snapshot.val();
            Object.keys(data).forEach(mangaId => {
                const manga = data[mangaId];
                const opt = document.createElement("option");
                opt.value = mangaId;
                opt.textContent = manga.title || mangaId;
                select.appendChild(opt);
            });
        }
    } catch (err) {
        console.error("Error loading mangas from Firebase:", err);
    }
}

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

window.triggerDevicePhotoPicker = function() {
    document.getElementById("realGalleryFileInput").click();
}

window.triggerZipFilePicker = function() {
    document.getElementById("realZipFileInput").click();
}

window.loadDevicePhotosToGallery = async function(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    const progressWrapper = document.getElementById("zipProgressWrapper");
    const progressBar = document.getElementById("zipProgressBar");
    const progressPercent = document.getElementById("zipProgressPercent");
    const progressText = document.getElementById("zipProgressText");
    progressWrapper.classList.remove("hidden");
    progressBar.style.width = "0%";
    progressPercent.textContent = "0%";
    progressText.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sakura-400"></i> Staging Photos (0/${files.length})...`;
    let newlyAdded = [];
    let completedCount = 0;
    const total = files.length;
    try {
        for (const file of files) {
            await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const item = {
                            id: 'gal-' + Date.now() + '-' + Math.random(),
                            name: file.name,
                            data: e.target.result
                        };
                        await addSingleItemToDB(item);
                        newlyAdded.push(item);
                    } catch (err) {
                        console.error("Error saving image:", err);
                    }
                    completedCount++;
                    const percent = Math.round((completedCount / total) * 100);
                    progressBar.style.width = percent + "%";
                    progressPercent.textContent = percent + "%";
                    progressText.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sakura-400"></i> Staging Photos (${completedCount}/${total})...`;
                    resolve();
                };
                reader.onerror = () => { completedCount++; resolve(); };
                reader.readAsDataURL(file);
            });
        }
        document.getElementById("realGalleryFileInput").value = "";
        tempModalSelectedImages = [...tempModalSelectedImages, ...newlyAdded];
        setTimeout(async () => {
            progressWrapper.classList.add("hidden");
            await openSakuraGalleryModal();
        }, 300);
    } catch (err) {
        progressWrapper.classList.add("hidden");
        alert("Error loading photos: " + err.message);
    }
}

window.loadZipFileToGallery = async function(event) {
    const file = event.target.files[0];
    if (!file) return;
    const progressWrapper = document.getElementById("zipProgressWrapper");
    const progressBar = document.getElementById("zipProgressBar");
    const progressPercent = document.getElementById("zipProgressPercent");
    const progressText = document.getElementById("zipProgressText");
    progressWrapper.classList.remove("hidden");
    progressBar.style.width = "0%";
    progressPercent.textContent = "0%";
    progressText.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sakura-400"></i> Extracting ZIP...`;
    try {
        const zip = await JSZip.loadAsync(file);
        let zipFiles = [];
        let newlyExtracted = [];
        zip.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && /\.(jpe?g|png|webp|gif)$/i.test(zipEntry.name)) {
                zipFiles.push(zipEntry);
            }
        });
        zipFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        if (zipFiles.length === 0) {
            progressWrapper.classList.add("hidden");
            alert("No valid images found inside the ZIP file desu~");
            return;
        }
        const total = zipFiles.length;
        let loadedCount = 0;
        for (const zipEntry of zipFiles) {
            try {
                const base64Data = await zipEntry.async("base64");
                const mimeType = zipEntry.name.endsWith('.png') ? 'image/png' : 'image/jpeg';
                const rawDataUrl = `data:${mimeType};base64,${base64Data}`;
                const fileName = zipEntry.name.split('/').pop();
                const imgObj = {
                    id: 'gal-zip-' + Date.now() + '-' + Math.random(),
                    name: fileName,
                    data: rawDataUrl
                };
                await addSingleItemToDB(imgObj);
                newlyExtracted.push(imgObj);
            } catch (err) {
                console.error("Error reading zip entry:", err);
            }
            loadedCount++;
            const percent = Math.round((loadedCount / total) * 100);
            progressBar.style.width = percent + "%";
            progressPercent.textContent = percent + "%";
            progressText.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sakura-400"></i> Extracting ZIP (${loadedCount}/${total})...`;
        }
        document.getElementById("realZipFileInput").value = "";
        tempModalSelectedImages = [...tempModalSelectedImages, ...newlyExtracted];
        setTimeout(async () => {
            progressWrapper.classList.add("hidden");
            await openSakuraGalleryModal();
        }, 300);
    } catch (err) {
        progressWrapper.classList.add("hidden");
        alert("Error reading ZIP file: " + err.message);
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
            <div class="col-span-3 py-10 text-center text-xs text-slate-500 italic">
                No photos in gallery yet desu~ Click 'Add Photos' or 'Upload ZIP' above.
            </div>
        `;
        countBadge.textContent = "0 selected";
        return;
    }
    gallery.forEach((item) => {
        const isSelected = tempModalSelectedImages.some(sel => sel.id === item.id);
        const card = document.createElement("div");
        card.className = `relative aspect-square rounded-xl border-2 overflow-hidden transition group cursor-pointer ${isSelected ? 'border-sakura-500 shadow-sakura-glow ring-2 ring-sakura-500/50' : 'border-dark-border bg-dark-card'}`;
        card.onclick = () => toggleModalImageSelection(item.id);
        card.innerHTML = `
            <img src="${esc(item.data)}" alt="${esc(item.name)}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300">
            <div class="absolute top-1.5 right-1.5 w-6 h-6 rounded-lg flex items-center justify-center text-xs transition ${isSelected ? 'bg-sakura-600 text-white shadow-md' : 'bg-black/60 text-slate-300 border border-white/20'}">
                <i class="fa-solid ${isSelected ? 'fa-check' : 'fa-plus'}"></i>
            </div>
            <button type="button" onclick="event.stopPropagation(); deletePhotoFromSakuraGallery(${jsArg(item.id)})" class="absolute bottom-1.5 right-1.5 w-6 h-6 rounded-lg bg-red-600 text-white flex items-center justify-center text-[10px] shadow hover:bg-red-500 transition z-10" title="Delete Photo">
                <i class="fa-solid fa-trash-can"></i>
            </button>
            <div class="absolute bottom-0 left-0 right-7 bg-black/70 backdrop-blur-xs p-1 text-[9px] text-slate-200 truncate text-center">
                ${esc(item.name)}
            </div>
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
        triggerText.textContent = "Open Telegram-Style Gallery";
        return;
    }
    wrapper.classList.remove("hidden");
    badge.textContent = `${finalSelectedChapterImages.length} image(s) selected`;
    triggerText.textContent = `Add more images (${finalSelectedChapterImages.length} ready)`;
    grid.innerHTML = "";
    finalSelectedChapterImages.forEach((imgObj, index) => {
        const card = document.createElement("div");
        card.className = "relative aspect-square rounded-lg border border-dark-border bg-dark-card overflow-hidden shadow-md group";
        card.innerHTML = `
            <img src="${esc(imgObj.data)}" alt="Preview" class="w-full h-full object-cover">
            <button type="button" onclick="removeSakuraSelectedImage(${index})" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600 text-white flex items-center justify-center text-[10px] shadow hover:bg-red-500 transition" title="Remove">
                <i class="fa-solid fa-xmark"></i>
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
}

window.selectCustomOption = function(hiddenInputId, displayTextId, value, menuId) {
    document.getElementById(hiddenInputId).value = value;
    const textEl = document.getElementById(displayTextId);
    textEl.textContent = value;
    if (value === 'Complete') textEl.className = 'text-emerald-400 font-bold';
    else if (value === 'Pause') textEl.className = 'text-amber-400 font-bold';
    else textEl.className = 'text-sakura-300 font-bold';
    document.getElementById(menuId).classList.add('hidden');
}

document.addEventListener('click', function(e) {
    if (!e.target.closest('.relative')) {
        ['statusMenu', 'coverTypeMenu', 'modalStatusMenu'].forEach(m => {
            const el = document.getElementById(m);
            if (el) el.classList.add('hidden');
        });
    }
});

window.toggleGenresShowMore = function() {
    const extendedContainer = document.getElementById("genresExtendedContainer");
    const toggleText = document.getElementById("genresToggleText");
    const toggleIcon = document.getElementById("genresToggleIcon");
    extendedContainer.classList.toggle("hidden");
    if (extendedContainer.classList.contains("hidden")) {
        toggleText.textContent = "Show More";
        toggleIcon.className = "fa-solid fa-chevron-down text-[8px]";
    } else {
        toggleText.textContent = "Show Less";
        toggleIcon.className = "fa-solid fa-chevron-up text-[8px]";
    }
}

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
    submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading to Cloudinary...`;
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
        alert("Upload Error: " + err.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i class="fa-solid fa-upload"></i> Upload Manga Cover to Cloudinary`;
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
    
    if (!mangaId) { alert("Please select a manga desu~"); return; }
    if (!chapterTitle) { alert("Please enter a chapter title desu~"); return; }
    if (finalSelectedChapterImages.length === 0) { alert("Please select chapter images desu~"); return; }
    
    submitBtn.disabled = true;
    const progressWrapper = document.getElementById("zipProgressWrapper");
    const progressBar = document.getElementById("zipProgressBar");
    const progressPercent = document.getElementById("zipProgressPercent");
    const progressText = document.getElementById("zipProgressText");
    progressWrapper.classList.remove("hidden");
    
    try {
        const total = finalSelectedChapterImages.length;
        let uploadedPagesUrls = [];
        let count = 0;
        
        for (const imgObj of finalSelectedChapterImages) {
            progressText.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sakura-400"></i> Uploading to Cloudinary (${count + 1}/${total})...`;
            const secureUrl = await uploadToCloudinary(imgObj.data);
            uploadedPagesUrls.push(secureUrl);
            count++;
            const percent = Math.round((count / total) * 100);
            progressBar.style.width = percent + "%";
            progressPercent.textContent = percent + "%";
        }
        
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
        
        progressWrapper.classList.add("hidden");
        showSuccessNotice(successMsg);
        renderManagedCovers();
    } catch (err) {
        progressWrapper.classList.add("hidden");
        alert("Chapter Upload Error: " + err.message);
    } finally {
        submitBtn.disabled = false;
    }
}

function showSuccessNotice(msgEl) {
    if (!msgEl) return;
    msgEl.classList.remove("hidden");
    setTimeout(() => { msgEl.classList.add("hidden"); }, 3000);
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
            listContainer.innerHTML = `
                <div class="text-center py-5 text-xs text-slate-500 italic">
                    No uploaded mangas or chapters found in Firebase yet desu~
                </div>
            `;
            return;
        }
        
        const data = snapshot.val();
        const mangaKeys = Object.keys(data);
        if (countBadge) countBadge.textContent = `${mangaKeys.length} Mangas`;
        
        mangaKeys.forEach((mangaId) => {
            const manga = data[mangaId];
            const mangaCard = document.createElement("div");
            mangaCard.className = "p-3 rounded-xl bg-dark-base/70 border border-dark-border space-y-2.5";
            
            const mangaStatus = manga.status || manga.chapter || 'Ongoing';
            const chaptersObj = manga.chapters || {};
            const chapterKeys = Object.keys(chaptersObj);
            
            let chaptersHtml = '';
            if (chapterKeys.length > 0) {
                chapterKeys.forEach(chId => {
                    const ch = chaptersObj[chId];
                    const pagesLen = ch.pages ? ch.pages.length : 0;
                    chaptersHtml += `
                        <div class="flex items-center justify-between pl-4 pr-2 py-1.5 rounded-lg bg-dark-card border border-dark-border text-xs">
                            <span class="font-semibold text-sakura-300"><i class="fa-solid fa-bookmark mr-1.5 text-[10px]"></i>${esc(ch.chapter_title || chId)} (${pagesLen} pages)</span>
                            <button type="button" onclick="promptDelete('chapter', ${jsArg(mangaId)}, ${jsArg(chId)})" class="text-red-400 hover:text-red-300 p-1" title="Delete Chapter">
                                <i class="fa-solid fa-trash-can text-[10px]"></i>
                            </button>
                        </div>
                    `;
                });
            } else {
                chaptersHtml = `<div class="text-[10px] text-slate-500 italic pl-4">No chapters uploaded yet.</div>`;
            }
            
            mangaCard.innerHTML = `
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2.5 overflow-hidden">
                        <img src="${esc(safeUrl(manga.image || manga.cover_image))}" alt="${esc(manga.title)}" class="w-9 h-12 object-cover rounded-md shrink-0 shadow">
                        <div class="flex flex-col truncate">
                            <span class="text-xs font-bold text-slate-100 truncate">${esc(manga.title)}</span>
                            <div class="flex items-center gap-2 mt-0.5">
                                <span class="text-[9px] text-sakura-400 font-bold uppercase">${esc(mangaStatus)}</span>
                                <span class="text-[9px] text-sakura-300 font-bold bg-dark-card px-1 rounded">${esc(manga.coverType || 'Manga')}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0 ml-2">
                        <button type="button" onclick="openEditModal(${jsArg(mangaId)}, ${jsArg(mangaStatus)})" class="w-7 h-7 rounded-lg bg-sakura-500/10 text-sakura-400 hover:bg-sakura-500 hover:text-white transition flex items-center justify-center" title="Edit Status">
                            <i class="fa-solid fa-pen text-[10px]"></i>
                        </button>
                        <button type="button" onclick="promptDelete('manga', ${jsArg(mangaId)})" class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/10 hover:text-white transition flex items-center justify-center" title="Delete Manga">
                            <i class="fa-solid fa-trash-can text-[10px]"></i>
                        </button>
                    </div>
                </div>
                <div class="space-y-1 pt-1 border-t border-dark-border/60">
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Chapters (${chapterKeys.length}):</span>
                    <div class="space-y-1 mt-1 max-h-36 overflow-y-auto pr-1">
                        ${chaptersHtml}
                    </div>
                </div>
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
        alert("Error updating status: " + err.message);
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
        alert("Error deleting item: " + err.message);
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
        opacity: Math.random() * 0.4 + 0.2
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
            ctx.fillStyle = '#ff5c8a';
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
