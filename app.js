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
let progress = { segmentIndex: 0, wordOffset: 0, scrollPercent: 0 };

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
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
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

async function downloadFullAudio() {
  if (audioRecorder && audioRecorder.state !== 'inactive') return toast('A recording is already in progress.');
  if (!currentBook || !readingSegments.length) return toast('Upload a book first.');
  if (!('speechSynthesis' in window)) return toast('Read aloud is not supported in this browser.');
  if (!window.isSecureContext) return toast('Audio capture requires HTTPS or localhost.');
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) return toast('Audio capture is not supported in this browser.');
  const mimeType = pickAudioMimeType();
  if (!mimeType) return toast('This browser does not support a recordable audio format.');
  if (!confirm('To save the full book audio, pick THIS tab and tick "Share tab audio". Narration runs from the start; your reading position is restored afterwards. Continue?')) return;
  audioProgressSnapshot = { ...progress };
  try {
    audioStream = await navigator.mediaDevices.getDisplayMedia({ video: { width: 320, height: 180 }, audio: true });
    const audioTracks = audioStream.getAudioTracks();
    if (!audioTracks.length) { stopAudioTracks(); audioProgressSnapshot = null; return toast('No audio shared. Enable "Share tab audio" and retry.'); }
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
      restoreProgressSnapshot();
      updateSpeechControls();
    };
    audioRecorder.onstop = saveAudioRecording;
    audioTracks[0].addEventListener('ended', () => { if (audioRecorder && audioRecorder.state === 'recording') audioRecorder.stop(); });
    audioRecorder.start(1000);
    cancelNarration();
    progress = { ...progress, segmentIndex: 0, wordOffset: 0 };
    highlightPosition();
    startNarration();
    updateSpeechControls();
    setTimeout(() => {
      if (!isNarrating) {
        if (audioRecorder && audioRecorder.state === 'recording') audioRecorder.stop();
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
  } catch (error) {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') toast(`Audio capture failed: ${error.message}`);
    stopAudioTracks();
    audioRecorder = null;
    audioChunks = [];
    audioProgressSnapshot = null;
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
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const safeTitle = (currentBook?.title || 'book').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'book';
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  anchor.download = `${safeTitle}_full_audio.${ext}`;
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
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

function showAuth(message = '') {
  document.body.classList.remove('signed-in');
  document.body.classList.add('auth-ready');
  authScreen.classList.add('open');
  document.querySelector('#authError').textContent = message;
  document.querySelector('#usernameInput').focus();
}

function showApplication(username) {
  document.body.classList.add('signed-in');
  document.body.classList.add('auth-ready');
  authScreen.classList.remove('open');
  document.querySelector('#currentUsername').textContent = username;
  document.querySelector('.workspace-copy strong').textContent = `${username}'s library`;
  document.querySelector('.profile-avatar').textContent = username.slice(0, 1).toUpperCase();
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

function showModal(content, className = '') {
  modalBody.innerHTML = content;
  document.querySelector('#modal').className = `modal ${className}`.trim();
  modalBackdrop.classList.add('open');
  modalBackdrop.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.querySelector('#closeModal').focus();
}

function closeModal() {
  modalBackdrop.classList.remove('open');
  modalBackdrop.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function apiProgress(keepalive = false) {
  if (!currentBook) return Promise.resolve();
  const payload = JSON.stringify(progress);
  if (keepalive) return fetch('/api/progress', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => { });
  return api('/api/progress', { method: 'PUT', body: payload }).catch(() => { });
}

function scheduleProgressSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => apiProgress(), 450);
}

function sentenceTokens(text) {
  if (sentenceSegmenter) return [...sentenceSegmenter.segment(text)].map(item => item.segment);
  return text.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)\s*/g) || [text];
}

function renderSentenceWords(text, segmentIndex) {
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
  bookArea.innerHTML = `<button class="empty-upload" id="emptyUpload"><span class="empty-upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v14"/><path d="m6 9 6-6 6 6"/><path d="M4 21h16"/></svg></span><strong>Start with one book</strong><span>Choose an EPUB, PDF, TXT, or Markdown file.</span><span class="empty-upload-action">Choose a book <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;vertical-align:-2px;margin-left:6px;display:inline-block"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></span></button>`;
  document.querySelector('#emptyUpload').addEventListener('click', openUpload);
}

function renderBook(book) {
  cancelNarration();
  currentBook = book;
  progress = { segmentIndex: 0, wordOffset: 0, scrollPercent: 0, ...(book.progress || {}) };
  readingSegments = [];
  document.querySelector('#navBookCount').textContent = '1';
  document.querySelector('#welcomeTitle').textContent = 'Settle in. It’s all here.';
  document.querySelector('#welcomeSubtitle').textContent = 'Your whole book, from the first line to the last, in one continuous reading view.';
  document.querySelector('#libraryEyebrow').textContent = 'NOW READING';
  document.querySelector('#libraryTitle').textContent = book.title;

  const chapterMarkup = book.chapters.map((chapter, chapterIndex) => {
    const paragraphs = chapter.text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
    const body = paragraphs.length ? paragraphs : [chapter.text.trim()].filter(Boolean);
    const paragraphMarkup = body.map((paragraph, paragraphIndex) => {
      let sentenceMarkup = '';
      for (const rawSentence of sentenceTokens(paragraph)) {
        const leading = rawSentence.match(/^\s*/)?.[0] || '';
        const trailing = rawSentence.match(/\s*$/)?.[0] || '';
        const text = rawSentence.trim();
        if (!text) { sentenceMarkup += escapeHTML(rawSentence); continue; }
        const segmentIndex = readingSegments.length;
        const wordData = renderSentenceWords(text, segmentIndex);
        readingSegments.push({ text, chapterIndex, paragraphIndex, wordRanges: wordData.wordRanges });
        sentenceMarkup += `${escapeHTML(leading)}<span class="reader-sentence" data-segment-index="${segmentIndex}">${wordData.markup}</span>${escapeHTML(trailing)}`;
      }
      return `<p class="reader-paragraph">${sentenceMarkup}</p>`;
    }).join('');
    return `<section class="book-chapter">${chapter.title ? `<h2>${escapeHTML(chapter.title)}</h2>` : ''}${paragraphMarkup}</section>`;
  }).join('');

  bookArea.innerHTML = `<article class="reader-book"><header class="reader-book-header"><div class="reader-book-heading"><span class="modal-kicker">YOUR BOOK · ${escapeHTML(book.format.toUpperCase())}</span><h2>${escapeHTML(book.title)}</h2><p>${escapeHTML(book.author || 'Uploaded book')}</p></div><div class="reader-book-actions"><button class="reader-action" id="removeBook">Remove book</button><button class="reader-action reader-action-primary" id="replaceBook">Replace book</button></div></header><div class="reading-toolbar"><div class="speech-controls"><button class="speech-button speech-start" id="speechStart"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg> <span>Start reading</span></button><button class="speech-button" id="speechPause" disabled><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg> <span>Pause</span></button><button class="speech-button speech-stop" id="speechStop" disabled><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> <span>Stop</span></button><button class="speech-button speech-download" id="downloadAudioBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg> <span>Download full audio</span></button></div><div class="voice-settings"><label for="voiceSelect">Voice</label><select id="voiceSelect"><option value="">System default</option></select><label for="rateSelect">Speed</label><select id="rateSelect"><option value="0.8">0.8×</option><option value="1" selected>1×</option><option value="1.2">1.2×</option><option value="1.5">1.5×</option></select></div><span class="speech-status" id="speechStatus" aria-live="polite">Ready when you are</span></div><div class="reader-progress"><span>Reading progress</span><div class="reader-progress-track"><i id="progressBar"></i></div><span id="progressPercent">0%</span></div><div class="reader-document" id="readerDocument"><article class="reader-copy">${chapterMarkup}</article><div class="book-end">You’ve reached the end of <em>${escapeHTML(book.title)}</em>.</div></div></article>`;

  document.querySelector('#replaceBook').addEventListener('click', openUpload);
  document.querySelector('#removeBook').addEventListener('click', async () => {
    if (!confirm('Remove this book from your account?')) return;
    cancelNarration();
    try { await api('/api/books', { method: 'DELETE' }); renderEmpty(); toast('Book removed'); }
    catch (error) { toast(error.message); }
  });
  document.querySelector('#speechStart').addEventListener('click', startNarration);
  document.querySelector('#speechPause').addEventListener('click', toggleNarrationPause);
  document.querySelector('#speechStop').addEventListener('click', stopNarration);
  document.querySelector('#downloadAudioBtn').addEventListener('click', downloadFullAudio);
  configureVoices();
  const reader = document.querySelector('#readerDocument');
  const savedRatio = Math.max(0, Math.min(100, Number(progress.scrollPercent) || 0));
  if (progress.segmentIndex >= readingSegments.length) progress.segmentIndex = Math.max(0, readingSegments.length - 1);
  requestAnimationFrame(() => {
    if (progress.segmentIndex > 0) {
      const sentence = document.querySelector(`.reader-sentence[data-segment-index="${progress.segmentIndex}"]`);
      if (sentence) {
        sentence.scrollIntoView({ block: 'center' });
        updateReadProgress();
        highlightPosition();
        return;
      }
    }
    reader.scrollTop = (reader.scrollHeight - reader.clientHeight) * savedRatio / 100;
    updateReadProgress();
    highlightPosition();
  });
  reader.addEventListener('scroll', () => {
    updateReadProgress();
    const maxScroll = reader.scrollHeight - reader.clientHeight;
    progress.scrollPercent = maxScroll > 0 ? Math.max(0, Math.min(100, reader.scrollTop / maxScroll * 100)) : 0;
    scheduleProgressSave();
  }, { passive: true });
}

function updateReadProgress() {
  const reader = document.querySelector('#readerDocument');
  const bar = document.querySelector('#progressBar');
  const label = document.querySelector('#progressPercent');
  if (!reader || !bar || !label) return;
  const max = reader.scrollHeight - reader.clientHeight;
  const percent = max > 0 ? Math.round(reader.scrollTop / max * 100) : 100;
  bar.style.width = `${percent}%`;
  label.textContent = `${percent}%`;
}

function configureVoices() {
  const select = document.querySelector('#voiceSelect');
  if (!select || !('speechSynthesis' in window)) return;
  const refresh = () => {
    speechVoices = speechSynthesis.getVoices();
    const oldValue = select.value;
    select.innerHTML = '<option value="">System default</option>';
    speechVoices.forEach((voice) => {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = `${voice.name} · ${voice.lang}`;
      select.append(option);
    });
    if ([...select.options].some(option => option.value === oldValue)) select.value = oldValue;
  };
  refresh();
  speechSynthesis.onvoiceschanged = refresh;
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
  if (sentence) sentence.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateSpeechControls() {
  const start = document.querySelector('#speechStart');
  const pause = document.querySelector('#speechPause');
  const stop = document.querySelector('#speechStop');
  const download = document.querySelector('#downloadAudioBtn');
  const status = document.querySelector('#speechStatus');
  if (!start || !pause || !stop || !status) return;
  start.disabled = isNarrating && !isPaused;
  start.querySelector('span').textContent = isPaused ? 'Resume reading' : progress.segmentIndex ? 'Continue reading' : 'Start reading';
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
      if (wordIndex % 5 === 0) apiProgress();
    }
  };
  utterance.onend = () => {
    if (!isNarrating || isPaused) return;
    progress.segmentIndex += 1;
    progress.wordOffset = 0;
    highlightPosition();
    apiProgress();
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
  if (currentBook && !confirm('This replaces your current book. Continue?')) return;
  cancelNarration();
  showModal(`<span class="modal-kicker">YOUR PRIVATE LIBRARY</span><h2 id="modalTitle">Choose a book to read.</h2><p>Margin keeps one book in your account and lays the whole text out as one continuous reader.</p><label class="upload-zone" id="uploadZone" for="bookFile"><span class="upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v14"/><path d="m6 9 6-6 6 6"/><path d="M4 21h16"/></svg></span><strong>Drop a book here or choose a file</strong><span class="upload-support">EPUB, PDF, TXT, or Markdown · up to 14 MB</span><span class="upload-label">Choose file</span><input type="file" id="bookFile" accept=".epub,.pdf,.txt,.md,application/pdf,application/epub+zip,text/plain,text/markdown" /></label><p class="upload-note">Uploading a different book replaces your current book.</p><div id="uploadMessage" class="upload-message" aria-live="polite"></div>`, 'upload-dialog');
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
    await api('/api/books', { method: 'PUT', body: JSON.stringify({ title, author: result.author || '', format: extension, chapters: result.chapters }) });
    closeModal();
    const saved = await api('/api/books');
    renderBook(saved.book);
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
  const pdfjs = await import('/vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
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
    for (const part of decodeURIComponent(href.split(/[?#]/, 1)[0]).replace(/^\//, '').split('/')) {
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
  if (window.innerWidth <= 700) document.querySelector('#sidebar').classList.remove('mobile-open');
}

document.querySelector('#authSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
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
  } catch (requestError) { error.textContent = requestError.message; }
  finally { button.disabled = false; }
});

document.querySelector('#logoutButton').addEventListener('click', async () => {
  stopNarration();
  try { await api('/api/auth/logout', { method: 'POST' }); }
  catch { /* Expired sessions can still return to the sign-in screen. */ }
  currentBook = null;
  closeModal();
  setAuthMode('login');
  showAuth();
});

document.querySelector('#addBookButton').addEventListener('click', openUpload);
document.querySelector('#upgradeButton').addEventListener('click', () => toast('Margin Plus is coming soon.'));
document.querySelector('.workspace-switch').addEventListener('click', () => toast('Workspace switching is coming soon.'));
document.querySelector('#closeModal').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', event => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.stopPropagation(); closeModal(); document.querySelector('#sidebar').classList.remove('mobile-open'); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); }
});
document.querySelector('#mobileMenu').addEventListener('click', () => document.querySelector('#sidebar').classList.toggle('mobile-open'));

document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); openNavigation(link.dataset.view); }));
window.addEventListener('hashchange', () => openNavigation(location.hash.slice(1) || 'home'));
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = searchInput.value.trim().toLowerCase();
    document.querySelectorAll('.reader-paragraph').forEach(paragraph => paragraph.classList.toggle('search-match', Boolean(query && paragraph.textContent.toLowerCase().includes(query))));
    const match = document.querySelector('.reader-paragraph.search-match');
    if (match && match.dataset.scrolled !== query) {
      match.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

async function loadUserBook() {
  try {
    const result = await api('/api/books');
    if (result.book) renderBook(result.book);
    else renderEmpty();
  } catch (error) {
    if (/sign in/i.test(error.message)) { setAuthMode('login'); showAuth(); }
    else { renderEmpty(); toast(error.message); }
  }
}

async function initialize() {
  try {
    const result = await api('/api/auth/me');
    if (result.user) {
      showApplication(result.user.username);
      await loadUserBook();
    } else {
      setAuthMode('login');
      showAuth();
    }
  } catch {
    setAuthMode('login');
    showAuth();
  }
}

initialize();
