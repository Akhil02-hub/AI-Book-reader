const bookArea = document.querySelector('#bookArea');
const searchInput = document.querySelector('#searchInput');
const modalBackdrop = document.querySelector('#modalBackdrop');
const modalBody = document.querySelector('#modalBody');
const authScreen = document.querySelector('#authScreen');
let currentBook = null;
let readingSegments = [];
let speechVoices = [];
let isNarrating = false;
let isPaused = false;
let saveTimer;
let toastTimer;
let narrationTimer;
let searchTimer;
let authMode = 'login';
let pendingAuthAction = null;
let progress = { segmentIndex: 0, wordOffset: 0, scrollPercent: 0 };
let highlights = [];
let highlightContainer = null;
let currentPage = 0;
let totalPages = 0;
let voicesBound = false;
const SEGMENTS_PER_PAGE = 60;

const sidebarEl = document.querySelector('#sidebar');
if (sidebarEl) {
  sidebarEl.setAttribute('inert', '');
  sidebarEl.setAttribute('aria-hidden', 'true');
}

const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const sentenceSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
const wordSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

let audioRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioWatcher = null;
let audioProgressSnapshot = null;
let audioMimeType = 'audio/webm';

function pickAudioMimeType() {
  if (!window.MediaRecorder) return '';
  const candidates = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function stopAudioTracks() {
  if (audioStream) audioStream.getTracks().forEach(t => t.stop());
  audioStream = null;
}

function restoreProgressSnapshot() {
  if (!audioProgressSnapshot) return;
  progress = { ...audioProgressSnapshot };
  audioProgressSnapshot = null;
  highlightPosition();
  apiProgress();
}

let isRecordingStarting = false;
async function downloadFullAudio() {
  if (isRecordingStarting || (audioRecorder && audioRecorder.state !== 'inactive')) {
    return toast('A recording is already in progress.');
  }

  if (!currentBook || !readingSegments.length) return toast('Upload a book first.');
  if (!('speechSynthesis' in window)) return toast('Read aloud is not supported in this browser.');
  if (!window.isSecureContext) return toast('Audio capture requires HTTPS or localhost.');

  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) return toast('Audio capture is not supported in this browser.');

  const mimeType = pickAudioMimeType();
  if (!mimeType) return toast('This browser does not support a recordable audio format.');
  if (!confirm('To save the full book audio, pick THIS tab and tick "Share tab audio". Narration runs from the start; your reading position is restored afterwards. Continue?')) return;

  isRecordingStarting = true;
  audioProgressSnapshot = { ...progress };

  try {
    audioStream = await navigator.mediaDevices.getDisplayMedia({ video: { width: 320, height: 180 }, audio: true });
    const audioTracks = audioStream.getAudioTracks();
    if (!audioTracks.length) {
      stopAudioTracks();
      audioProgressSnapshot = null;
      isRecordingStarting = false;
      return toast('No audio shared. Enable "Share tab audio" and retry.');
    }
    audioMimeType = mimeType;
    audioRecorder = new MediaRecorder(new MediaStream(audioTracks), { mimeType });
    audioChunks = [];
    audioRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
    audioRecorder.onerror = event => {
      toast(`Recording error: ${event.error?.message || 'unknown'}`);
      stopAudioTracks();
      clearInterval(audioWatcher);
      audioRecorder = null;
      audioChunks = [];
      isRecordingStarting = false;
      restoreProgressSnapshot();
      updateSpeechControls();
    };
    audioRecorder.onstop = saveAudioRecording;
    audioTracks[0].addEventListener('ended', () => {
      if (isNarrating || isPaused) stopNarration();
      if (audioRecorder && audioRecorder.state === 'recording') audioRecorder.stop();
    });
    audioRecorder.start(1000);
    cancelNarration();

    progress = { ...progress, segmentIndex: 0, wordOffset: 0 };
    if (typeof goToPage === 'function') goToPage(0, true);

    highlightPosition();
    startNarration();
    updateSpeechControls();
    setTimeout(() => {
      if (!isNarrating) {
        if (audioRecorder && audioRecorder.state === 'recording') audioRecorder.stop();
        isRecordingStarting = false;
        return;
      }
      clearInterval(audioWatcher);
      audioWatcher = setInterval(() => {
        if (!isNarrating && !isPaused) {
          clearInterval(audioWatcher);
          setTimeout(() => { if (audioRecorder && audioRecorder.state === 'recording') audioRecorder.stop(); }, 1500);
        }
      }, 500);
    }, 500);
    const statusEl = document.querySelector('#speechStatus');
    if (statusEl) statusEl.textContent = 'Recording full book…';
    toast('Recording… narration saves automatically at the end.');
    isRecordingStarting = false;
  } catch (error) {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') toast(`Audio capture failed: ${error.message}`);
    cancelNarration();
    stopAudioTracks();
    audioRecorder = null;
    audioChunks = [];
    isRecordingStarting = false;
    restoreProgressSnapshot();
    updateSpeechControls();
  }
}

function saveAudioRecording() {
  clearInterval(audioWatcher);
  const chunks = audioChunks.slice();
  const mime = audioRecorder?.mimeType || audioMimeType || 'audio/webm';
  audioChunks = [];
  audioRecorder = null;
  stopAudioTracks();
  restoreProgressSnapshot();
  updateSpeechControls();
  if (!chunks.length) return toast('No audio was captured.');
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const safeTitle = (currentBook?.title || 'book').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'book';
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  anchor.download = `${safeTitle}_full_audio.${ext}`;
  anchor.target = '_blank';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Full book audio downloaded.');
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'The request could not be completed.');
    error.status = response.status;
    if (response.status === 401 && typeof window !== 'undefined' && window.__marginHandle401) {
      window.__marginHandle401();
    }
    throw error;
  }
  return result;
}

function showAuth(message = '') {
  document.body.classList.remove('signed-in');
  document.body.classList.add('auth-ready');
  document.body.classList.add('app-ready');
  authScreen.classList.add('open');
  authScreen.setAttribute('aria-hidden', 'false');
  document.querySelector('.app-shell').setAttribute('inert', '');
  const closeBtn = document.querySelector('#authClose');
  if (closeBtn) closeBtn.hidden = false;
  document.querySelector('#authError').textContent = message;
  document.querySelector('#usernameInput').focus();
}

function showApplication(username) {
  const initial = (username || '?').slice(0, 1).toUpperCase();
  document.body.classList.add('signed-in');
  document.body.classList.add('auth-ready');
  document.body.classList.add('app-ready');
  authScreen.classList.remove('open');
  authScreen.setAttribute('aria-hidden', 'true');
  document.querySelector('.app-shell').removeAttribute('inert');
  document.querySelector('#currentUsername').textContent = username;
  document.querySelector('.workspace-copy strong').textContent = `${username}'s library`;
  const workspaceInitial = document.querySelector('.workspace-avatar .workspace-initial');
  if (workspaceInitial) workspaceInitial.textContent = initial;
  document.querySelector('.profile-avatar').textContent = initial;
  document.querySelector('.profile-row small').textContent = 'Signed in';
  document.querySelector('#logoutButton').textContent = 'Sign out';
}

function showGuestMode() {
  document.body.classList.remove('signed-in');
  document.body.classList.add('app-ready');
  authScreen.classList.remove('open');
  authScreen.setAttribute('aria-hidden', 'true');
  document.querySelector('.app-shell').removeAttribute('inert');
  document.querySelector('#currentUsername').textContent = 'Guest';
  document.querySelector('.workspace-copy strong').textContent = 'Local library';
  const workspaceInitial = document.querySelector('.workspace-avatar .workspace-initial');
  if (workspaceInitial) workspaceInitial.textContent = '';
  document.querySelector('.profile-avatar').textContent = 'G';
  document.querySelector('.profile-row small').textContent = 'Not signed in';
  document.querySelector('#logoutButton').textContent = 'Sign in';
}

function requireAuth(action) {
  if (document.body.classList.contains('signed-in')) {
    return true;
  }
  pendingAuthAction = action || null;
  setAuthMode('login');
  showAuth();
  return false;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.querySelector('#authTitle').textContent = registering ? 'Make it yours.' : 'Welcome back.';
  document.querySelector('#authSubtitle').textContent = registering ? 'Create an account and keep your reading private.' : 'Sign in to continue reading where you left off.';
  document.querySelector('#authSubmit').innerHTML = registering ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  document.querySelector('#authSwitchPrompt').textContent = registering ? 'Already have an account?' : 'New here?';
  document.querySelector('#authSwitch').textContent = registering ? 'Sign in' : 'Create an account';
  document.querySelector('#passwordInput').autocomplete = registering ? 'new-password' : 'current-password';
  document.querySelector('#passwordInput').minLength = registering ? 12 : 1;
  document.querySelector('#authError').textContent = '';
}

let previousFocus = null;

function showModal(content, className = '') {
  previousFocus = document.activeElement;
  modalBody.innerHTML = content;
  document.querySelector('#modal').className = `modal ${className}`.trim();
  modalBackdrop.classList.add('open');
  modalBackdrop.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.querySelector('.app-shell').setAttribute('inert', '');
  document.querySelector('#closeModal').focus();
}

function closeModal() {
  modalBackdrop.classList.remove('open');
  modalBackdrop.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (!authScreen.classList.contains('open')) {
    document.querySelector('.app-shell').removeAttribute('inert');
  }
  if (previousFocus && typeof previousFocus.focus === 'function') {
    previousFocus.focus();
    previousFocus = null;
  }
}

function toast(message) {
  const element = document.querySelector('#toast');
  if (element && !element.hasAttribute('role')) {
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
  }
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function apiProgress(keepalive = false) {
  if (!currentBook) return Promise.resolve();
  if (!document.body.classList.contains('signed-in')) return Promise.resolve();
  const payload = JSON.stringify(progress);
  if (keepalive) return fetch('/api/progress', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => { });
  return api('/api/progress', { method: 'PUT', body: payload }).catch(() => { });
}

let progressLastSaved = 0;
const PROGRESS_MIN_INTERVAL = 2000;
function scheduleProgressSave() {
  clearTimeout(saveTimer);
  const since = Date.now() - progressLastSaved;
  if (since >= PROGRESS_MIN_INTERVAL) {
    progressLastSaved = Date.now();
    apiProgress();
    return;
  }
  saveTimer = setTimeout(() => {
    progressLastSaved = Date.now();
    apiProgress();
  }, PROGRESS_MIN_INTERVAL - since);
}

function currentUserScope() {
  const raw = document.querySelector('#currentUsername')?.textContent || 'guest';
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'guest';
}
function highlightsKey() {
  if (!currentBook) return 'margin-highlights::draft';
  return `margin-highlights::${currentUserScope()}::${currentBook.title}`;
}

function loadHighlights() {
  highlights = [];
  if (!currentBook) return;
  try {
    const raw = localStorage.getItem(highlightsKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) highlights = parsed;
      else { console.warn('[margin] highlights not an array — resetting'); highlights = []; }
    }
  } catch (error) {
    console.warn('[margin] failed to parse highlights; resetting', error);
    try { localStorage.removeItem(highlightsKey()); } catch { /* storage disabled */ }
    highlights = [];
  }
}

function saveHighlights() {
  if (!currentBook) return;
  try { localStorage.setItem(highlightsKey(), JSON.stringify(highlights)); } catch { /* storage disabled */ }
}

function applyHighlights() {
  document.querySelectorAll('.reader-word.highlighted').forEach(node => node.classList.remove('highlighted'));
  if (!highlights.length) return;
  for (const h of highlights) {
    const sentences = document.querySelectorAll(`.reader-sentence[data-segment-index="${h.segmentIndex}"]`);
    if (!sentences.length) continue;
    for (const sentence of sentences) {
      const start = Math.min(h.wordStart, h.wordEnd);
      const end = Math.max(h.wordStart, h.wordEnd);
      for (let i = start; i <= end; i++) {
        const word = sentence.querySelector(`.reader-word[data-word-index="${i}"]`);
        if (word) word.classList.add('highlighted');
      }
    }
  }
}

function captureSelectionHighlight() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const reader = document.querySelector('#readerDocument');
  if (!reader) return null;
  const range = selection.getRangeAt(0);
  if (!reader.contains(range.commonAncestorContainer)) return null;

  const groups = new Map();
  const sentences = [...reader.querySelectorAll('.reader-sentence')].filter(s => range.intersectsNode(s));

  for (const sentence of sentences) {
    const segmentIndex = Number(sentence.dataset.segmentIndex);
    if (!Number.isFinite(segmentIndex)) continue;

    let minWord = Infinity;
    let maxWord = -1;

    for (const word of sentence.querySelectorAll('.reader-word')) {
      if (range.intersectsNode(word)) {
        const wordIndex = Number(word.dataset.wordIndex);
        if (Number.isFinite(wordIndex)) {
          minWord = Math.min(minWord, wordIndex);
          maxWord = Math.max(maxWord, wordIndex);
        }
      }
    }

    if (maxWord >= 0) {
      groups.set(segmentIndex, { start: minWord, end: maxWord });
    }
  }

  if (!groups.size) return null;
  const result = [];
  for (const [segmentIndex, indices] of groups) {
    result.push({ segmentIndex, wordStart: indices.start, wordEnd: indices.end });
  }
  return result;
}

function ensureHighlightButton() {
  if (highlightContainer) return highlightContainer;
  const container = document.createElement('div');
  container.className = 'highlight-popover-container';
  container.style.position = 'fixed';
  container.style.zIndex = '30';
  container.style.display = 'none';
  container.style.gap = '4px';
  container.style.background = 'var(--green)';
  container.style.padding = '4px';
  container.style.borderRadius = '6px';
  container.style.boxShadow = '0 6px 20px rgba(16, 26, 18, 0.2)';
  container.style.transform = 'translate(-50%, 0)';

  const btnHighlight = document.createElement('button');
  btnHighlight.type = 'button';
  btnHighlight.textContent = 'Highlight';
  btnHighlight.style.padding = '6px 10px';
  btnHighlight.style.borderRadius = '4px';
  btnHighlight.style.border = 'none';
  btnHighlight.style.background = 'transparent';
  btnHighlight.style.color = '#fff';
  btnHighlight.style.cursor = 'pointer';
  btnHighlight.style.fontSize = '11px';
  btnHighlight.style.fontWeight = '600';

  const btnStart = document.createElement('button');
  btnStart.type = 'button';
  btnStart.textContent = 'Start here';
  btnStart.style.padding = '6px 10px';
  btnStart.style.borderRadius = '4px';
  btnStart.style.border = 'none';
  btnStart.style.background = 'transparent';
  btnStart.style.color = '#fff';
  btnStart.style.cursor = 'pointer';
  btnStart.style.fontSize = '11px';
  btnStart.style.fontWeight = '600';

  [btnHighlight, btnStart].forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.background = 'var(--green-dark)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');
    btn.addEventListener('mousedown', event => event.preventDefault());
  });

  btnHighlight.addEventListener('click', () => {
    const groups = captureSelectionHighlight();
    hideHighlightButton();
    if (!groups) return;
    highlights.push(...groups);
    applyHighlights();
    saveHighlights();
    window.getSelection()?.removeAllRanges();
    toast('Highlight saved.');
  });

  btnStart.addEventListener('click', () => {
    const selection = window.getSelection();
    if (!selection.isCollapsed && selection.rangeCount > 0) {
      let node = selection.getRangeAt(0).startContainer;
      if (node.nodeType === 3) node = node.parentNode;
      const sentence = node.closest('.reader-sentence');
      hideHighlightButton();
      window.getSelection()?.removeAllRanges();
      if (sentence) setStartFromSentence(sentence);
    }
  });

  container.appendChild(btnHighlight);
  container.appendChild(btnStart);
  document.body.appendChild(container);
  highlightContainer = container;
  return container;
}

function showHighlightButton(x, y) {
  const container = ensureHighlightButton();
  container.style.left = `${x}px`;
  container.style.top = `${Math.max(8, y)}px`;
  container.style.display = 'flex';
}

function hideHighlightButton() {
  if (highlightContainer) highlightContainer.style.display = 'none';
}

function pickBehavior() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function setStartFromSentence(node) {
  if (!node) return;
  const idx = Number(node.dataset.segmentIndex);
  if (!Number.isFinite(idx)) return;
  const wasReading = isNarrating || isPaused;
  cancelNarration();
  progress = { ...progress, segmentIndex: idx, wordOffset: 0 };
  highlightPosition();
  scheduleProgressSave();
  node.scrollIntoView({ behavior: pickBehavior(), block: 'center' });
  toast('Reading will start from here.');
  if (wasReading) startNarration();
}

function setStartFromViewport() {
  const activePage = document.querySelector('.book-page.active');
  if (!activePage) return;
  const firstSentence = activePage.querySelector('.reader-sentence');
  if (!firstSentence) {
    toast('This page has no text to start from.');
    return;
  }
  setStartFromSentence(firstSentence);
}

function downloadReaderPdf() {
  if (!currentBook) return;
  document.body.classList.add('printing-reader');
  const cleanup = () => {
    document.body.classList.remove('printing-reader');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 60);
}

function sentenceTokens(text) {
  if (sentenceSegmenter) return [...sentenceSegmenter.segment(text)].map(item => item.segment);
  return text.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)\s*/g) || [text];
}

function renderSentenceWords(text) {
  let markup = '';
  const tokens = wordSegmenter ? [...wordSegmenter.segment(text)] : [...text.matchAll(/\S+|\s+/g)].map(match => ({ segment: match[0], index: match.index, isWordLike: /^\S/.test(match[0]) }));
  const wordRanges = [];
  let nextWord = 0;
  for (const token of tokens) {
    if (token.isWordLike) {
      const word = nextWord++;
      wordRanges.push({ start: token.index, end: token.index + token.segment.length });
      markup += `<span class="reader-word" data-word-index="${word}">${escapeHTML(token.segment)}</span>`;
    } else markup += escapeHTML(token.segment);
  }
  return { markup, wordRanges };
}

function renderEmpty() {
  cancelNarration();
  currentBook = null;
  readingSegments = [];
  progress = { segmentIndex: 0, wordOffset: 0, scrollPercent: 0 };
  document.querySelector('#navBookCount').textContent = '0';
  document.querySelector('#welcomeTitle').textContent = 'One book. The whole story.';
  document.querySelector('#welcomeSubtitle').textContent = 'Upload a book and read it from beginning to end in one continuous view.';
  document.querySelector('#libraryEyebrow').textContent = 'YOUR READING SPACE';
  document.querySelector('#libraryTitle').textContent = 'Your book';
  bookArea.innerHTML = `<button class="empty-upload" id="emptyUpload"><span class="empty-upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v14"/><path d="m6 9 6-6 6 6"/><path d="M4 21h16"/></svg></span><strong>Start with one book</strong><span>Choose an EPUB, PDF, TXT, or Markdown file.</span><span class="empty-upload-action">Choose a book <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="empty-upload-arrow"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></span></button>`;
  document.querySelector('#emptyUpload').addEventListener('click', openUpload);
}

function renderBook(book) {
  cancelNarration();
  currentBook = book;
  loadHighlights();
  progress = { segmentIndex: 0, wordOffset: 0, scrollPercent: 0, ...(book.progress || {}) };
  readingSegments = [];
  document.querySelector('#navBookCount').textContent = '1';
  document.querySelector('#welcomeTitle').textContent = 'Settle in. It’s all here.';
  document.querySelector('#welcomeSubtitle').textContent = 'Your whole book, presented page by page.';
  document.querySelector('#libraryEyebrow').textContent = 'NOW READING';
  document.querySelector('#libraryTitle').textContent = book.title;

  const pages = [];
  let currentPageMarkup = '';
  let currentPageSegmentCount = 0;

  book.chapters.forEach((chapter, chapterIndex) => {
    const paragraphs = chapter.text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
    const body = paragraphs.length ? paragraphs : [chapter.text.trim()].filter(Boolean);

    body.forEach((paragraph, paragraphIndex) => {
      let sentenceMarkup = '';
      for (const rawSentence of sentenceTokens(paragraph)) {
        const leading = rawSentence.match(/^\s*/)?.[0] || '';
        const trailing = rawSentence.match(/\s*$/)?.[0] || '';
        const text = rawSentence.trim();
        if (!text) { sentenceMarkup += escapeHTML(rawSentence); continue; }

        if (currentPageSegmentCount >= SEGMENTS_PER_PAGE) {
          pages.push(currentPageMarkup);
          currentPageMarkup = '';
          currentPageSegmentCount = 0;
        }

        const segmentIndex = readingSegments.length;
        const wordData = renderSentenceWords(text);
        readingSegments.push({ text, chapterIndex, paragraphIndex, wordRanges: wordData.wordRanges });

        sentenceMarkup += `${escapeHTML(leading)}<span class="reader-sentence" data-segment-index="${segmentIndex}">${wordData.markup}</span>${escapeHTML(trailing)}`;
        currentPageSegmentCount++;
      }
      currentPageMarkup += `<p class="reader-paragraph">${sentenceMarkup}</p>`;
    });
  });
  if (currentPageMarkup) pages.push(currentPageMarkup);
  totalPages = pages.length;

  progress.segmentIndex = Math.min(progress.segmentIndex, Math.max(0, readingSegments.length - 1));
  currentPage = Math.floor(progress.segmentIndex / SEGMENTS_PER_PAGE);
  if (currentPage >= totalPages) currentPage = Math.max(0, totalPages - 1);

  let pagesHtml = '';
  pages.forEach((html, index) => {
    pagesHtml += `<div class="book-page ${index === currentPage ? 'active' : ''}" data-page-index="${index}">${html}</div>`;
  });

  bookArea.innerHTML = `<article class="reader-book">
    <header class="reader-book-header">
      <div class="reader-book-heading">
        <span class="modal-kicker">YOUR BOOK · ${escapeHTML((book.format || 'txt').toUpperCase())}</span>
        <h2>${escapeHTML(book.title)}</h2>
        <p>${escapeHTML(book.author || 'Uploaded book')}</p>
      </div>
      <div class="reader-book-actions">
        <button class="reader-action" id="setStartBtn">Set Start Here</button>
        <button class="reader-action" id="downloadPdfBtn">Download PDF</button>
        <button class="reader-action" id="removeBook">Remove</button>
        <button class="reader-action reader-action-primary" id="replaceBook">Replace</button>
      </div>
    </header>
    <div class="reading-toolbar">
      <div class="speech-controls">
        <button class="speech-button speech-start" id="speechStart"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> <span>Start reading</span></button>
        <button class="speech-button" id="speechPause" disabled><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg> <span>Pause</span></button>
        <button class="speech-button speech-stop" id="speechStop" disabled><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> <span>Stop</span></button>
        <button class="speech-button speech-download" id="downloadAudioBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg> <span>Audio</span></button>
      </div>
      <div class="voice-settings">
        <label for="voiceSelect">Voice</label><select id="voiceSelect"><option value="">Default</option></select>
        <label for="rateSelect">Speed</label><select id="rateSelect"><option value="0.8">0.8×</option><option value="1" selected>1×</option><option value="1.2">1.2×</option><option value="1.5">1.5×</option></select>
      </div>
      <span class="speech-status" id="speechStatus" aria-live="polite">Ready</span>
    </div>
    <div class="reader-progress">
      <span>Progress</span>
      <div class="reader-progress-track"><i id="progressBar"></i></div>
      <span id="progressPercent">0%</span>
    </div>
    <div class="reader-document" id="readerDocument">
      <div class="reader-pages-container">${pagesHtml}</div>
    </div>
    <div class="pagination-controls">
      <button id="prevPageBtn" class="page-btn" ${currentPage === 0 ? 'disabled' : ''}>← Previous</button>
      <span id="pageIndicator" aria-live="polite">Page ${currentPage + 1} of ${totalPages}</span>
      <button id="nextPageBtn" class="page-btn" ${currentPage === totalPages - 1 ? 'disabled' : ''}>Next →</button>
    </div>
  </article>`;

  document.querySelector('#replaceBook').addEventListener('click', openUpload);
  document.querySelector('#removeBook').addEventListener('click', async () => {
    if (!confirm('Remove this book from your account?')) return;
    cancelNarration();
    try {
      await api('/api/books', { method: 'DELETE' });
      try { localStorage.removeItem(highlightsKey()); } catch { /* storage disabled */ }
      highlights = [];
      renderEmpty();
      toast('Book removed');
    } catch (error) { toast(error.message); }
  });

  document.querySelector('#speechStart').addEventListener('click', startNarration);
  document.querySelector('#speechPause').addEventListener('click', toggleNarrationPause);
  document.querySelector('#speechStop').addEventListener('click', stopNarration);
  document.querySelector('#downloadAudioBtn').addEventListener('click', downloadFullAudio);
  document.querySelector('#downloadPdfBtn').addEventListener('click', downloadReaderPdf);
  document.querySelector('#setStartBtn').addEventListener('click', setStartFromViewport);

  document.querySelector('#readerDocument').addEventListener('click', (e) => {
    if (!window.getSelection().isCollapsed) return;
    const sentence = e.target.closest('.reader-sentence');
    if (sentence) setStartFromSentence(sentence);
  });

  document.querySelector('#prevPageBtn').addEventListener('click', () => { goToPage(currentPage - 1); });
  document.querySelector('#nextPageBtn').addEventListener('click', () => { goToPage(currentPage + 1); });

  configureVoices();

  requestAnimationFrame(() => {
    highlightPosition();
    updateReadProgress();
    applyHighlights();
  });
}

function goToPage(pageIndex, preserveProgress = false) {
  if (pageIndex < 0 || pageIndex >= totalPages) return;
  currentPage = pageIndex;
  document.querySelectorAll('.book-page').forEach((p, i) => p.classList.toggle('active', i === pageIndex));

  const indicator = document.querySelector('#pageIndicator');
  if (indicator) indicator.textContent = `Page ${pageIndex + 1} of ${totalPages}`;

  const prevBtn = document.querySelector('#prevPageBtn');
  const nextBtn = document.querySelector('#nextPageBtn');
  if (prevBtn) prevBtn.disabled = pageIndex === 0;
  if (nextBtn) nextBtn.disabled = pageIndex === totalPages - 1;

  if (!isNarrating && !isPaused && !preserveProgress) {
    progress.segmentIndex = pageIndex * SEGMENTS_PER_PAGE;
    progress.wordOffset = 0;
    highlightPosition();
    updateReadProgress();
    scheduleProgressSave();
  }
}

function updateReadProgress() {
  const bar = document.querySelector('#progressBar');
  const label = document.querySelector('#progressPercent');
  if (!bar || !label) return;
  const percent = readingSegments.length > 0 ? Math.round((progress.segmentIndex / readingSegments.length) * 100) : 0;
  bar.style.width = `${percent}%`;
  label.textContent = `${percent}%`;
}

function configureVoices() {
  const voiceSelect = document.querySelector('#voiceSelect');

  function populateVoiceOptions(select) {
    if (!select) return;
    speechVoices = speechSynthesis.getVoices();
    let savedVoice = '';
    try { savedVoice = localStorage.getItem('margin-voice') || ''; } catch { /* storage disabled */ }
    const oldValue = select.value || savedVoice || '';
    select.innerHTML = '<option value="">System default</option>';
    if (!speechVoices.length) return;
    speechVoices.forEach((voice) => {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = `${voice.name} · ${voice.lang}`;
      select.append(option);
    });
    if ([...select.options].some(option => option.value === oldValue)) select.value = oldValue;
  };

  if (voiceSelect) populateVoiceOptions(voiceSelect);

  if (!voicesBound) {
    voicesBound = true;
    speechSynthesis.addEventListener('voiceschanged', () => {
      const current = document.querySelector('#voiceSelect');
      if (current) populateVoiceOptions(current);
    });
  }

  const rateSelect = document.querySelector('#rateSelect');
  let savedRate = null;
  try { savedRate = localStorage.getItem('margin-rate'); } catch { /* storage disabled */ }
  if (rateSelect) {
    const allowed = ['0.8', '1', '1.2', '1.5'];
    if (allowed.includes(savedRate)) rateSelect.value = savedRate;
    rateSelect.onchange = () => { try { localStorage.setItem('margin-rate', rateSelect.value); } catch { /* storage disabled */ } };
  }

  if (voiceSelect) voiceSelect.onchange = () => { try { localStorage.setItem('margin-voice', voiceSelect.value); } catch { /* storage disabled */ } };
}

function highlightPosition() {
  document.querySelectorAll('.reader-sentence.reading-current').forEach(node => node.classList.remove('reading-current'));
  document.querySelectorAll('.reader-word.reading-current-word').forEach(node => node.classList.remove('reading-current-word'));

  const sentence = document.querySelector(`.reader-sentence[data-segment-index="${progress.segmentIndex}"]`);
  if (!sentence) return;

  sentence.classList.add('reading-current');
  const word = sentence.querySelector(`.reader-word[data-word-index="${progress.wordOffset}"]`);
  if (word) word.classList.add('reading-current-word');
}

function scrollToCurrentSentence() {
  const sentence = document.querySelector(`.reader-sentence[data-segment-index="${progress.segmentIndex}"]`);
  if (sentence) sentence.scrollIntoView({ behavior: pickBehavior(), block: 'center' });
}

function updateSpeechControls() {
  const start = document.querySelector('#speechStart');
  const pause = document.querySelector('#speechPause');
  const stop = document.querySelector('#speechStop');
  const download = document.querySelector('#downloadAudioBtn');
  const status = document.querySelector('#speechStatus');
  if (!start || !pause || !stop || !status) return;
  start.disabled = isNarrating && !isPaused;

  if (isPaused) start.querySelector('span').textContent = 'Resume reading';
  else if (progress.segmentIndex >= readingSegments.length) start.querySelector('span').textContent = 'Read again';
  else if (progress.segmentIndex > 0) start.querySelector('span').textContent = 'Continue reading';
  else start.querySelector('span').textContent = 'Start reading';

  pause.disabled = !isNarrating && !isPaused;
  pause.querySelector('span').textContent = isPaused ? 'Resume' : 'Pause';
  stop.disabled = !isNarrating && !isPaused;
  if (download) download.disabled = Boolean(audioRecorder && audioRecorder.state === 'recording');
  status.textContent = isPaused ? 'Paused' : isNarrating ? 'Reading aloud…' : 'Ready when you are';
}
function selectedVoice() {
  const value = document.querySelector('#voiceSelect')?.value;
  return value === '' || value === undefined ? null : speechVoices.find(v => v.name === value) || null;
}

function startNarration() {
  if (!('speechSynthesis' in window) || !readingSegments.length) { toast('Read aloud is not available in this browser.'); return; }
  if (isPaused) {
    speechSynthesis.resume();
    isPaused = false;
    isNarrating = true;
    updateSpeechControls();
    return;
  }
  if (progress.segmentIndex >= readingSegments.length) progress = { ...progress, segmentIndex: 0, wordOffset: 0 };
  isNarrating = true;
  isPaused = false;
  speechSynthesis.cancel();
  clearTimeout(narrationTimer);
  updateSpeechControls();
  speakCurrentSegment();
}

function speakCurrentSegment() {
  if (!isNarrating || progress.segmentIndex >= readingSegments.length) {
    if (isNarrating) {
      isNarrating = false;
      isPaused = false;
      progress.segmentIndex = readingSegments.length;
      progress.wordOffset = 0;
      apiProgress();
      updateSpeechControls();
      toast('You reached the end of your book.');
    }
    return;
  }
  const segment = readingSegments[progress.segmentIndex];
  const startWord = Math.min(progress.wordOffset, Math.max(0, segment.wordRanges.length - 1));
  const startCharacter = segment.wordRanges[startWord]?.start || 0;
  const spokenText = segment.text.slice(startCharacter);
  if (!spokenText.trim()) {
    progress.segmentIndex += 1;
    progress.wordOffset = 0;
    clearTimeout(narrationTimer);
    narrationTimer = setTimeout(speakCurrentSegment, 10);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(spokenText);
  const voice = selectedVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = Number(document.querySelector('#rateSelect').value) || 1;
  highlightPosition();
  scrollToCurrentSentence();
  utterance.onboundary = event => {
    if (event.name !== 'word') return;
    const character = startCharacter + event.charIndex;
    const wordIndex = segment.wordRanges.findIndex(range => character >= range.start && character < range.end);
    if (wordIndex >= 0) {
      progress.wordOffset = wordIndex;
      highlightPosition();
      if (wordIndex % 5 === 0) scheduleProgressSave();
    }
  };
  utterance.onend = () => {
    if (!isNarrating || isPaused) return;
    progress.segmentIndex += 1;
    progress.wordOffset = 0;
    highlightPosition();
    scheduleProgressSave();
    clearTimeout(narrationTimer);
    narrationTimer = setTimeout(speakCurrentSegment, 45);
  };
  utterance.onerror = event => {
    if (event.error === 'canceled' || event.error === 'interrupted') return;
    isNarrating = false;
    isPaused = false;
    updateSpeechControls();
    toast('Read aloud stopped. Your place is saved.');
  };
  speechSynthesis.speak(utterance);
}

function toggleNarrationPause() {
  if (isPaused) return startNarration();
  if (!isNarrating) return;
  speechSynthesis.pause();
  isPaused = true;
  isNarrating = false;
  updateSpeechControls();
  apiProgress();
}

function stopNarration() {
  if (!isNarrating && !isPaused) return;
  isNarrating = false;
  isPaused = false;
  speechSynthesis.cancel();
  clearTimeout(narrationTimer);
  updateSpeechControls();
  apiProgress();
}

function cancelNarration() {
  isNarrating = false;
  isPaused = false;
  clearTimeout(narrationTimer);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function openUpload() {
  if (!requireAuth(openUpload)) return;
  if (currentBook && !confirm('This replaces your current book. Continue?')) return;
  cancelNarration();
  showModal(`<span class="modal-kicker">YOUR PRIVATE LIBRARY</span><h2 id="modalTitle">Choose a book to read.</h2><p>AI Reading keeps one book in your account and lays the whole text out as one continuous reader.</p><label class="upload-zone" id="uploadZone" for="bookFile"><span class="upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v14"/><path d="m6 9 6-6 6 6"/><path d="M4 21h16"/></svg></span><strong>Drop a book here or choose a file</strong><span class="upload-support">EPUB, PDF, TXT, or Markdown · up to 14 MB</span><span class="upload-label">Choose file</span><input type="file" id="bookFile" accept=".epub,.pdf,.txt,.md,application/pdf,application/epub+zip,text/plain,text/markdown" /></label><p class="upload-note">Uploading a different book replaces your current book.</p><div id="uploadMessage" class="upload-message" aria-live="polite"></div>`, 'upload-dialog');
  const zone = document.querySelector('#uploadZone');
  const input = document.querySelector('#bookFile');
  input.addEventListener('change', () => { if (input.files[0]) importBook(input.files[0]); });
  for (const eventName of ['dragenter', 'dragover']) zone.addEventListener(eventName, event => { event.preventDefault(); zone.classList.add('dragging'); });
  for (const eventName of ['dragleave', 'drop']) zone.addEventListener(eventName, event => { event.preventDefault(); zone.classList.remove('dragging'); });
  zone.addEventListener('drop', event => { if (event.dataTransfer.files[0]) importBook(event.dataTransfer.files[0]); });
}

async function importBook(file) {
  if (file.size > 14 * 1024 * 1024) { setUploadError('This file is larger than 14 MB.'); return; }
  const message = document.querySelector('#uploadMessage');
  message.textContent = 'Opening your book…';
  message.classList.add('visible');
  try {
    const extension = file.name.split('.').pop().toLowerCase();
    let result;
    if (extension === 'txt' || extension === 'md') result = await readTextFile(file);
    else if (extension === 'pdf') result = await readPdf(file);
    else if (extension === 'epub') result = await readEpub(file);
    else throw new Error('Choose an EPUB, PDF, TXT, or Markdown file.');
    if (!result.chapters.some(chapter => chapter.text.trim())) throw new Error('No readable text was found in this file.');
    const title = result.title || file.name.replace(/\.[^.]+$/, '');
    const bookData = { title, author: result.author || '', format: extension, chapters: result.chapters };
    await api('/api/books', { method: 'PUT', body: JSON.stringify(bookData) });
    closeModal();
    renderBook({ ...bookData, progress: { segmentIndex: 0, wordOffset: 0, scrollPercent: 0 } });
    toast('Your book is ready to read');
  } catch (error) { setUploadError(error.message || 'Could not open this book. Please try another file.'); }
}

function setUploadError(message) {
  const element = document.querySelector('#uploadMessage');
  if (element) { element.textContent = message; element.classList.add('visible', 'error'); }
  else toast(message);
}

async function readTextFile(file) {
  const text = (await file.text()).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const headingMatch = text.match(/^#\s+(.+)$/m);
  const firstLine = text.split('\n').map(line => line.trim()).find(Boolean) || '';
  const title = headingMatch ? headingMatch[1].trim() : firstLine.slice(0, 120);
  return { title, author: '', chapters: [{ title: '', text }] };
}

async function readPdf(file) {
  const pdfjs = await import('./vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const info = await pdf.getMetadata().catch(() => ({ info: {} }));
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let text = '';
    let lastY = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(lastY - y) > 2) text += '\n\n';
      else if (text && !text.endsWith('\n')) text += ' ';
      text += item.str;
      if (item.hasEOL) text += '\n\n';
      lastY = y;
    }
    pages.push(text.trim());
  }
  return { title: info.info?.Title || '', author: info.info?.Author || '', chapters: [{ title: '', text: pages.join('\n\n') }] };
}

async function readEpub(file) {
  if (!window.JSZip) throw new Error('The EPUB reader could not be loaded. Refresh the page and try again.');
  const zip = await window.JSZip.loadAsync(file);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('This EPUB is missing its book index.');
  const container = new DOMParser().parseFromString(await containerFile.async('string'), 'application/xml');
  const packagePath = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!packagePath || !zip.file(packagePath)) throw new Error('Could not find the EPUB book index.');
  const opf = new DOMParser().parseFromString(await zip.file(packagePath).async('string'), 'application/xml');
  const manifestItems = [...opf.getElementsByTagNameNS('*', 'item')].filter(item => item.parentNode?.localName === 'manifest');
  const manifest = new Map(manifestItems.map(item => [item.getAttribute('id'), item]));
  const spine = opf.getElementsByTagNameNS('*', 'spine')[0];
  const pathPrefix = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : '';
  const resolveZipPath = href => {
    const parts = href.startsWith('/') ? [] : pathPrefix.split('/').filter(Boolean);
    let safeHref = href.split(/[?#]/, 1)[0];
    try { safeHref = decodeURIComponent(safeHref); } catch { /* keep raw */ }
    for (const part of safeHref.replace(/^\//, '').split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  };
  const metadataText = name => [...opf.getElementsByTagNameNS('*', name)].map(node => node.textContent?.trim()).find(Boolean) || '';
  const chapters = [];
  for (const ref of spine?.getElementsByTagNameNS('*', 'itemref') || []) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !/xhtml|html/i.test(item.getAttribute('media-type') || '')) continue;
    const entry = zip.file(resolveZipPath(item.getAttribute('href') || ''));
    if (!entry) continue;
    const doc = new DOMParser().parseFromString(await entry.async('string'), 'text/html');
    doc.querySelectorAll('script,style,svg,nav').forEach(node => node.remove());
    const headingElement = doc.querySelector('h1,h2,h3');
    const heading = headingElement?.textContent?.trim() || '';
    if (headingElement) headingElement.remove();
    const text = (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text) chapters.push({ title: heading, text });
  }
  if (!chapters.length) throw new Error('This EPUB did not contain readable chapters.');
  return { title: metadataText('title'), author: metadataText('creator'), chapters };
}

function openNavigation(view) {
  document.querySelectorAll('.primary-nav [data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === view));
  document.querySelector('#pageCrumb').textContent = view === 'library' ? 'My book' : view[0].toUpperCase() + view.slice(1);
  if (view === 'highlights' || view === 'notes') toast(currentBook ? 'Highlights and notes are coming soon.' : 'Upload a book to begin reading.');
  if (view === 'settings') toast('Settings are coming soon.');
  if (view === 'home' || view === 'library') document.querySelector('#librarySection').scrollIntoView({ behavior: 'smooth' });
  document.querySelector('#sidebar').classList.remove('mobile-open');
}

document.querySelector('#authSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
const authCloseBtn = document.querySelector('#authClose');
if (authCloseBtn) {
  authCloseBtn.setAttribute('aria-label', 'Close sign-in');
  authCloseBtn.addEventListener('click', () => {
    showGuestMode();
    renderEmpty();
  });
}
const mobileMenuBtn = document.querySelector('#mobileMenu');
if (mobileMenuBtn) {
  mobileMenuBtn.setAttribute('aria-label', 'Toggle navigation menu');
}
const profileMenuBtn = document.querySelector('.profile-row button');
if (profileMenuBtn) {
  profileMenuBtn.setAttribute('aria-label', 'Profile options');
}
const searchInputEl = document.querySelector('#searchInput');
if (searchInputEl) {
  searchInputEl.setAttribute('aria-label', 'Search book text');
}
document.querySelector('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = document.querySelector('#usernameInput').value.trim();
  const password = document.querySelector('#passwordInput').value;
  const button = document.querySelector('#authSubmit');
  const error = document.querySelector('#authError');
  button.disabled = true;
  error.textContent = '';
  try {
    const result = await api(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ username, password }) });
    form.reset();
    showApplication(result.user.username);
    await loadUserBook();
    const pending = pendingAuthAction;
    pendingAuthAction = null;
    if (pending) pending();
  } catch (requestError) { error.textContent = requestError.message; }
  finally { button.disabled = false; }
});

document.querySelector('#logoutButton').addEventListener('click', async () => {
  if (!document.body.classList.contains('signed-in')) {
    requireAuth();
    return;
  }
  pendingAuthAction = null;
  stopNarration();
  try { await api('/api/auth/logout', { method: 'POST' }); }
  catch { /* Expired sessions can still return to guest mode. */ }
  currentBook = null;
  closeModal();
  setAuthMode('login');
  showGuestMode();
  renderEmpty();
});

document.querySelector('#addBookButton').addEventListener('click', openUpload);
document.querySelector('#upgradeButton').addEventListener('click', () => toast('AI Reading Plus is coming soon.'));
document.querySelector('.workspace-switch').addEventListener('click', () => toast('Workspace switching is coming soon.'));
document.querySelector('#closeModal').addEventListener('click', closeModal);
modalBackdrop.addEventListener('keydown', event => {
  if (event.key !== 'Tab' || !modalBackdrop.classList.contains('open')) return;
  const focusable = [...modalBackdrop.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
modalBackdrop.addEventListener('click', event => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeModal();
    hideHighlightButton();
    const sidebar = document.querySelector('#sidebar');
    if (sidebar.classList.contains('mobile-open')) {
      sidebar.classList.remove('mobile-open');
      document.querySelector('#mobileMenu').setAttribute('aria-expanded', 'false');
      sidebar.setAttribute('inert', '');
      sidebar.setAttribute('aria-hidden', 'true');
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); }
});
document.querySelector('#mobileMenu').addEventListener('click', () => {
  const sidebar = document.querySelector('#sidebar');
  const isOpen = sidebar.classList.toggle('mobile-open');
  document.querySelector('#mobileMenu').setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    sidebar.removeAttribute('inert');
    sidebar.removeAttribute('aria-hidden');
  } else {
    sidebar.setAttribute('inert', '');
    sidebar.setAttribute('aria-hidden', 'true');
  }
});

let selectionTimeout;
document.addEventListener('selectionchange', () => {
  clearTimeout(selectionTimeout);
  selectionTimeout = setTimeout(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
      const range = selection.getRangeAt(0);
      const reader = document.querySelector('#readerDocument');
      if (reader && reader.contains(range.commonAncestorContainer)) {
        const rects = range.getClientRects();
        const rect = rects[0] || range.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          showHighlightButton(rect.left + rect.width / 2, Math.max(8, rect.top - 40));
        }
      }
    }
  }, 200);
});

document.addEventListener('mouseup', (e) => {
  if (e.target.closest('#readerDocument')) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
      const range = selection.getRangeAt(0);
      const rects = range.getClientRects();
      const rect = rects[0] || range.getBoundingClientRect();
      showHighlightButton(rect.left + rect.width / 2, Math.max(8, rect.top - 40));
    }
  }
});

document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); openNavigation(link.dataset.view); }));
window.addEventListener('hashchange', () => openNavigation(location.hash.slice(1) || 'home'));
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = searchInput.value.trim().toLowerCase();
    document.querySelectorAll('.reader-paragraph').forEach(paragraph => {
      if (paragraph.dataset.searchText === undefined) {
        paragraph.dataset.searchText = paragraph.textContent.toLowerCase();
      }
      paragraph.classList.toggle('search-match', Boolean(query && paragraph.dataset.searchText.includes(query)));
    });
    const match = document.querySelector('.reader-paragraph.search-match');
    if (match && match.dataset.scrolled !== query) {
      const pageNode = match.closest('.book-page');
      if (pageNode && !pageNode.classList.contains('active')) {
        goToPage(Number(pageNode.dataset.pageIndex), true);
      }
      match.scrollIntoView({ behavior: pickBehavior(), block: 'center' });
      document.querySelectorAll('.reader-paragraph.search-match').forEach(p => delete p.dataset.scrolled);
      match.dataset.scrolled = query;
    }
  }, 150);
});
document.querySelector('#helpButton').addEventListener('click', () => showModal('<span class="modal-kicker">A HAND WHEN YOU NEED ONE</span><h2 id="modalTitle">Read the whole book aloud.</h2><p>Choose a voice and speed, then start reading. The current sentence and spoken word are highlighted. Pause or stop whenever you like; your book and progress are private to your account.</p><button class="modal-secondary" id="helpDone">Got it</button>', 'simple-dialog'));
modalBody.addEventListener('click', event => { if (event.target.closest('#helpDone')) closeModal(); });
window.addEventListener('pagehide', () => {
  if (audioRecorder && audioRecorder.state === 'recording') {
    try { audioRecorder.stop(); } catch { /* page is unloading */ }
  }
  apiProgress(true);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') apiProgress(true);
});
document.querySelector('#authScreen').addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });

document.addEventListener('click', event => {
  if (highlightContainer && highlightContainer.style.display === 'flex' && !highlightContainer.contains(event.target)) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) hideHighlightButton();
  }
});

async function loadUserBook() {
  try {
    const result = await api('/api/books');
    if (result.book) renderBook(result.book);
    else renderEmpty();
  } catch (error) {
    if (error.status === 401) { showGuestMode(); renderEmpty(); }
    else { renderEmpty(); toast(error.message); }
  }
}

async function initialize() {
  window.__marginHandle401 = () => {
    stopNarration();
    showGuestMode();
    renderEmpty();
    showAuth('Your session expired. Please sign in again.');
  };
  try {
    const result = await api('/api/auth/me');
    if (result.user) {
      showApplication(result.user.username);
      await loadUserBook();
    } else {
      showGuestMode();
      renderEmpty();
    }
  } catch (error) {
    // Only show guest mode if it's a real 401, otherwise retry or keep the current view
    if (error.status === 401) {
      showGuestMode();
      renderEmpty();
    } else {
      // If it's a network error, try to load the book from cache/local state rather than kicking the user out
      renderEmpty();
    }
  } finally {
    const splash = document.getElementById('appSplash');
    if (splash) splash.classList.add('hidden');
  }
}

initialize();