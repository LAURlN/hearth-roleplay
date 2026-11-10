'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    settings: null, stories: [], story: null, operation: null, selecting: false,
    selection: 0, pollToken: 0, pollTimer: null, pollController: null,
    message: null, revision: null, imageIndex: 0, transcriptKey: '',
    setupLoading: false, settingsLoading: false, connection: null, drawerReturn: null, models: [], modelRequest: 0,
    booted: false, nearBottom: true, confirmAction: null, submissions: {},
    libraryArchived: false, libraryTarget: null, visualEditor: null, appearanceSaving: false, promptEditor:null, characterPromptSaving:false,
  };
  const settingsFields = ['proxyBaseUrl', 'chatModel', 'helperModel', 'imageModel', 'chatEffort', 'characterEffort', 'helperEffort', 'illustratorEffort', 'roleplayPrompt', 'simpleModePrompt', 'characterPrompt',
    'illustratorPrompt', 'autoIllustrate', 'imageCooldown', 'imageQuality', 'imageSize',
    'maxResponders', 'contextTokenLimit'];
  const numericSettings = new Set(['imageCooldown', 'maxResponders', 'contextTokenLimit']);
  const finishedImageStatuses = new Set(['completed', 'complete', 'done', 'failed', 'error',
    'cancelled', 'canceled', 'skipped', 'superseded', 'stale', 'invalidated']);
  const storage = {
    get(key) { try { return localStorage.getItem(`hearth:${key}`); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(`hearth:${key}`, value); } catch { /* Private browsing may disable storage. */ } },
    remove(key) { try { localStorage.removeItem(`hearth:${key}`); } catch { /* Optional preference. */ } },
    json(key) { try { return JSON.parse(this.get(key)); } catch { return null; } },
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  function button(text, className, action) {
    const element = node('button', className, text);
    element.type = 'button';
    if (action) element.addEventListener('click', action);
    return element;
  }
  function hide(id, hidden = true) { $(id).hidden = hidden; }
  function inlineError(id, error) {
    $(id).textContent = error ? error.message || String(error) : '';
    hide(id, !error);
  }
  let toastTimer;
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    hide('toast', false);
    toastTimer = setTimeout(() => hide('toast'), 4500);
  }
  function showError(error, retry = false) {
    $('error-text').textContent = error.message || String(error);
    hide('error-banner', false);
    hide('retry-load', !retry);
  }
  function clearError() { hide('error-banner'); }

  async function api(path, { method = 'GET', body, signal } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal,
        headers: body === undefined ? { Accept: 'application/json' } : {
          Accept: 'application/json', 'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('The local Hearth server could not be reached. Check that it is running, then try again.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }
  function storyPath(id, suffix = '') { return `/api/stories/${encodeURIComponent(id)}${suffix}`; }
  function imageActive(story = state.story) {
    const status = story?.illustrationJob?.status;
    return Boolean(status && !finishedImageStatuses.has(status));
  }
  function locked() { return Boolean(state.operation || state.selecting || state.story?.busy || activeSubmission()); }
  function dateLabel(value, withTime = false) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, withTime
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric' }).format(date);
  }
  function displayValue(value) {
    if (value === undefined || value === null || value === '') return '—';
    if (Array.isArray(value)) return value.map(displayValue).join(', ');
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  function safeImageUrl(raw) {
    if (typeof raw !== 'string') return null;
    if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(raw)) return raw;
    try {
      const url = new URL(raw, location.origin);
      if (url.origin === location.origin && /^https?:$/.test(url.protocol)) return url.href;
    } catch { /* Invalid image URLs are not rendered. */ }
    return null;
  }
  function makeImage(record, className) {
    const image = node('img', className);
    image.alt = record.caption || 'Story illustration';
    image.loading = 'lazy';
    const url = safeImageUrl(record.url);
    if (url) image.src = url;
    else image.alt = 'Illustration unavailable: invalid or external image address';
    image.addEventListener('error', () => { image.alt = 'Illustration unavailable. The image file could not be loaded.'; });
    return image;
  }

  let focusBeforeDialog = new WeakMap();
  function openDialog(id, focusId) {
    const dialog = $(id);
    if (dialog.open) return;
    focusBeforeDialog.set(dialog, document.activeElement);
    dialog.showModal();
    if (focusId) requestAnimationFrame(() => $(focusId).focus());
  }
  function closeDialog(dialog) {
    if (typeof dialog === 'string') dialog = $(dialog);
    if (dialog.id === 'setup-dialog' && state.setupLoading) return;
    if (dialog.id === 'settings-dialog' && state.settingsLoading) return;
    if (dialog.id === 'appearance-dialog' && state.appearanceSaving) return;
    if (dialog.id === 'character-prompt-dialog' && state.characterPromptSaving) return;
    dialog.close();
  }
  document.querySelectorAll('dialog').forEach((dialog) => {
    const heading = dialog.querySelector('.dialog-heading h2');
    if (heading) {
      if (!heading.id) heading.id = `${dialog.id}-title`;
      dialog.setAttribute('aria-labelledby', heading.id);
    }
    dialog.addEventListener('close', () => {
      dialog.querySelectorAll('.copy-fallback').forEach((field) => field.remove());
      const previous = focusBeforeDialog.get(dialog);
      if (previous?.isConnected && !previous.disabled) previous.focus();
      else if (state.story) $('composer').focus({ preventScroll: true });
      else $('welcome-start').focus({ preventScroll: true });
    });
    dialog.addEventListener('cancel', (event) => {
      if ((dialog.id === 'setup-dialog' && state.setupLoading)
        || (dialog.id === 'settings-dialog' && state.settingsLoading)
        || (dialog.id === 'appearance-dialog' && state.appearanceSaving)
        || (dialog.id === 'character-prompt-dialog' && state.characterPromptSaving)) event.preventDefault();
    });
    dialog.querySelectorAll('[data-close]').forEach((control) => {
      control.addEventListener('click', () => closeDialog(dialog));
    });
  });

  const mobile = matchMedia('(max-width: 820px)');
  function setDrawer(open) {
    if (open && !mobile.matches) return;
    if (open) state.drawerReturn = document.activeElement;
    $('library').classList.toggle('is-open', open);
    $('open-library').setAttribute('aria-expanded', String(open));
    $('workspace').inert = open;
    $('library').inert = mobile.matches && !open;
    hide('drawer-shade', !open);
    if (open) {
      $('library').setAttribute('role', 'dialog');
      $('library').setAttribute('aria-modal', 'true');
      $('close-library').focus();
    } else {
      $('library').removeAttribute('role');
      $('library').removeAttribute('aria-modal');
      if (state.drawerReturn?.isConnected) state.drawerReturn.focus();
      state.drawerReturn = null;
    }
  }
  $('open-library').addEventListener('click', () => setDrawer(true));
  $('close-library').addEventListener('click', () => setDrawer(false));
  $('drawer-shade').addEventListener('click', () => setDrawer(false));
  mobile.addEventListener('change', () => setDrawer(false));
  setDrawer(false);
  document.addEventListener('keydown', (event) => {
    if (!$('library').classList.contains('is-open') || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); setDrawer(false); }
    if (event.key === 'Tab') {
      const controls = [...$('library').querySelectorAll('a,button,input')]
        .filter((element) => !element.disabled && element.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  function renderLibrary() {
    const list = $('story-list');
    list.replaceChildren();
    const query = $('story-search').value.toLocaleLowerCase().trim();
    const summaries = [...state.stories].filter(story=>Boolean(story.archived)===state.libraryArchived).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    $('story-count').textContent = String(summaries.length);
    $('library-active').setAttribute('aria-pressed',String(!state.libraryArchived));
    $('library-archived').setAttribute('aria-pressed',String(state.libraryArchived));
    summaries.filter((story) => String(story.title).toLocaleLowerCase().includes(query)).forEach((story) => {
      const row=node('div','story-row');
      const item = button('', 'story-item', () => selectStory(story.id));
      item.disabled = Boolean(state.operation || state.selecting);
      item.setAttribute('aria-current', String(story.id === state.story?.id));
      item.append(node('span', 'story-item-title', story.title || 'Untitled story'));
      item.append(node('span', 'story-item-meta', `${dateLabel(story.updatedAt)} · ${story.messageCount || 0} passages · ${story.branchCount || 1} ${story.branchCount === 1 ? 'branch' : 'branches'}`));
      const actions=button('···','icon-button library-story-actions',()=>openLibraryActions(story.id));
      actions.setAttribute('aria-label',`Manage ${story.title||'Untitled story'}`);
      actions.setAttribute('aria-haspopup','dialog');
      actions.disabled=Boolean(state.operation||state.selecting||(state.story?.id===story.id&&state.story.busy));
      row.append(item,actions);list.append(row);
    });
    if (!list.childElementCount) list.append(node('p', 'library-note muted', query ? 'No stories match your search.' : state.libraryArchived?'No archived stories.':'Your next world belongs here. Begin a story above.'));
  }
  $('story-search').addEventListener('input', renderLibrary);
  $('library-active').addEventListener('click',()=>{state.libraryArchived=false;renderLibrary();});
  $('library-archived').addEventListener('click',()=>{state.libraryArchived=true;renderLibrary();});
  async function refreshLibrary() {
    try { state.stories = await api('/api/stories'); renderLibrary(); }
    catch { /* The story response already confirms the primary save. */ }
  }
  function upsertSummary(story) {
    const summary = { id: story.id, title: story.title, archived:Boolean(story.archived), version:story.version, updatedAt: story.updatedAt,
      messageCount: story.branch.messages.filter(message => !message.internal).length, branchCount: story.branches.length };
    const index = state.stories.findIndex((item) => item.id === story.id);
    if (index < 0) state.stories.unshift(summary);
    else state.stories[index] = summary;
  }
  function persistComposer() {
    if (state.story) storage.set(`draft:${state.story.id}`, $('composer').value);
  }
  function resizeComposer() {
    const composer = $('composer');
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(180, Math.max(64, composer.scrollHeight))}px`;
  }
  async function selectStory(id) {
    if (state.operation || state.selecting) return;
    persistComposer();
    setDrawer(false);
    clearError();
    state.failedSelection = null;
    stopPolling();
    const selection = ++state.selection;
    state.selecting = true;
    hide('story-loading', false);
    hide('welcome'); hide('conversation'); hide('writing-area');
    updateControls(); renderLibrary();
    try {
      const story = await api(storyPath(id));
      if (selection !== state.selection) return;
      state.submissions[id] = storage.json(`submissions:${id}`) || [];
      state.transcriptKey = '';
      state.story = null;
      $('composer').value = storage.get(`draft:${story.id}`) || '';
      applyStory(story, { forceBottom: true });
      resizeComposer();
      storage.set('last-story', story.id);
    } catch (error) {
      state.failedSelection = id;
      showError(error, true);
      if (error.status === 404) {
        storage.remove('last-story');
        state.stories = state.stories.filter((story) => story.id !== id);
      }
    } finally {
      if (selection === state.selection) {
        state.selecting = false;
        hide('story-loading');
        hide('welcome', Boolean(state.story));
        hide('conversation', !state.story);
        hide('writing-area', !state.story);
        updateControls(); renderLibrary(); schedulePolling();
      }
    }
  }

  function applyStory(story, { forceBottom = false } = {}) {
    if (state.story?.id === story.id && Number(story.version) < Number(state.story.version)) return;
    const changedStory = state.story?.id !== story.id;
    const changedBranch = state.story?.activeBranchId !== story.activeBranchId;
    const wasNearBottom = state.nearBottom;
    state.story = story;
    reconcileSubmissions(story);
    upsertSummary(story);
    $('story-title').textContent = story.title || 'Untitled story';
    document.title = `${story.title || 'Your story'} · Hearth`;
    $('header-kicker').textContent = `${story.setup?.mode === 'simple' ? 'Simple' : 'Detailed'} · ${story.world?.location || 'THE STORY CONTINUES'}`;
    $('branch-label').textContent = story.branch.name || 'Branches';
    $('open-branches').title = `Branches · ${story.branch.name}`;
    hide('story-tools', false); hide('welcome'); hide('conversation', false); hide('writing-area', false);
    const key = JSON.stringify([story.activeBranchId, story.branch.messages, story.branch.responses, story.branch.illustrations, branchSubmissions()]);
    if (key !== state.transcriptKey) {
      state.transcriptKey = key;
      renderTranscript();
      if (forceBottom || changedStory || changedBranch || wasNearBottom) scrollToBottom();
    }
    renderLibrary(); updateControls();
    if ($('branches-dialog').open) renderBranches();
    if ($('gallery-dialog').open) renderGallery();
    if ($('inspector-dialog').open) renderInspector();
  }
  // Submission records are local recovery data, never canonical messages or checkpoints.
  function branchSubmissions(story = state.story) {
    return (state.submissions?.[story?.id] || []).filter(item => item.branchId === story.activeBranchId);
  }
  function activeSubmission() { return branchSubmissions().find(item => item.status !== 'failed'); }
  function saveSubmissions(id) { storage.set(`submissions:${id}`, JSON.stringify(state.submissions[id] || [])); }
  function failSubmission(item, reason) {
    item.status = 'failed'; item.reason = reason;
    if (state.story?.id === item.storyId && state.story.activeBranchId === item.branchId && !$('composer').value) {
      $('composer').value = item.draft; persistComposer(); resizeComposer();
    }
  }
  function reconcileSubmissions(story, settled = false) {
    const records = state.submissions?.[story.id];
    if (!records?.length) return;
    const messages = story.branch.messages || [];
    for (const item of records.filter(entry => entry.branchId === story.activeBranchId)) {
      const anchor = item.anchorMessageId == null ? -1 : messages.findIndex(message => message.id === item.anchorMessageId);
      const candidate = messages.slice(anchor + 1).find(message => message.role === 'player' && !item.priorMessageIds.includes(message.id));
      // The first new canonical player after the submitted boundary identifies this turn.
      if ((item.anchorMessageId == null || anchor >= 0) && Number(story.version) > item.expectedVersion
        && candidate?.role === 'player' && candidate.text === item.text && !item.priorMessageIds.includes(candidate.id)) {
        records.splice(records.indexOf(item), 1);
      } else if (item.status !== 'failed' && !story.busy && (settled || state.operation?.id !== story.id)) {
        failSubmission(item, 'This passage was not saved. Restore or copy it to try again.');
      } else if (item.status !== 'failed') item.status = story.busy ? 'generating' : 'sending';
    }
    saveSubmissions(story.id);
  }
  function renderSubmission(item) {
    const article = node('article', 'message pending-message');
    article.dataset.role = 'player'; article.dataset.submissionToken = item.token;
    const failed = item.status === 'failed';
    const status = failed ? 'Not sent · recoverable' : item.status === 'checking' ? 'Checking delivery · not yet saved'
      : item.status === 'generating' ? 'Generating · not yet saved' : 'Sending · not yet saved';
    const header = node('div', 'message-header');
    header.append(node('span', 'speaker-name', 'You'), node('span', 'submission-status', status));
    article.append(header, node('div', 'message-text', item.text));
    if (failed) article.append(node('p', 'field-hint', item.reason));
    const actions = node('div', 'submission-actions');
    if (failed) {
      const restore = button('Restore to composer', 'subtle', () => {
        if ($('composer').value && $('composer').value !== item.draft) { toast('Your current draft is preserved. Copy the passage or clear the composer to restore it.'); return; }
        $('composer').value = item.draft; persistComposer(); resizeComposer(); updateControls(); $('composer').focus();
      });
      actions.append(restore);
    }
    actions.append(button('Copy submitted text', 'subtle', async () => {
      try { await navigator.clipboard.writeText(item.draft); toast('Submitted text copied.'); }
      catch {
        const field = node('textarea', 'submission-copy'); field.value = item.draft;
        field.readOnly = true; field.setAttribute('aria-label', 'Submitted text to copy');
        actions.append(field); field.focus(); field.select();
      }
    }));
    if (failed) actions.append(button('Dismiss', 'subtle', () => {
      const records = state.submissions[item.storyId]; records.splice(records.indexOf(item), 1);
      saveSubmissions(item.storyId); state.transcriptKey = ''; renderTranscript(); updateControls();
    }));
    article.append(actions); return article;
  }
  function renderTranscript() {
    const container = $('conversation');
    const pane = $('reading-pane');
    const scrollTop = pane.scrollTop;
    const focusKey = element => element?.dataset?.transcriptFocus;
    const focusedControl = focusKey(document.activeElement);
    const menuReturn = focusKey(focusBeforeDialog.get($('message-dialog')));
    const expanded = new Set([...container.querySelectorAll('[data-response-details]')]
      .filter(element => element.open).map(element => element.dataset.responseDetails));
    container.replaceChildren(node('div', 'story-prologue', 'A story in the making'));
    const messages = (state.story.branch.messages || []).filter(message => !message.internal);
    const groups = new Map(), grouped = new Set(), hiddenOnlyGroups = new Map();
    // Presentation records refer to canonical originals. Their final checkpoint
    // may be internal, so place each group at its last visible contribution.
    for (const response of state.story.branch.responses || []) {
      const sourceIds = new Set(response.sourceMessageIds || []);
      const originals = messages.filter(message => message.role !== 'player' && sourceIds.has(message.id) && !grouped.has(message.id));
      if (!response.text) continue;
      const group = { response, originals, sourceIds };
      if (originals.length) groups.set(originals.at(-1).id, group);
      else {
        // The server supplies the preceding visible canonical boundary for a
        // response whose only source is a hidden checkpoint. Array order keeps
        // consecutive quiet responses at that same boundary chronological.
        const after = response.afterMessageId ?? null;
        if (!hiddenOnlyGroups.has(after)) hiddenOnlyGroups.set(after, []);
        hiddenOnlyGroups.get(after).push(group);
      }
      originals.forEach(message => grouped.add(message.id));
    }
    function appendGroup({ response, originals, sourceIds }) {
      const article = renderPassage({ ...response, role: 'narrator', speaker: 'Story' }, true);
      article.dataset.responseId = response.id;
      if (originals.length) {
        const details = node('details', 'response-originals');
        details.dataset.responseDetails = response.id;
        details.open = expanded.has(response.id);
        const summary = node('summary', '', `Original contributions (${originals.length})`);
        summary.dataset.transcriptFocus = `details:${response.id}`;
        details.append(summary, node('p', 'originals-hint', 'Copy, edit, delete or continue from an individual contribution.'));
        const list = node('div', 'response-contributions');
        originals.forEach(original => list.append(renderPassage(original)));
        details.append(list);
        article.append(details);
      }
      appendPassageImages(article, image => sourceIds.has(image.anchorMessageId));
      container.append(article);
    }
    function appendHiddenGroups(after) {
      for (const group of hiddenOnlyGroups.get(after) || []) appendGroup(group);
    }
    if (!messages.length && !hiddenOnlyGroups.size) container.append(node('p', 'empty-note', 'The page is yours. Write a beginning, or choose Continue to let the narrator open the story.'));
    appendHiddenGroups(null);
    for (const message of messages) {
      const group = groups.get(message.id);
      if (group) appendGroup(group);
      else if (!grouped.has(message.id)) {
        const article = renderPassage(message);
        appendPassageImages(article, image => image.anchorMessageId === message.id);
        container.append(article);
      }
      appendHiddenGroups(message.id);
    }
    for (const item of branchSubmissions()) container.append(renderSubmission(item));
    updateMessageControls();
    const controls = [...container.querySelectorAll('[data-transcript-focus]')];
    if (menuReturn) {
      const replacement = controls.find(element => focusKey(element) === menuReturn);
      if (replacement) focusBeforeDialog.set($('message-dialog'), replacement);
    }
    if (focusedControl && !document.querySelector('dialog[open]')) {
      controls.find(element => focusKey(element) === focusedControl)?.focus({ preventScroll: true });
    }
    pane.scrollTop = scrollTop;
  }
  function renderPassage(message, combined = false) {
    const article = node('article', combined ? 'message combined-response' : 'message');
    article.dataset.role = message.role;
    if (!combined) article.dataset.messageId = message.id;
    const header = node('div', 'message-header');
    const dot = node('span', 'speaker-dot'); dot.setAttribute('aria-hidden', 'true');
    const name = message.speaker || (message.role === 'player' ? 'You' : 'Narrator');
    const menu = button('···', 'icon-button message-menu', () => combined ? openResponseMenu(message.id) : openMessageMenu(message.id));
    menu.setAttribute('aria-label', combined ? 'Options for the combined story passage' : `Options for ${name}’s passage`);
    menu.setAttribute('aria-haspopup', 'dialog');
    menu.dataset.transcriptFocus = `${combined ? 'response' : 'message'}:${message.id}`;
    if (!combined) menu.dataset.messageAction = message.id;
    const time = node('time', 'message-time', dateLabel(message.createdAt, true));
    if (Number.isFinite(Date.parse(message.createdAt))) time.dateTime = message.createdAt;
    header.append(dot, node('span', 'speaker-name', name), time, menu);
    article.append(header, node('div', 'message-text', message.text));
    return article;
  }
  function appendPassageImages(article, matches) {
    const images = (state.story.branch.illustrations || []).filter(matches);
    if (!images.length) return;
    const row = node('div', 'message-images');
    for (const record of images) {
      const card = button('', 'message-image', () => openImage(record.id));
      card.setAttribute('aria-label', `View illustration: ${record.caption || 'Story moment'}`);
      card.dataset.transcriptFocus = `image:${record.id}`;
      card.append(makeImage(record), node('span', '', record.caption || 'A moment, illustrated'));
      row.append(card);
    }
    article.append(row);
  }
  function updateMessageControls() {
    // Copy remains available during generation; mutating options are gated in the menu.
    $('conversation').querySelectorAll('.message-menu').forEach((element) => { element.disabled = state.selecting; });
  }
  function scrollToBottom() {
    requestAnimationFrame(() => {
      $('reading-pane').scrollTop = $('reading-pane').scrollHeight;
      state.nearBottom = true;
      hide('jump-latest');
    });
  }
  $('reading-pane').addEventListener('scroll', () => {
    const pane = $('reading-pane');
    state.nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 160;
    hide('jump-latest', state.nearBottom || !state.story);
  }, { passive: true });
  $('jump-latest').addEventListener('click', scrollToBottom);
  $('conversation').addEventListener('load', (event) => {
    if (event.target.tagName === 'IMG' && state.nearBottom) scrollToBottom();
  }, true);

  function narratorContextUsage(story = state.story) {
    const usage=story?.contextUsage?.narrator;
    if(!usage||usage.error||!Number.isInteger(usage.tokens)||usage.tokens<0||!Number.isInteger(usage.threshold)||usage.threshold<=0) {
      const detail=usage?.error?` ${String(usage.error)}`:'';
      return {text:'Context count unavailable',label:'Narrator context count unavailable',title:`The server has not provided a current narrator context estimate.${detail}`};
    }
    const tokens=usage.tokens.toLocaleString(),threshold=usage.threshold.toLocaleString();
    return {text:`Narrator context ${usage.approximate===false?'':'~'}${tokens} / ${threshold} tokens`,label:`Narrator context: ${usage.approximate===false?'':'approximately '}${tokens} tokens; compaction threshold ${threshold} tokens.`,title:`${usage.approximate===false?'Counted':'Estimated'} with ${usage.encoding||'the server tokenizer'}. Each narrator and character compacts independently at the configured token threshold. Older records remain available for rewind.`};
  }
  function renderContextUsage() {
    const usage=narratorContextUsage();
    for(const id of ['context-status','inspector-context-status']) {
      const field=$(id);field.textContent=usage.text;field.title=usage.title;field.setAttribute('aria-label',usage.label);
    }
  }
  function updateControls() {
    const story = state.story;
    const busy = Boolean(story?.busy || (state.operation?.generating && state.operation.id === story?.id));
    const isLocked = locked();
    $('new-story').disabled = Boolean(state.operation || state.selecting || state.setupLoading);
    $('welcome-start').disabled = !state.booted || Boolean(state.operation || state.selecting);
    $('import-story').disabled = !state.booted || Boolean(state.operation || state.selecting || state.setupLoading);
    $('send-message').disabled = !story || isLocked || !$('composer').value.trim();
    $('continue').disabled = !story || isLocked;
    $('regenerate').disabled = !story || isLocked || !regenerationBoundary();
    $('open-branches').disabled = !story || isLocked;
    $('open-story-menu').disabled = !story || isLocked;
    $('illustrate-latest').disabled = !story || isLocked || imageActive();
    $('rewind-start').disabled = !story || isLocked;
    hide('generation-status', !busy);
    $('generation-stage').textContent = story?.stage || (state.operation?.stopping ? 'Stopping at a safe boundary…' : 'Preparing the next passage…');
    $('stop-generation').disabled = Boolean(state.operation?.stopping);
    const job = story?.illustrationJob;
    hide('image-status', !job || (!imageActive() && !['failed', 'error'].includes(job.status)));
    if (job) $('image-status').textContent = imageActive() ? '◦ The illustrator is working in the background. You can keep writing.'
      : `Illustration could not be completed: ${job.error || 'Check the proxy connection and try again from the gallery.'}`;
    $('save-status').textContent = state.selecting ? 'Opening story…' : activeSubmission() ? 'Submitted passage not yet saved'
      : state.operation ? 'Working…'
      : story?.busy ? 'Generating…' : story ? `Saved locally${dateLabel(story.updatedAt, true) ? ` · ${dateLabel(story.updatedAt, true)}` : ''}` : '';
    renderContextUsage();
    updateMessageControls();
    if ($('branches-dialog').open) {
      $('branch-list').querySelectorAll('button').forEach((control) => { control.disabled = isLocked; });
    }
    if ($('message-dialog').open) updateMenuControls();
  }

  function stopPolling() {
    state.pollToken++;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.pollController?.abort();
    state.pollController = null;
  }
  function shouldPoll() {
    return state.story && !state.selecting && (state.story.busy || imageActive()
      || activeSubmission() || (state.operation?.id === state.story.id && state.operation.generating));
  }
  function schedulePolling(delay = 1100) {
    stopPolling();
    if (!shouldPoll()) return;
    const token = state.pollToken;
    const id = state.story.id;
    const poll = async () => {
      if (token !== state.pollToken || !shouldPoll() || state.story?.id !== id) return;
      const controller = new AbortController();
      state.pollController = controller;
      try {
        const result = await api(storyPath(id), { signal: controller.signal });
        if (token !== state.pollToken || state.story?.id !== id) return;
        applyStory(result);
        if (state.operation) $('save-status').textContent = 'Working…';
        if (shouldPoll()) state.pollTimer = setTimeout(poll, document.hidden ? 4000 : 1300);
      } catch (error) {
        if (error.name === 'AbortError' || token !== state.pollToken) return;
        $('save-status').textContent = 'Status connection interrupted · retrying';
        if (shouldPoll()) state.pollTimer = setTimeout(poll, 5000);
      }
    };
    state.pollTimer = setTimeout(poll, delay);
  }

  async function mutateStory(suffix, body = {}, { generating = false, errorId, onSuccess, submission } = {}) {
    if (!state.story || locked()) return false;
    const id = state.story.id;
    const expectedVersion = state.story.version;
    const controller = new AbortController();
    state.operation = { id, controller, generating, stopping: false, submission };
    if (submission) {
      state.submissions[id] = (state.submissions[id] || []).filter(item => !(item.branchId === submission.branchId && item.status === 'failed' && item.draft === submission.draft));
      state.submissions[id].push(submission); saveSubmissions(id);
      $('composer').value = ''; persistComposer(); resizeComposer(); renderTranscript(); scrollToBottom();
    }
    if (errorId) inlineError(errorId, null);
    clearError(); updateControls(); renderLibrary(); schedulePolling();
    let succeeded = false;
    try {
      const result = await api(storyPath(id, suffix), { method: 'POST',
        body: { ...body, expectedVersion }, signal: controller.signal });
      stopPolling();
      if (state.story?.id === id) { reconcileSubmissions(result, true); applyStory(result); }
      succeeded = true;
      if (onSuccess) onSuccess(result);
    } catch (error) {
      if (error.name === 'AbortError') toast('Generation stopped. Completed history is preserved.');
      else if (errorId) inlineError(errorId, error);
      else showError(error);
      // Reconcile errors and conflicts with the authoritative story. Never retry a turn automatically.
      try {
        const latest = await api(storyPath(id));
        if (state.story?.id === id) {
          reconcileSubmissions(latest, true); applyStory(latest);
          if (submission && !state.submissions[id].includes(submission)) succeeded = true;
        }
      } catch {
        if (submission && state.submissions[id]?.includes(submission)) {
          submission.status = 'checking';
          submission.reason = 'Connection interrupted. Checking whether the server saved this passage before allowing another send.';
          saveSubmissions(id);
        }
      }
    } finally {
      state.operation = null;
      if (submission && state.story?.id === id) { state.transcriptKey = ''; renderTranscript(); }
      updateControls(); renderLibrary(); schedulePolling();
      if (succeeded) refreshLibrary();
    }
    return succeeded;
  }
  $('stop-generation').addEventListener('click', async () => {
    if (!state.story || state.operation?.stopping) return;
    const id = state.story.id;
    const operation = state.operation;
    if (operation) operation.stopping = true;
    $('stop-generation').disabled = true;
    $('generation-stage').textContent = 'Stopping at a safe boundary…';
    try {
      const result = await api(storyPath(id, '/cancel'), { method: 'POST', body: {} });
      if (result.cancelled) operation?.controller.abort();
      const story = await api(storyPath(id));
      if (state.story?.id === id) applyStory(story);
      schedulePolling();
      toast(result.cancelled ? 'Stop requested. Your completed history is safe.' : 'No active generation remains.');
    } catch (error) {
      if (operation) operation.stopping = false;
      showError(error);
    } finally { updateControls(); }
  });

  $('composer').addEventListener('input', () => { resizeComposer(); persistComposer(); updateControls(); });
  $('composer').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!$('send-message').disabled) $('composer-form').requestSubmit();
    }
  });
  $('composer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('composer').value.trim();
    if (!text || locked()) return;
    const messages = state.story.branch.messages || [];
    const token = globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const submission = { token, storyId: state.story.id, branchId: state.story.activeBranchId,
      expectedVersion: state.story.version, anchorMessageId: messages.at(-1)?.id ?? null,
      priorMessageIds: messages.map(message => message.id), text, draft: $('composer').value, status: 'sending' };
    await mutateStory('/turn', { text }, { generating: true, submission, onSuccess: scrollToBottom });
  });
  $('continue').addEventListener('click', () => mutateStory('/continue', {}, { generating: true, onSuccess: scrollToBottom }));
  $('syntax-help').addEventListener('click', () => {
    const show = $('syntax-note').hidden;
    hide('syntax-note', !show);
    $('syntax-help').setAttribute('aria-expanded', String(show));
  });
  function regenerationBoundary() {
    const messages = (state.story?.branch.messages || []).filter(message => !message.internal);
    const responses = state.story?.branch.responses || [];
    if (!responses.length && !messages.some((message) => message.role !== 'player')) return null;
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== 'player') index--;
    const playerBoundary = index >= 0 ? messages[index].id : null;
    if (index === messages.length - 1 && !responses.some(response => response.afterMessageId === playerBoundary)) return null;
    return { messageId: index >= 0 ? messages[index].id : undefined };
  }
  $('regenerate').addEventListener('click', () => {
    const boundary = regenerationBoundary();
    if (boundary) openRevision('regenerate', boundary.messageId);
  });

  function openMessageMenu(id) {
    state.message = state.story?.branch.messages.find((message) => message.id === id && !message.internal);
    if (!state.message) return;
    $('message-menu-title').textContent = `${state.message.speaker || 'Passage'} · Options`;
    updateMenuControls();
    openDialog('message-dialog');
  }
  function openResponseMenu(id) {
    const response = state.story?.branch.responses?.find(item => item.id === id);
    if (!response) return;
    state.message = { ...response, id: response.anchorMessageId, combined: true };
    $('message-menu-title').textContent = 'Story passage · Options';
    updateMenuControls();
    openDialog('message-dialog');
  }
  function updateMenuControls() {
    const combined = Boolean(state.message?.combined);
    // Edits and deletions must keep each author's canonical boundary intact.
    ['edit-message', 'delete-message', 'illustrate-message'].forEach(id => hide(id, combined));
    $('copy-message').textContent = combined ? 'Copy passage ↗' : 'Copy text ↗';
    ['edit-message', 'delete-message', 'rewind-message'].forEach((id) => { $(id).disabled = locked(); });
    $('illustrate-message').disabled = locked() || imageActive();
  }
  $('copy-message').addEventListener('click', async () => {
    if (!state.message) return;
    const text = state.message.text;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('Clipboard unavailable');
      closeDialog('message-dialog'); toast('Passage copied.');
    } catch {
      // Clipboard APIs may be unavailable on an Android LAN HTTP origin.
      const field = node('textarea', 'copy-fallback');
      field.value = text; field.setAttribute('aria-label', 'Text to copy');
      $('message-dialog').append(field); field.focus(); field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Leave the selected text for manual copying. */ }
      if (copied) { field.remove(); closeDialog('message-dialog'); toast('Passage copied.'); }
      else { toast('Clipboard access is unavailable. Select and copy the text below.'); }
    }
  });
  $('edit-message').addEventListener('click', () => { if (!state.message?.combined) openRevision('edit', state.message?.id); });
  $('delete-message').addEventListener('click', () => { if (!state.message?.combined) openRevision('delete', state.message?.id); });
  $('rewind-message').addEventListener('click', () => openRevision('rewind', state.message?.id));
  $('illustrate-message').addEventListener('click', () => {
    if (state.message?.combined) return;
    const messageId = state.message?.id;
    closeDialog('message-dialog');
    mutateStory('/illustrate', { messageId }, { onSuccess: () => toast('Illustration requested. You can keep writing.') });
  });

  function openRevision(mode, messageId) {
    if (locked()) return;
    const message = state.story?.branch.messages.find((item) => item.id === messageId);
    const draftKey = `revision-draft:${state.story.id}:${state.story.activeBranchId}:${messageId}`;
    state.revision = { mode, messageId, draftKey, storyId: state.story.id, branchId: state.story.activeBranchId };
    const descriptions = {
      edit: ['Edit passage', 'Revise this passage in a new branch. The revised text is kept as you write it; a fresh AI continuation follows.', 'Save & continue'],
      delete: ['Delete passage', 'Remove this passage in a new branch, restore the world to the preceding boundary, and generate a fresh continuation.', 'Delete & continue'],
      rewind: ['Continue from here', messageId ? 'Keep this passage and everything before it. A new branch opens at this exact point, ready for your next choice.' : 'Open a new branch at the original setup, before the first passage. Your existing story stays available.', 'Create branch'],
      regenerate: ['A different continuation', 'Return to your last player message and generate a fresh AI continuation. The previous version stays available in its own branch.', 'Regenerate'],
    };
    const [title, description, action] = descriptions[mode];
    $('revision-title').textContent = title;
    $('revision-description').textContent = description;
    $('confirm-revision').textContent = action;
    $('revision-text').value = mode === 'edit' ? storage.get(draftKey) ?? message?.text ?? '' : message?.text || '';
    $('revision-text').required = mode === 'edit';
    hide('revision-label', mode !== 'edit');
    inlineError('revision-error', null);
    if ($('message-dialog').open) closeDialog('message-dialog');
    if ($('branches-dialog').open) closeDialog('branches-dialog');
    openDialog('revision-dialog', mode === 'edit' ? 'revision-text' : 'confirm-revision');
  }
  $('revision-text').addEventListener('input', () => {
    if (state.revision?.mode === 'edit') storage.set(state.revision.draftKey, $('revision-text').value);
  });
  $('revision-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const revision = state.revision;
    if (!revision || locked()) return;
    const body = { mode: revision.mode === 'regenerate' ? 'rewind' : revision.mode };
    if (revision.messageId) body.messageId = revision.messageId;
    if (revision.mode === 'edit') { body.text = $('revision-text').value; storage.set(revision.draftKey, body.text); }
    if (revision.mode === 'regenerate') body.regenerate = true;
    else if (revision.mode === 'rewind') body.regenerate = false;
    $('confirm-revision').disabled = true;
    // The long-running revision progresses in the main chat, where Stop remains accessible.
    closeDialog('revision-dialog');
    const success = await mutateStory('/branch', body, { generating: revision.mode !== 'rewind',
      onSuccess: () => { toast('New branch saved. The original future is in Branches.'); scrollToBottom(); } });
    $('confirm-revision').disabled = false;
    if (success && revision.mode === 'edit') storage.remove(revision.draftKey);
    if (!success && !state.story?.busy) {
      if (revision.mode === 'edit' && state.story?.id === revision.storyId && state.story.activeBranchId === revision.branchId) openRevision('edit', revision.messageId);
      toast('Revision did not complete. Your edit draft is preserved; check the error before retrying.');
    }
  });

  function renderBranches() {
    const list = $('branch-list'); list.replaceChildren();
    for (const branch of state.story?.branches || []) {
      const current = branch.id === state.story.activeBranchId;
      const card = button('', 'branch-card', async () => {
        if (current) return;
        await mutateStory('/switch', { branchId: branch.id }, { onSuccess: () => {
          closeDialog('branches-dialog'); toast(`Switched to ${branch.name}.`);
        } });
      });
      card.setAttribute('aria-current', String(current));
      card.disabled = locked();
      const description = node('span');
      description.append(node('strong', '', branch.name || 'Story branch'),
        node('small', '', `${branch.messageCount || 0} passages · ${dateLabel(branch.createdAt, true)}${branch.parentId ? ' · Revised history' : ' · Original history'}`));
      card.append(description, node('span', '', current ? 'Reading' : 'Open →'));
      list.append(card);
    }
  }
  $('open-branches').addEventListener('click', () => { renderBranches(); openDialog('branches-dialog'); });
  $('rewind-start').addEventListener('click', () => openRevision('rewind'));

  function renderGallery() {
    const grid = $('gallery-grid'); grid.replaceChildren();
    const images = state.story?.branch.illustrations || [];
    for (const record of images) {
      const card = button('', 'gallery-card', () => openImage(record.id));
      card.append(makeImage(record), node('span', '', record.caption || 'An illustrated moment'));
      grid.append(card);
    }
    if (!images.length) grid.append(node('p', 'empty-note', 'No illustrations in this branch yet. Let the illustrator find a moment, or request one here.'));
    updateControls();
  }
  $('open-gallery').addEventListener('click', () => { renderGallery(); openDialog('gallery-dialog'); });
  $('illustrate-latest').addEventListener('click', () => mutateStory('/illustrate', {}, {
    onSuccess: () => toast('The illustrator is finding the moment. Results will appear here.'),
  }));
  function addDetail(container, label, value) {
    container.append(node('dt', '', label), node('dd', '', displayValue(value)));
  }
  function openImage(id) {
    state.imageIndex = (state.story?.branch.illustrations || []).findIndex((image) => image.id === id);
    if (state.imageIndex < 0) return;
    renderLightbox(); openDialog('lightbox-dialog');
  }
  function renderLightbox() {
    const images = state.story?.branch.illustrations || [];
    const record = images[state.imageIndex];
    if (!record) { closeDialog('lightbox-dialog'); return; }
    const image = $('lightbox-image');
    image.removeAttribute('src');
    const url = safeImageUrl(record.url);
    image.alt = record.caption || 'Story illustration';
    if (url) image.src = url;
    else image.alt = 'Illustration unavailable: invalid or external image address';
    $('lightbox-title').textContent = `Illustration ${state.imageIndex + 1}`;
    $('lightbox-caption').textContent = record.caption || 'An illustrated moment';
    $('image-position').textContent = `${state.imageIndex + 1} / ${images.length}`;
    $('previous-image').disabled = state.imageIndex === 0;
    $('next-image').disabled = state.imageIndex === images.length - 1;
    const details = $('image-details'); details.replaceChildren();
    addDetail(details, 'Prompt', record.prompt);
    const references = (record.referenceIds || []).map((id) => {
      const reference = images.find((item) => item.id === id);
      return reference ? reference.caption || reference.id : id;
    });
    addDetail(details, 'Visual references', references.length ? references : 'Initial illustration · no references');
    if (record.appearanceNotes) addDetail(details, 'Appearance notes', record.appearanceNotes);
    addDetail(details, 'Created', dateLabel(record.createdAt, true));
    addDetail(details, 'Story anchor', record.anchorMessageId);
  }
  function stepImage(delta) {
    const next = state.imageIndex + delta;
    if (next < 0 || next >= (state.story?.branch.illustrations.length || 0)) return;
    state.imageIndex = next; renderLightbox();
  }
  $('previous-image').addEventListener('click', () => stepImage(-1));
  $('next-image').addEventListener('click', () => stepImage(1));
  $('lightbox-dialog').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); stepImage(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); stepImage(1); }
  });
  $('lightbox-image').addEventListener('error', () => { $('lightbox-image').alt = 'Illustration unavailable. The image file could not be loaded.'; });

  function inspectorCard(title, text, meta) {
    const card = node('article', 'inspector-card');
    card.append(node('h3', '', title), node('p', '', text));
    if (meta) card.append(node('small', '', meta));
    return card;
  }
  function renderInspector() {
    renderContextUsage();
    const simple = state.story?.setup?.mode === 'simple';
    $('inspector-description').textContent = simple ? 'A reader’s view of the active branch. One narrator carries the story and its cast.' : 'A reader’s view of the active branch. Characters only receive their own permitted knowledge.';
    hide('tab-knowledge', simple); hide('tab-public', simple);
    if (simple) selectInspectorTab('presence');
    const world = state.story?.world || {};
    const characters = world.characters || [];
    const summary = $('world-summary'); summary.replaceChildren();
    summary.append(node('span', '', world.location || 'Location not established'),
      node('small', '', `${world.timeLabel || 'Story time'} · ${world.time ?? 0} fictional minutes`));
    const presence = $('panel-presence'), knowledge = $('panel-knowledge'), publications = $('panel-public');
    presence.replaceChildren(); knowledge.replaceChildren(); publications.replaceChildren();
    for (const character of characters) {
      const card = inspectorCard(character.name || character.id, character.location || 'Whereabouts not established',
        character.id === 'player' ? 'Your persona' : character.location === world.location ? 'At the current location · perception depends on the event' : 'Elsewhere');
      if (character.description) card.append(node('p', '', character.description));
      if (simple) {
        if (character.appearance) card.append(node('p', '', character.appearance));
        presence.append(card); continue;
      }
      if(character.id!=='player'){
        const prompt=node('details');prompt.append(node('summary','','Character system prompt'));
        prompt.append(node('p','',character.systemPrompt||'Uses the shared character system prompt with no individual additions.'));
        const editPrompt=button('Edit character prompt','secondary',()=>openCharacterPrompt(character.id));editPrompt.disabled=locked();prompt.append(editPrompt);card.append(prompt);
      }
      const visual=node('details');visual.append(node('summary','','Appearance'));
      if(character.visual?.canSee===false)visual.append(node('p','','Currently unable to see · uses previously learned appearance details.'));
      const facts=character.visual?.facts || [];
      for(const fact of facts){
        const detail=node('div','appearance-fact');
        detail.append(node('strong','',`${fact.key} · ${fact.layer==='physical'?'Physical feature':'Current presentation'}`),node('p','',fact.text));
        detail.append(node('small','',fact.visible?`Visible: ${fact.visible}`:'Concealed / not currently visible'));
        if(fact.source)detail.append(node('small','',`Source: ${fact.source.excerpt||fact.source.id||displayValue(fact.source)}`));
        visual.append(detail);
      }
      if(!facts.length)visual.append(node('p','',character.appearance||'No visual details recorded yet.'));
      const editVisual=button('Correct appearance','secondary',()=>openAppearanceEditor(character.id));editVisual.disabled=locked();visual.append(editVisual);card.append(visual);
      presence.append(card);
      const entry = node('details', 'inspector-card');
      entry.append(node('summary', '', `${character.name || character.id} · ${(character.knowledge || []).length} observations`));
      for (const fact of character.knowledge || []) {
        const item = node('div', 'knowledge-entry');
        item.append(node('p', '', fact.text), node('small', '', `Source: ${displayValue(fact.source)} · Learned at ${displayValue(fact.time)}${fact.eventId ? ` · Event ${fact.eventId}` : ''}`));
        entry.append(item);
      }
      if (!character.knowledge?.length) entry.append(node('p', '', 'No story observations recorded yet.'));
      if (character.privateState) {
        const privateDetails = node('details');
        privateDetails.append(node('summary', '', 'Private state · reader only'), node('p', '', character.privateState));
        entry.append(privateDetails);
      }
      if (character.memory?.summary) {
        const memory = node('details'); memory.append(node('summary', '', `Continuity summary · first ${character.memory.through} observations`), node('p', '', character.memory.summary)); entry.append(memory);
      }
      if(Object.keys(character.seenAppearance||{}).length){
        const seen=node('details');seen.append(node('summary','','Remembered appearances'));
        for(const [subjectId,view] of Object.entries(character.seenAppearance)){
          const item=node('div','knowledge-entry');
          item.append(node('h3','',view.name||characters.find(c=>c.id===subjectId)?.name||subjectId));
          for(const fact of view.facts||[])item.append(node('p','',`${fact.key}: ${fact.text}`));
          item.append(node('small','',`Last encounter: ${displayValue(view.time)} · ${displayValue(view.location)}`));seen.append(item);
        }
        entry.append(seen);
      }
      if (character.online) entry.append(node('small', '', `Online access: ${character.online.access ? 'yes' : 'no'} · Interests: ${displayValue(character.online.interests)} · Connections: ${displayValue(character.online.connections)}`));
      knowledge.append(entry);
    }
    if (!characters.length) {
      presence.append(node('p', 'empty-note', 'No whereabouts recorded yet.'));
      knowledge.append(node('p', 'empty-note', 'Knowledge will appear as the story unfolds.'));
    }
    const recentEvents = (world.events || []).slice(-30).reverse();
    if (recentEvents.length) {
      const events = node('details', 'inspector-card');
      events.append(node('summary', '', 'Recent events & transitions'));
      for (const event of recentEvents) {
        const item = node('div', 'knowledge-entry');
        item.append(node('p', '', event.text || event.description || event.type || 'Story event'));
        const details = node('dl', 'detail-list');
        for (const [key, value] of Object.entries(event)) {
          if (!['text', 'description', 'id'].includes(key)) addDetail(details, key, value);
        }
        item.append(details); events.append(item);
      }
      presence.append(events);
    }
    if (world.sharedBackground?.length) publications.append(inspectorCard('Shared setting knowledge', world.sharedBackground.join('\n\n')));
    for (const publication of world.publications || []) {
      const entry = inspectorCard(publication.title || publication.type || 'Public information',
        publication.text || publication.content || publication.description || 'Published information');
      const details = node('dl', 'detail-list');
      for (const [key, value] of Object.entries(publication)) {
        if (!['text', 'content', 'description', 'title'].includes(key)) addDetail(details, key, value);
      }
      entry.append(details); publications.append(entry);
    }
    if (!world.publications?.length) publications.append(node('p', 'empty-note', 'Nothing has been published in this branch. Public availability does not automatically mean a character has seen it.'));
    const decisions = Object.entries(world.exposureDecisions || {});
    if (decisions.length) {
      const section = node('details', 'inspector-card');
      section.append(node('summary', '', 'Resolved exposure decisions'));
      const list = node('dl', 'detail-list');
      for (const [id, exposed] of decisions) addDetail(list, id, exposed ? 'Exposed' : 'Not exposed');
      section.append(list); publications.append(section);
    }
  }
  $('open-inspector').addEventListener('click', () => { renderInspector(); openDialog('inspector-dialog'); });
  function openCharacterPrompt(characterId) {
    if(!state.story||state.story.setup?.mode==='simple'||locked())return;
    const character=state.story.world.characters.find(c=>c.id===characterId&&c.id!=='player');if(!character)return;
    state.promptEditor={storyId:state.story.id,branchId:state.story.activeBranchId,characterId};
    $('character-prompt-title').textContent=`${character.name} · System prompt`;
    $('character-prompt-text').value=character.systemPrompt||'';
    inlineError('character-prompt-error',null);openDialog('character-prompt-dialog','character-prompt-text');
  }
  $('character-prompt-form').addEventListener('submit',async event=>{
    event.preventDefault();const target=state.promptEditor;
    if(!target||state.characterPromptSaving||locked())return;
    if(state.story?.id!==target.storyId||state.story.activeBranchId!==target.branchId){inlineError('character-prompt-error','The story branch changed. Reopen the prompt editor.');return;}
    const systemPrompt=$('character-prompt-text').value;
    state.characterPromptSaving=true;$('character-prompt-form').querySelectorAll('textarea,button').forEach(field=>{field.disabled=true;});
    const success=await mutateStory('/character-prompt',{characterId:target.characterId,systemPrompt},{errorId:'character-prompt-error',onSuccess:()=>toast('Character prompt saved in a new branch.')});
    state.characterPromptSaving=false;$('character-prompt-form').querySelectorAll('textarea,button').forEach(field=>{field.disabled=false;});
    if(success){closeDialog('character-prompt-dialog');closeDialog('inspector-dialog');}
  });
  function addAppearanceRow(fact={}) {
    const row=node('div','appearance-row');
    const heading=node('div','appearance-row-heading');heading.append(node('strong','','Visual detail'),button('Remove','subtle danger-text',()=>row.remove()));row.append(heading);
    const grid=node('div','form-grid');
    for(const [key,label,value] of [['key','Detail name (hair, coat, etc.)',fact.key||''],['layer','Type',fact.layer||'physical']]){
      const wrapper=node('label','',label),field=node(key==='layer'?'select':'input');field.dataset.visualField=key;
      if(key==='layer')for(const [value,text] of [['physical','Physical feature'],['presentation','Current presentation']]){const option=node('option','',text);option.value=value;field.append(option);}
      else{field.required=true;field.maxLength=80;}
      field.value=value;wrapper.append(field);grid.append(wrapper);
    }
    row.append(grid);
    for(const [key,label] of [['text','Actual description'],['visible','Visible description (empty when concealed)']]){
      const wrapper=node('label','',label),field=node('textarea');field.dataset.visualField=key;field.rows=2;field.maxLength=4000;field.required=key==='text';field.value=fact[key]||'';wrapper.append(field);row.append(wrapper);
    }
    $('appearance-rows').append(row);
  }
  function openAppearanceEditor(characterId) {
    if(!state.story||state.story.setup?.mode==='simple'||locked())return;
    const character=state.story.world.characters.find(c=>c.id===characterId);if(!character)return;
    state.visualEditor={storyId:state.story.id,branchId:state.story.activeBranchId,characterId};
    $('appearance-title').textContent=`${character.name} · Appearance`;$('appearance-rows').replaceChildren();
    $('appearance-can-see').checked=character.visual?.canSee!==false;
    for(const fact of character.visual?.facts||[])addAppearanceRow(fact);
    if(!$('appearance-rows').childElementCount)addAppearanceRow();
    inlineError('appearance-error',null);openDialog('appearance-dialog');
  }
  $('add-appearance-detail').addEventListener('click',()=>{if(!state.appearanceSaving)addAppearanceRow();});
  $('appearance-form').addEventListener('submit',async event=>{
    event.preventDefault();const target=state.visualEditor;
    if(!target||state.appearanceSaving||locked())return;
    if(state.story?.id!==target.storyId||state.story.activeBranchId!==target.branchId){inlineError('appearance-error','The story branch changed. Reopen the appearance editor.');return;}
    const facts=[...$('appearance-rows').children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-visual-field]')].map(field=>[field.dataset.visualField,field.value.trim()])));
    state.appearanceSaving=true;$('appearance-form').querySelectorAll('input,textarea,select,button').forEach(field=>{field.disabled=true;});
    const success=await mutateStory('/appearance',{characterId:target.characterId,facts,canSee:$('appearance-can-see').checked},{errorId:'appearance-error',onSuccess:()=>toast('Appearance corrected in a new branch.')});
    state.appearanceSaving=false;$('appearance-form').querySelectorAll('input,textarea,select,button').forEach(field=>{field.disabled=false;});
    if(success){closeDialog('appearance-dialog');closeDialog('inspector-dialog');}
  });
  const tabs = ['presence', 'knowledge', 'public'];
  function selectInspectorTab(name, focus = false) {
    for (const tab of tabs) {
      const selected = tab === name;
      $(`tab-${tab}`).setAttribute('aria-selected', String(selected));
      $(`tab-${tab}`).tabIndex = selected ? 0 : -1;
      hide(`panel-${tab}`, !selected);
    }
    if (focus) $(`tab-${name}`).focus();
  }
  tabs.forEach((name, index) => {
    $(`tab-${name}`).addEventListener('click', () => selectInspectorTab(name));
    $(`tab-${name}`).addEventListener('keydown', (event) => {
      const available = tabs.filter(tab => !$(`tab-${tab}`).hidden);
      const current = available.indexOf(name);
      let next;
      if (event.key === 'ArrowRight') next = (current + 1) % available.length;
      if (event.key === 'ArrowLeft') next = (current + available.length - 1) % available.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = available.length - 1;
      if (next !== undefined) { event.preventDefault(); selectInspectorTab(available[next], true); }
    });
  });

  function addCharacter(character = {}) {
    const card = node('section', 'cast-card');
    if (character.online) card.castOnline = structuredClone(character.online);
    const heading = node('div', 'cast-card-heading');
    heading.append(node('span', '', 'A CHARACTER'), button('Remove', 'subtle danger-text', () => {
      card.remove(); storage.set('setup-draft', JSON.stringify(collectSetup()));
    }));
    card.append(heading);
    for (const [key, label, multiline] of [
      ['name', 'Name', false], ['description', 'Background', true], ['appearance', 'Appearance', false],
      ['personality', 'Personality', false], ['goals', 'Goals & motivations', false], ['location', 'Starting location', false],
      ['systemPrompt','Character-specific system prompt (optional)',true],
    ]) {
      const wrapper = node('label', key === 'systemPrompt' ? 'detailed-only' : '', label);
      const field = node(multiline ? 'textarea' : 'input');
      field.dataset.castField = key; field.value = character[key] || '';
      if (multiline) field.rows = 2;
      if(key==='systemPrompt'){field.rows=4;field.maxLength=60000;field.placeholder='Voice, habits, portrayal rules… Added to the shared character prompt.';}
      if (key === 'name') { field.required = true; field.maxLength = 120; }
      wrapper.append(field); card.append(wrapper);
    }
    const habits = node('details', 'detailed-only'); habits.append(node('summary', '', 'Internet & information habits'));
    const access = node('label', 'check-label'); const checkbox = node('input'); checkbox.type = 'checkbox';
    checkbox.dataset.castOnline = 'access'; checkbox.checked = character.online?.access === true;
    access.append(checkbox, document.createTextNode('Has internet access')); habits.append(access);
    for (const [key, label] of [['interests', 'Interests / communities (comma separated)'], ['connections', 'Followed character names (comma separated)']]) {
      const wrapper = node('label', '', label), field = node('input'); field.dataset.castOnline = key;
      field.value = (character.online?.[key] || []).join(', '); wrapper.append(field); habits.append(wrapper);
    }
    card.append(habits);
    $('cast-list').append(card);
    renderSetupMode();
    return card;
  }
  function renderSetupMode() {
    const simple = $('setup-mode').value === 'simple';
    $('setup-form').querySelectorAll('.detailed-only').forEach(field => { field.hidden = simple; });
  }
  function collectSetup() {
    return {
      mode: $('setup-mode').value === 'simple' ? 'simple' : 'detailed',
      title: $('setup-title').value.trim(), premise: $('setup-premise').value.trim(),
      persona: { name: $('persona-name').value.trim(), description: $('persona-description').value.trim() },
      characters: [...$('cast-list').querySelectorAll('.cast-card')].map((card) => {
        const character = {};
        if (card.castOnline) character.online = structuredClone(card.castOnline);
        card.querySelectorAll('[data-cast-field]').forEach((field) => { character[field.dataset.castField] = field.value.trim(); });
        character.online = { access: card.querySelector('[data-cast-online="access"]').checked };
        for (const key of ['interests', 'connections']) character.online[key] = card.querySelector(`[data-cast-online="${key}"]`).value.split(',').map(item => item.trim()).filter(Boolean);
        return character;
      }),
    };
  }
  function populateSetup(setup) {
    $('setup-mode').value = setup.mode === 'simple' ? 'simple' : 'detailed';
    $('setup-title').value = setup.title || '';
    $('setup-premise').value = setup.premise || '';
    $('persona-name').value = setup.persona?.name || '';
    $('persona-description').value = setup.persona?.description || '';
    $('cast-list').replaceChildren();
    for (const character of setup.characters || []) addCharacter(character);
    $('cast-list').closest('details').open = Boolean(setup.characters?.length);
    renderSetupMode();
  }
  function openSetup(setup) {
    if (state.operation || state.selecting || state.setupLoading) return;
    setDrawer(false);
    populateSetup(setup || storage.json('setup-draft') || {});
    inlineError('setup-error', null);
    hide('setup-pending');
    $('load-setup').disabled = !storage.get('saved-setup');
    openDialog('setup-dialog', 'setup-title');
  }
  $('new-story').addEventListener('click', () => openSetup());
  $('welcome-start').addEventListener('click', () => openSetup());
  $('add-character').addEventListener('click', () => {
    const card = addCharacter();
    card.querySelector('input').focus();
  });
  $('setup-form').addEventListener('input', () => storage.set('setup-draft', JSON.stringify(collectSetup())));
  $('setup-mode').addEventListener('change', () => { renderSetupMode(); storage.set('setup-draft', JSON.stringify(collectSetup())); });
  $('save-setup').addEventListener('click', () => {
    storage.set('saved-setup', JSON.stringify(collectSetup()));
    $('load-setup').disabled = false; toast('Setup saved in this browser for reuse.');
  });
  $('load-setup').addEventListener('click', () => {
    const setup = storage.json('saved-setup');
    if (setup) { populateSetup(setup); toast('Saved setup loaded. Edit any detail before beginning.'); }
  });
  $('setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.setupLoading) return;
    const setup = collectSetup();
    if (!setup.title || !setup.premise || !setup.persona.name) {
      inlineError('setup-error', 'Add a title, premise, and persona name to begin.'); return;
    }
    state.setupLoading = true;
    storage.set('setup-draft', JSON.stringify(setup));
    inlineError('setup-error', null); hide('setup-pending', false);
    $('setup-form').querySelectorAll('input,textarea,select,button').forEach((field) => { field.disabled = true; });
    $('create-story').textContent = 'Opening your story…';
    updateControls();
    try {
      const story = await api('/api/stories', { method: 'POST', body: setup });
      persistComposer(); stopPolling();
      state.selection++;
      state.transcriptKey = '';
      applyStory(story, { forceBottom: true });
      $('composer').value = ''; resizeComposer();
      storage.set('last-story', story.id);
      state.setupLoading = false;
      closeDialog('setup-dialog');
      refreshLibrary(); schedulePolling();
    } catch (error) {
      inlineError('setup-error', error);
      refreshLibrary();
    } finally {
      state.setupLoading = false;
      $('setup-form').querySelectorAll('input,textarea,select,button').forEach((field) => { field.disabled = false; });
      $('load-setup').disabled = !storage.get('saved-setup');
      hide('setup-pending'); $('create-story').textContent = 'Open the first page →';
      updateControls();
    }
  });

  function modelEfforts(model) {
    const levels=model?.supported_reasoning_efforts??model?.supported_reasoning_levels??model?.reasoning_efforts??model?.capabilities?.reasoning_efforts??model?.reasoning?.efforts;
    return Array.isArray(levels)?levels.map(level=>typeof level==='string'?level:level?.effort??level?.id).filter(level=>typeof level==='string'):null;
  }
  function populateEfforts() {
    const chat=$('setting-chatModel').value;
    for(const key of ['chatEffort','characterEffort','helperEffort','illustratorEffort']) {
      const field=$(`setting-${key}`),selected=field.value||'';
      const modelId=key==='helperEffort'?$('setting-helperModel').value||chat:chat;
      const advertised=modelEfforts(state.models.find(model=>model.id===modelId));
      const levels=advertised??['none','minimal','low','medium','high','xhigh','max','ultra'];
      field.replaceChildren();
      const defaults=node('option','','Provider default');defaults.value='';field.append(defaults);
      for(const level of [...new Set(levels)]) {
        const option=node('option','',level==='xhigh'?'Extra high':level.charAt(0).toUpperCase()+level.slice(1));option.value=level;field.append(option);
      }
      if(selected&&!levels.includes(selected)) {
        const option=node('option','',`${selected} (saved; not advertised for this model)`);option.value=selected;field.append(option);
      }
      field.value=selected;
    }
  }
  function populateModelChoices(models) {
    for(const key of ['chatModel','helperModel','imageModel']) {
      const field=$(`setting-${key}`),selected=field.value??state.settings?.[key]??'';
      field.replaceChildren();
      if(key==='helperModel'){const option=node('option','','Use narrator & character model');option.value='';field.append(option);}
      for(const model of models) {
        const option=node('option','',model.name&&model.name!==model.id?`${model.name} · ${model.id}`:model.id);option.value=model.id;field.append(option);
      }
      if(selected&&!models.some(model=>model.id===selected)) {
        const option=node('option','',`${selected} (saved; unavailable in this model list)`);option.value=selected;field.append(option);
      }
      if(!selected&&key!=='helperModel'){const option=node('option','','No model selected');option.value='';field.append(option);}
      field.value=selected;
    }
    populateEfforts();
  }
  for(const key of ['chatModel','helperModel'])$(`setting-${key}`).addEventListener('change',populateEfforts);
  function populateSettings() {
    if (!state.settings) return;
    for (const key of settingsFields) {
      const field = $(`setting-${key}`);
      if (field.type === 'checkbox') field.checked = Boolean(state.settings[key]);
      else {
        const value = state.settings[key] ?? '';
        if (field.tagName === 'SELECT' && ![...field.options].some((option) => option.value === String(value))) {
          const option = node('option', '', String(value)); option.value = String(value); field.append(option);
        }
        field.value = value;
      }
    }
    $('setting-requestTimeout').value = Math.round((state.settings.requestTimeoutMs || 180000) / 1000);
    populateModelChoices(state.models);
  }
  $('open-settings').addEventListener('click', () => {
    setDrawer(false); populateSettings(); inlineError('settings-error', null);
    $('save-settings').disabled = !state.settings;
    $('check-models').disabled = !state.settings;
    if (!state.settings) inlineError('settings-error', 'Settings are unavailable until the local server connects. Close this window and retry the library.');
    openDialog('settings-dialog');
    if(state.settings)checkModels();
  });
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.settingsLoading || !state.settings) return;
    const settings = {};
    for (const key of settingsFields) {
      const field = $(`setting-${key}`);
      settings[key] = field.type === 'checkbox' ? field.checked : numericSettings.has(key) ? Number(field.value) : field.value;
    }
    settings.requestTimeoutMs = Number($('setting-requestTimeout').value) * 1000;
    state.settingsLoading = true;
    $('save-settings').disabled = true;
    $('save-settings').textContent = 'Saving…';
    $('check-models').disabled = true;
    inlineError('settings-error', null);
    try {
      const previousProxy=state.settings.proxyBaseUrl;
      state.settings = await api('/api/settings', { method: 'PUT', body: settings });
      if(previousProxy!==state.settings.proxyBaseUrl)state.models=[];
      populateSettings(); toast('Settings saved. New generations use these prompts.');
      await checkModels();
      const storyId=state.story?.id;
      if(storyId) {
        try {const story=await api(`/api/stories/${encodeURIComponent(storyId)}`);if(state.story?.id===storyId)applyStory(story);}
        catch { /* The next story refresh will retrieve its updated context count. */ }
      }
    } catch (error) { inlineError('settings-error', error); }
    finally {
      state.settingsLoading = false;
      $('save-settings').disabled = false; $('save-settings').textContent = 'Save settings';
      $('check-models').disabled = false;
    }
  });
  async function checkModels() {
    const request=++state.modelRequest,proxyBaseUrl=state.settings?.proxyBaseUrl;
    $('check-models').disabled = true;
    $('model-result').textContent = 'Checking the saved proxy connection…';
    try {
      const result = await api('/api/models');
      if(request!==state.modelRequest||proxyBaseUrl!==state.settings?.proxyBaseUrl)return;
      state.connection = Boolean(result.connected);
      $('connection').dataset.connected = String(state.connection);
      $('connection-text').textContent = state.connection ? 'Subscription proxy connected' : 'Proxy disconnected';
      $('model-result').textContent = result.connected
        ? `Connected · ${(result.models || []).length} models available. Uses the saved connection settings.`
        : `${result.error || 'Proxy unavailable.'} Start the local proxy, sign in with your ChatGPT account, and check the saved base URL.`;
      if(result.connected){state.models=(result.models||[]).filter(model=>typeof model.id==='string');populateModelChoices(state.models);}
    } catch (error) {
      if(request!==state.modelRequest||proxyBaseUrl!==state.settings?.proxyBaseUrl)return;
      state.connection = false;
      $('connection').dataset.connected = 'false';
      $('connection-text').textContent = 'Connection unavailable';
      $('model-result').textContent = error.message;
    } finally { if(request===state.modelRequest)$('check-models').disabled = state.settingsLoading; }
  }
  $('check-models').addEventListener('click', () => {
    if (state.settings && $('setting-proxyBaseUrl').value !== state.settings.proxyBaseUrl) {
      $('model-result').textContent = 'Save the changed proxy URL first. Connection checks use the saved settings.'; return;
    }
    checkModels();
  });

  $('open-story-menu').addEventListener('click', () => openDialog('story-menu-dialog'));
  function openLibraryActions(id) {
    if(state.operation||state.selecting)return;
    const story=state.stories.find(item=>item.id===id);
    if(!story||(state.story?.id===id&&state.story.busy))return;
    state.libraryTarget={...story};
    $('library-story-title').value=story.title;
    $('archive-library-story').textContent=story.archived?'Restore to library':'Archive story';
    inlineError('library-story-error',null);setDrawer(false);
    closeDialog('story-menu-dialog');openDialog('library-story-dialog','library-story-title');
  }
  async function changeLibraryStory(change) {
    const target=state.libraryTarget;
    if(!target||state.operation||state.selecting)return;
    state.operation={id:target.id,generating:false};
    for(const id of ['rename-library-story','archive-library-story','delete-library-story'])$(id).disabled=true;
    inlineError('library-story-error',null);updateControls();renderLibrary();
    try {
      const result=await api(storyPath(target.id,'/metadata'),{method:'POST',body:{...change,expectedVersion:target.version}});
      if(state.story?.id===result.id)applyStory(result);else upsertSummary(result);
      closeDialog('library-story-dialog');toast(change.title!==undefined?'Story renamed.':change.archived?'Story archived.':'Story restored to the library.');
    }catch(error){
      inlineError('library-story-error',error);
      await refreshLibrary();
      const latest=state.stories.find(item=>item.id===target.id);
      if(latest&&state.libraryTarget?.id===target.id)state.libraryTarget={...latest};
    }finally{
      state.operation=null;for(const id of ['rename-library-story','archive-library-story','delete-library-story'])$(id).disabled=false;
      updateControls();renderLibrary();schedulePolling();
    }
  }
  $('library-story-form').addEventListener('submit',event=>{event.preventDefault();changeLibraryStory({title:$('library-story-title').value.trim()});});
  $('archive-library-story').addEventListener('click',()=>changeLibraryStory({archived:!state.libraryTarget?.archived}));
  $('delete-library-story').addEventListener('click',()=>{if(state.libraryTarget&&!state.operation)confirmDeleteStory(state.libraryTarget);});
  $('manage-current-story').addEventListener('click',()=>{if(state.story)openLibraryActions(state.story.id);});
  let debugSequence = 0;
  let debugStoryId = null;
  async function loadDebugLog() {
    const id=debugStoryId, sequence=++debugSequence;
    if(!id)return;
    $('refresh-debug').disabled=true;
    inlineError('debug-error',null);
    try {
      const response=await fetch(storyPath(id,'/debug'),{credentials:'same-origin',cache:'no-store',headers:{Accept:'text/plain'}});
      if(!response.ok)throw new Error(`Could not load AI debug log (${response.status}).`);
      const text=await response.text();
      if(sequence!==debugSequence || id!==debugStoryId)return;
      $('debug-text').value=text;
      $('copy-debug').disabled=false; $('download-debug').disabled=false;
    }catch(error){if(sequence===debugSequence)inlineError('debug-error',error);}
    finally{if(sequence===debugSequence)$('refresh-debug').disabled=false;}
  }
  $('open-debug').addEventListener('click',()=>{
    if(!state.story)return;
    debugStoryId=state.story.id;
    $('debug-text').value='';
    $('copy-debug').disabled=true; $('download-debug').disabled=true;
    closeDialog('story-menu-dialog'); openDialog('debug-dialog');
    loadDebugLog();
  });
  $('refresh-debug').addEventListener('click',loadDebugLog);
  $('copy-debug').addEventListener('click',async()=>{
    try {
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText($('debug-text').value);toast('AI debug log copied.');
    }catch{
      $('debug-text').focus();$('debug-text').select();
      let copied=false;try{copied=document.execCommand('copy');}catch{/* Select for manual copying. */}
      toast(copied?'AI debug log copied.':'Text selected. Use Copy from your browser’s selection menu.');
    }
  });
  $('download-debug').addEventListener('click',()=>{
    if(!debugStoryId)return;
    const url=URL.createObjectURL(new Blob([$('debug-text').value],{type:'text/plain;charset=utf-8'}));
    const link=node('a');link.href=url;link.download=`hearth-debug-${debugStoryId}.txt`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
    toast('AI debug log downloaded.');
  });
  $('reuse-story').addEventListener('click', () => {
    const setup = state.story?.setup;
    closeDialog('story-menu-dialog');
    if (setup) openSetup(setup);
  });
  $('export-story').addEventListener('click', async () => {
    if (!state.story) return;
    const id = state.story.id;
    const title = state.story.title;
    $('export-story').disabled = true;
    try {
      const data = await api(storyPath(id, '/export'));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = node('a'); link.href = url;
      link.download = `${String(title).replace(/[^a-z\d_-]+/gi, '-').slice(0, 80) || 'hearth-story'}.json`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      closeDialog('story-menu-dialog'); toast('Complete story export downloaded.');
    } catch (error) { showError(error); closeDialog('story-menu-dialog'); }
    finally { $('export-story').disabled = false; }
  });
  $('import-story').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0];
    $('import-file').value = '';
    if (!file || state.operation || state.selecting) return;
    if (file.size > 64 * 1024 * 1024) { showError('This export exceeds the server’s 64 MiB import limit.'); return; }
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { showError('This file is not valid story JSON. Choose a Hearth story export.'); return; }
    persistComposer(); setDrawer(false);
    state.operation = { id: null, generating: false };
    updateControls(); renderLibrary(); clearError();
    try {
      const story = await api('/api/import', { method: 'POST', body: data });
      stopPolling(); state.selection++; state.transcriptKey = '';
      applyStory(story, { forceBottom: true });
      $('composer').value = ''; resizeComposer();
      storage.set('last-story', story.id);
      toast('Story imported as a new library entry.');
    } catch (error) { showError(error); }
    finally { state.operation = null; updateControls(); renderLibrary(); schedulePolling(); }
  });
  function confirmDeleteStory(story) {
    if(!story||state.operation||state.selecting||(state.story?.id===story.id&&state.story.busy))return;
    $('confirm-title').textContent = 'Delete this story?';
    $('confirm-description').textContent = `“${story.title}” and all its branches will be removed from this server. Export it first if you want to keep a copy.`;
    inlineError('confirm-error', null);
    state.confirmAction = async () => {
      if (state.operation) return;
      state.operation = { id: story.id, generating: false };
      updateControls(); renderLibrary();
      try { await api(storyPath(story.id), { method: 'DELETE' }); }
      catch (error) {
        state.operation = null; updateControls(); renderLibrary(); throw error;
      }
      state.stories = state.stories.filter((item) => item.id !== story.id);
      if(state.story?.id===story.id){
        stopPolling();state.selection++;state.story=null;state.transcriptKey='';
        storage.remove('last-story');
        $('conversation').replaceChildren();$('composer').value='';
        $('story-title').textContent='Make yourself at home.';$('header-kicker').textContent='A PLACE FOR STORIES';
        document.title='Hearth · A place for stories';
        hide('story-tools');hide('writing-area');hide('conversation');hide('welcome',false);hide('jump-latest');
      }
      state.operation=null;storage.remove(`draft:${story.id}`);
      clearError();renderLibrary();updateControls();schedulePolling();
      closeDialog('confirm-dialog'); toast('Story removed from your library.');
    };
    closeDialog('story-menu-dialog');closeDialog('library-story-dialog');openDialog('confirm-dialog');
  }
  $('remove-story').addEventListener('click',()=>{if(state.story&&!locked())confirmDeleteStory(state.story);});
  $('confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.confirmAction || $('confirm-action').disabled) return;
    $('confirm-action').disabled = true;
    inlineError('confirm-error', null);
    try { await state.confirmAction(); }
    catch (error) { inlineError('confirm-error', error); }
    finally { $('confirm-action').disabled = false; }
  });
  $('dismiss-error').addEventListener('click', clearError);
  $('retry-load').addEventListener('click', () => {
    if (!state.booted) bootstrap();
    else if (state.failedSelection) selectStory(state.failedSelection);
    else if (state.story) selectStory(state.story.id);
    else bootstrap();
  });
  window.addEventListener('pagehide', () => { persistComposer(); stopPolling(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) schedulePolling(); });

  async function bootstrap() {
    clearError(); $('retry-load').disabled = true;
    try {
      const data = await api('/api/bootstrap');
      state.settings = data.settings;
      state.stories = data.stories || [];
      state.booted = true;
      $('app-version').textContent = data.version || '1.3.0';
      populateSettings(); renderLibrary(); updateControls();
      const lastId = storage.get('last-story');
      if (lastId && state.stories.some((story) => story.id === lastId)) await selectStory(lastId);
      checkModels();
    } catch (error) {
      showError(error, true);
      $('story-list').replaceChildren(node('p', 'library-note muted', 'Your library is unavailable. Reconnect to the local server and retry.'));
      updateControls();
    } finally { $('retry-load').disabled = false; }
  }
  bootstrap();
})();
