import type { ReaderAssets, ReaderMessage } from './albums.js';

// Shared by the initial HTML and lazy-loaded days. This file has no runtime imports;
// its compiled functions are embedded in the offline reader as well as run on Node.
export function readerEscape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export function readerKind(filename: string): 'photo' | 'video' | undefined {
  const ext = filename.split('.').at(-1)?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'photo';
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) return 'video';
}
export function readerPath(filename: string): string { return filename.split('/').map(encodeURIComponent).join('/'); }
export function readerColor(name: string): string {
  let hash = 0; for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 65%, 45%)`;
}
export function readerTime(date: Date | string, assets: ReaderAssets): string {
  return new Date(date).toLocaleTimeString([], { timeZone: assets.timeZone ?? 'UTC', hour: '2-digit', minute: '2-digit' });
}
export function readerGalleryData(items: ReaderMessage[]): string {
  return readerEscape(JSON.stringify(items.map(({ id, attachment, message, date, author }) => ({ id, attachment, message, date, author }))));
}
export function readerThumbnail(item: ReaderMessage, assets: ReaderAssets, eager: boolean): string {
  const filename = item.attachment!, kind = readerKind(filename), original = readerEscape(`attachments/${readerPath(filename)}`);
  const poster = assets.previews?.[filename];
  if (kind === 'photo' || poster) return `<img src="${poster ? readerEscape(readerPath(poster.file)) : original}" alt="" loading="${eager ? 'eager' : 'lazy'}" decoding="async" draggable="false">`;
  return `<video src="${original}#t=0.1" preload="metadata" muted playsinline aria-hidden="true"></video>`;
}
export function readerAttachment(item: ReaderMessage, assets: ReaderAssets, eager: boolean): string {
  const filename = item.attachment!, kind = readerKind(filename), url = readerEscape(`attachments/${readerPath(filename)}`);
  if (kind) return `<div class="attachment"><button type="button" class="media-open" data-gallery="${readerGalleryData([item])}" data-gallery-index="0" aria-label="Open ${kind}${item.message ? ': ' + readerEscape(item.message) : ''}">${readerThumbnail(item, assets, eager)}${kind === 'video' ? '<span class="video-label">Video</span>' : ''}</button></div>`;
  if (['mp3', 'ogg', 'opus', 'm4a', 'wav'].includes(filename.split('.').at(-1)?.toLowerCase() ?? '')) return `<div class="attachment"><audio src="${url}" controls preload="none"></audio></div>`;
  return `<div class="attachment"><a class="attachment-link" href="${url}">${readerEscape(filename)}</a></div>`;
}
export function readerMessage(item: ReaderMessage, assets: ReaderAssets, eager: boolean): string {
  const author = item.author ?? 'Unknown';
  if (item.system) return `<span class="post-anchor" id="${readerEscape(item.id)}" data-post-id="${readerEscape(item.id)}"></span><article class="message system"><div class="bubble">${item.attachment ? readerAttachment(item, assets, eager) : ''}${readerEscape(item.message)}</div></article>`;
  return `<article class="message${item.system ? ' system' : ''}" id="${readerEscape(item.id)}" data-post-id="${readerEscape(item.id)}"><div class="bubble">${item.system ? '' : `<div class="author" style="color:${readerColor(author)}">${readerEscape(author)}</div>`}${item.attachment ? readerAttachment(item, assets, eager) : ''}${item.message ? `<div class="text">${readerEscape(item.message)}</div>` : ''}${item.unresolvedMedia ? '<p class="media-missing">Media has not been recovered from the saved exports.</p>' : ''}${assets.showSourceLinks && item.observationIds ? `<a class="source-link" href="provenance.html#${readerEscape(encodeURIComponent(item.id))}">Inspect import records</a>` : ''}<div class="time">${readerTime(item.date, assets)}</div></div></article>`;
}
export function readerAlbum(items: ReaderMessage[], assets: ReaderAssets, eager: boolean): string {
  const first = items[0]!, photos = items.filter(item => readerKind(item.attachment!) === 'photo').length, videos = items.length - photos;
  const count = [photos ? `${photos} photo${photos === 1 ? '' : 's'}` : '', videos ? `${videos} video${videos === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return `<article class="message album" data-album-id="album-${readerEscape(first.id)}" data-gallery="${readerGalleryData(items)}" data-post-ids="${readerEscape(JSON.stringify(items.map(item => item.id)))}"><div class="bubble"><div class="author" style="color:${readerColor(first.author ?? 'Unknown')}">${readerEscape(first.author ?? 'Unknown')}</div><div class="album-heading"><span>${count}</span><span class="album-hint">Open album</span></div><div class="album-grid" data-count="${Math.min(items.length, 4)}">${items.slice(0, 4).map((item, index) => `<button type="button" class="album-tile" data-gallery-index="${index}" aria-label="Open ${readerKind(item.attachment!)} ${index + 1} of ${items.length}">${readerThumbnail(item, assets, eager)}${readerKind(item.attachment!) === 'video' ? '<span class="video-label">Video</span>' : ''}${index === 3 && items.length > 4 ? `<span class="album-more" aria-hidden="true">+${items.length - 4}</span>` : ''}</button>`).join('')}</div>${items.map((item, index) => `<span class="post-anchor" id="${readerEscape(item.id)}" data-post-id="${readerEscape(item.id)}"></span>${item.message ? `<div class="album-caption"><button type="button" data-gallery-index="${index}">${readerKind(item.attachment!)} ${index + 1}</button><div class="text">${readerEscape(item.message)}</div></div>` : ''}`).join('')}<div class="album-footer"><span class="time">${readerTime(first.date, assets)}</span><button type="button" class="album-view-all" data-gallery-index="0">View all ${items.length}</button></div></div></article>`;
}
export function renderReaderDay(messages: ReaderMessage[], assets: ReaderAssets, eager = false): string {
  const starts = new Map((assets.albums ?? []).map(album => [album.postIds[0], album]));
  const day = new Intl.DateTimeFormat([], { timeZone: assets.timeZone ?? 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  let html = '', lastDay = '';
  for (let i = 0; i < messages.length;) {
    const item = messages[i]!, date = day.format(new Date(item.date));
    if (date !== lastDay) { html += `<div class="date-separator"><span>${readerEscape(date)}</span></div>`; lastDay = date; }
    const album = starts.get(item.id);
    if (album) {
      const items = messages.slice(i, i + album.postIds.length);
      if (items.length !== album.postIds.length || items.some((member, index) => member.id !== album.postIds[index])) throw new Error('Album membership does not match preserved day records');
      html += readerAlbum(items, assets, eager && i >= messages.length - 20); i += items.length;
    } else { html += readerMessage(item, assets, eager && i >= messages.length - 20); i++; }
  }
  return html;
}

export function installReaderGallery(): void {
  const dialog = document.createElement('dialog'); dialog.className = 'media-gallery'; dialog.setAttribute('aria-label', 'Photos and videos');
  const bar = document.createElement('div'); bar.className = 'gallery-bar';
  const counter = document.createElement('div'); counter.className = 'gallery-counter'; counter.setAttribute('role', 'status'); counter.setAttribute('aria-live', 'polite');
  const button = (label: string, className: string) => { const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.className = className; return el; };
  const previous = button('Previous', 'gallery-previous'), next = button('Next', 'gallery-next'), close = button('Close', 'gallery-close'); close.autofocus = true;
  bar.append(previous, counter, next, close);
  const stage = document.createElement('div'); stage.className = 'gallery-stage';
  const footer = document.createElement('div'); footer.className = 'gallery-details';
  const caption = document.createElement('div'); caption.className = 'gallery-caption';
  const time = document.createElement('div'); time.className = 'gallery-time';
  const original = document.createElement('a'); original.className = 'gallery-original'; original.textContent = 'Open original'; original.target = '_blank'; original.rel = 'noopener';
  const error = document.createElement('p'); error.className = 'gallery-error'; error.textContent = 'This file could not be previewed. You can open the original below.'; error.hidden = true;
  footer.append(caption, time, original); dialog.append(bar, stage, error, footer); document.body.append(dialog);
  let items: ReaderMessage[] = [], index = 0, opener: HTMLElement | undefined, ownHistory = false, waitingForBack = false, scrollY = 0;
  let oldOverflow = '', oldBodyOverflow = '', openerTop = 0;
  const pause = () => stage.querySelectorAll('video').forEach(video => video.pause());
  const show = () => {
    pause(); stage.replaceChildren(); error.hidden = true;
    const item = items[index]!, kind = readerKind(item.attachment!);
    const media = document.createElement(kind === 'video' ? 'video' : 'img'); media.className = 'gallery-media';
    media.onerror = () => { error.hidden = false; };
    const url = `attachments/${readerPath(item.attachment!)}`; media.src = url;
    if (media instanceof HTMLVideoElement) { media.controls = true; media.playsInline = true; media.preload = 'metadata'; }
    else { media.alt = item.message || `Photo ${index + 1} of ${items.length}`; media.draggable = false; }
    stage.append(media);
    counter.textContent = `${index + 1} of ${items.length}`;
    previous.disabled = index === 0; next.disabled = index === items.length - 1;
    if (previous.disabled && document.activeElement === previous) next.focus();
    else if (next.disabled && document.activeElement === next) previous.focus();
    previous.hidden = next.hidden = items.length === 1;
    caption.textContent = item.message; caption.hidden = !item.message;
    const zone = (window as Window & { __CHUNK_MANIFEST__?: ReaderAssets }).__CHUNK_MANIFEST__?.timeZone ?? 'UTC';
    time.textContent = `${item.author ?? 'Unknown'} · ${new Date(item.date).toLocaleString([], { timeZone: zone, dateStyle: 'medium', timeStyle: 'medium' })}`;
    original.href = url;
  };
  const move = (offset: number) => { const target = index + offset; if (target >= 0 && target < items.length) { index = target; show(); } };
  const finish = (fromHistory = false) => {
    if (!dialog.open) return;
    pause(); dialog.close(); stage.replaceChildren(); items = [];
    document.documentElement.style.overflow = oldOverflow; document.body.style.overflow = oldBodyOverflow;
    opener?.focus({ preventScroll: true });
    // Anchor to the item, even if an in-flight older day loaded or the phone rotated.
    const restoredY = opener?.isConnected ? window.scrollY + opener.getBoundingClientRect().top - Math.min(openerTop, window.innerHeight - 56) : scrollY;
    window.scrollTo(0, restoredY);
    if (ownHistory && !fromHistory) { ownHistory = false; waitingForBack = true; window.history.back(); }
    else ownHistory = false;
  };
  previous.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1)); close.addEventListener('click', () => finish());
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.addEventListener('keydown', event => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLVideoElement || target instanceof HTMLAudioElement) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
  });
  let gesture: { x: number; y: number; pointer: number; backdrop: boolean } | undefined, skipClickUntil = 0;
  stage.addEventListener('pointerdown', event => {
    if (!event.isPrimary || gesture) { gesture = undefined; return; }
    const video = event.target instanceof HTMLVideoElement ? event.target : undefined;
    if (video && event.clientY > video.getBoundingClientRect().bottom - 70) return; // Native scrubber and controls.
    gesture = { x: event.clientX, y: event.clientY, pointer: event.pointerId, backdrop: event.target === stage };
    if (!video) stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointercancel', () => { gesture = undefined; });
  stage.addEventListener('pointerup', event => {
    const start = gesture; gesture = undefined;
    if (!start || start.pointer !== event.pointerId) return;
    const x = event.clientX - start.x, y = event.clientY - start.y;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (Math.abs(x) > 45 && Math.abs(x) > Math.abs(y) * 1.3) { skipClickUntil = Date.now() + 400; move(x < 0 ? 1 : -1); }
    else if (start.backdrop && Math.abs(x) < 10 && Math.abs(y) < 10) { skipClickUntil = Date.now() + 400; finish(); }
  });
  stage.addEventListener('click', event => {
    if (Date.now() < skipClickUntil) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  window.addEventListener('popstate', () => { waitingForBack = false; ownHistory = false; finish(true); });
  document.body.addEventListener('click', event => {
    if (Date.now() < skipClickUntil || waitingForBack || !(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLElement>('[data-gallery-index]');
    if (!trigger) return;
    const holder = trigger.closest<HTMLElement>('[data-gallery]'); if (!holder) return;
    const data = JSON.parse(holder.dataset.gallery ?? '[]') as ReaderMessage[];
    if (!data.length || data.some(item => !item.attachment || /[\\/\0]/.test(item.attachment) || !readerKind(item.attachment))) return;
    event.preventDefault(); opener = trigger; items = data; index = Math.max(0, Math.min(data.length - 1, Number(trigger.dataset.galleryIndex) || 0));
    scrollY = window.scrollY; openerTop = trigger.getBoundingClientRect().top; oldOverflow = document.documentElement.style.overflow; oldBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden';
    show();
    try { window.history.pushState({ ...window.history.state, clemcastGallery: true }, '', window.location.href); ownHistory = true; }
    catch { ownHistory = false; } // Some offline file readers restrict history; the gallery still works.
    dialog.showModal(); close.focus();
  });
}
