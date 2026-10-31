import type { ChunkManifest } from './types.js';
import type { ReaderMessage } from './albums.js';

// No runtime imports: the same code runs in tests and the standalone/offline HTML.
export function timelineMonths(manifest: ChunkManifest): string[] {
  return [...new Set(manifest.chunks.map(chunk => chunk.date.slice(0, 7)))].sort().reverse();
}
export function monthStartIndex(manifest: ChunkManifest, month: string): number {
  if (!/^\d{4}-\d{2}$/.test(month)) return -1;
  return manifest.chunks.findLastIndex(chunk => chunk.date.startsWith(month + '-'));
}
export function timelineMonthLabel(month: string): string {
  return new Date(month + '-15T12:00:00Z').toLocaleDateString('en', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

/** Cache only validated days. Failed requests can be retried without advancing a cursor. */
export function createTimelineLoader(manifest: ChunkManifest, render: (messages: ReaderMessage[]) => string,
  transport: (date: string, filename: string) => Promise<unknown>) {
  const cache = new Map<number, string>(), pending = new Map<number, Promise<string>>();
  return function load(index: number): Promise<string> {
    const chunk = manifest.chunks[index];
    if (!chunk) return Promise.reject(new Error('Date is outside this archive.'));
    if (cache.has(index)) return Promise.resolve(cache.get(index)!);
    if (pending.has(index)) return pending.get(index)!;
    const request = Promise.resolve().then(() => transport(chunk.date, (manifest.chunkBase ?? 'chunks/') + chunk.filename)).then(data => {
      if (!Array.isArray(data) || !data.length || data.length !== chunk.messageCount
        || data[0]?.id !== chunk.firstMessageId || data.at(-1)?.id !== chunk.lastMessageId
        || new Set(data.map(item => item?.id)).size !== data.length) throw new Error('Incomplete day data.');
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: manifest.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
      if (data.some(item => !item || typeof item.id !== 'string' || typeof item.message !== 'string'
        || day.format(new Date(item.date)) !== chunk.date)) throw new Error('Unexpected day data.');
      const html = render(data); cache.set(index, html); return html;
    }).finally(() => pending.delete(index));
    pending.set(index, request); return request;
  };
}

/** JSONP keeps both hosted and unzipped file:// archives usable. */
export function createTimelineTransport(host: Window, doc: Document) {
  const pending = new Map<string, { resolve: (data: unknown) => void }>();
  (host as Window & { __loadChunk?: (date: string, data: unknown) => void }).__loadChunk = (date, data) => pending.get(date)?.resolve(data);
  return (date: string, filename: string): Promise<unknown> => new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    let timer: ReturnType<typeof setTimeout>, settled = false;
    const clean = () => { settled = true; clearTimeout(timer); script.remove(); pending.delete(date); };
    const fail = () => { if (settled) return; clean(); reject(new Error('Could not load this date. Check your connection and retry.')); };
    pending.set(date, { resolve: data => { if (settled) return; clean(); resolve(data); } });
    script.src = filename; script.onerror = fail;
    script.onload = () => { if (pending.has(date)) fail(); };
    timer = setTimeout(fail, 15000);
    doc.head.appendChild(script);
  });
}

export function installTimeline(): void {
  const host = window as unknown as Window & { __CHUNK_MANIFEST__?: ChunkManifest & { startAtLatestDay?: boolean }; __renderReaderDay: (messages: ReaderMessage[], manifest: ChunkManifest) => string };
  const manifest = host.__CHUNK_MANIFEST__;
  const days = document.getElementById('timeline-days');
  const older = document.getElementById('timeline-older') as HTMLButtonElement | null;
  const newer = document.getElementById('timeline-newer') as HTMLButtonElement | null;
  const status = document.getElementById('timeline-status');
  const dialog = document.getElementById('date-navigation') as HTMLDialogElement | null;
  if (!manifest?.chunks.length || !days || !older || !newer || !status || !dialog) return;
  const year = document.getElementById('jump-year') as HTMLSelectElement;
  const months = document.getElementById('jump-months')!;
  const jumpStatus = document.getElementById('jump-status')!;
  const retry = document.getElementById('jump-retry') as HTMLButtonElement;
  const close = document.getElementById('jump-close') as HTMLButtonElement;
  const latest = document.getElementById('jump-latest') as HTMLButtonElement;
  const available = timelineMonths(manifest);
  const load = createTimelineLoader(manifest, messages => host.__renderReaderDay(messages, manifest), createTimelineTransport(window, document));
  let oldest = 0, newest = 0, generation = 0, loadingOlder = false, loadingNewer = false;
  let failedOlder = false, failedNewer = false, jumping = false, target = -1, targetLatest = false;
  let opener: HTMLElement | null = null, positionObserver: ResizeObserver | undefined;
  let currentLocation = location.hash, previousY = window.scrollY, ticking = false;
  const stopHolding = () => { positionObserver?.disconnect(); positionObserver = undefined; };
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(event, stopHolding, { passive: true });
  const offset = () => document.querySelector('.mobile-archive')?.getBoundingClientRect().height ?? 0;
  const align = (node: HTMLElement) => { window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - offset() - 8); previousY = window.scrollY; };
  const visibleMonth = () => {
    const sections = [...days.querySelectorAll<HTMLElement>('.timeline-day')];
    return (sections.find(section => section.getBoundingClientRect().bottom > offset() + 80) ?? sections.at(-1))?.dataset.date?.slice(0, 7) ?? available[0]!;
  };
  const updateEdges = () => {
    older.hidden = oldest === manifest.chunks.length - 1;
    newer.hidden = newest === 0;
    older.disabled = loadingOlder; newer.disabled = loadingNewer;
    older.textContent = loadingOlder ? 'Loading older posts…' : failedOlder ? 'Retry older posts' : 'Older posts';
    newer.textContent = loadingNewer ? 'Loading newer posts…' : failedNewer ? 'Retry newer posts' : 'Newer posts';
    days.setAttribute('aria-busy', String(loadingOlder || loadingNewer || jumping));
  };
  const section = (index: number, html: string) => {
    const node = document.createElement('section'); node.className = 'timeline-day'; node.dataset.date = manifest.chunks[index]!.date;
    node.innerHTML = html; return node;
  };
  const holdPosition = (anchor: HTMLElement, top: number) => {
    stopHolding();
    const restore = () => { if (anchor.isConnected && !document.querySelector('dialog[open]')) { window.scrollTo(0, window.scrollY + anchor.getBoundingClientRect().top - top); previousY = window.scrollY; } };
    restore();
    if (typeof ResizeObserver !== 'undefined') { positionObserver = new ResizeObserver(restore); positionObserver.observe(days); }
  };
  const adjacent = async (direction: 'older' | 'newer') => {
    if (jumping || document.querySelector('dialog[open]')) return;
    const isOlder = direction === 'older';
    if (isOlder ? loadingOlder : loadingNewer) return;
    const index = isOlder ? oldest + 1 : newest - 1;
    if (!manifest.chunks[index]) return;
    const token = generation;
    if (isOlder) { loadingOlder = true; failedOlder = false; } else { loadingNewer = true; failedNewer = false; }
    status.textContent = ''; updateEdges();
    try {
      const html = await load(index);
      if (token !== generation) return;
      const node = section(index, html);
      if (isOlder) {
        const anchor = days.firstElementChild as HTMLElement, top = anchor.getBoundingClientRect().top;
        days.prepend(node); oldest = index; holdPosition(anchor, top);
      } else {
        stopHolding(); days.append(node); newest = index;
        const heading = node.querySelector<HTMLElement>('.date-separator')!; heading.tabIndex = -1; heading.focus({ preventScroll: true }); align(node);
      }
    } catch {
      if (token !== generation) return;
      if (isOlder) failedOlder = true; else failedNewer = true;
      status.textContent = 'Could not load ' + direction + ' posts. Please retry.';
    } finally {
      if (isOlder) loadingOlder = false; else loadingNewer = false;
      updateEdges();
    }
  };
  older.addEventListener('click', () => void adjacent('older'));
  newer.addEventListener('click', () => void adjacent('newer'));

  const drawMonths = () => {
    months.replaceChildren();
    for (let number = 1; number <= 12; number++) {
      const month = year.value + '-' + String(number).padStart(2, '0');
      const button = document.createElement('button'); button.type = 'button'; button.dataset.month = month;
      button.textContent = new Date(month + '-15T12:00:00Z').toLocaleDateString('en', { timeZone: 'UTC', month: 'short' });
      button.disabled = !available.includes(month);
      const count = manifest.chunks.filter(chunk => chunk.date.startsWith(month + '-')).reduce((sum, chunk) => sum + chunk.messageCount, 0);
      button.setAttribute('aria-label', `${timelineMonthLabel(month)}${count ? `, ${count} ${count === 1 ? 'post' : 'posts'}` : ', no posts'}`);
      if (month === visibleMonth()) button.setAttribute('aria-current', 'date');
      months.append(button);
    }
  };
  const setBusy = (busy: boolean) => {
    jumping = busy; dialog.setAttribute('aria-busy', String(busy)); year.disabled = busy; latest.disabled = busy;
    months.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || !available.includes(button.dataset.month!); });
    updateEdges();
  };
  const cancelJump = () => {
    generation++; setBusy(false); dialog.close(); jumpStatus.textContent = ''; retry.hidden = true;
    opener?.focus({ preventScroll: true });
  };
  close.addEventListener('click', cancelJump);
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancelJump(); });
  document.querySelectorAll<HTMLElement>('[data-jump-date]').forEach(trigger => trigger.addEventListener('click', () => {
    generation++; stopHolding(); opener = trigger; year.value = visibleMonth().slice(0, 4); drawMonths();
    jumpStatus.textContent = ''; retry.hidden = true; dialog.showModal(); year.focus();
  }));
  year.addEventListener('change', drawMonths);

  const jump = async (index: number, historyMode: 'push' | 'none' = 'push', goToLatest = false) => {
    if (!manifest.chunks[index]) return;
    stopHolding(); target = index; targetLatest = goToLatest;
    if (!dialog.open) { year.value = manifest.chunks[index]!.date.slice(0, 4); drawMonths(); dialog.showModal(); }
    const token = ++generation;
    setBusy(true); retry.hidden = true;
    jumpStatus.textContent = 'Loading ' + timelineMonthLabel(manifest.chunks[index]!.date.slice(0, 7)) + '…';
    try {
      const html = await load(index);
      if (token !== generation) return;
      const node = section(index, html);
      days.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media => media.pause());
      days.replaceChildren(node); oldest = newest = index;
      failedOlder = failedNewer = false; status.textContent = '';
      if (historyMode === 'push') {
        const hash = goToLatest ? '' : '#month=' + manifest.chunks[index]!.date.slice(0, 7);
        try { if (location.hash !== hash) history.pushState({ ...history.state, clemcastMonth: hash }, '', location.pathname + location.search + hash); } catch { /* Restricted offline viewers still navigate. */ }
      }
      currentLocation = location.hash;
      setBusy(false); dialog.close();
      const heading = node.querySelector<HTMLElement>('.date-separator')!;
      heading.tabIndex = -1; heading.focus({ preventScroll: true }); align(node);
      status.textContent = 'Showing ' + timelineMonthLabel(manifest.chunks[index]!.date.slice(0, 7)) + '. Older and newer posts remain available.';
    } catch {
      if (token !== generation) return;
      setBusy(false); jumpStatus.textContent = 'Could not load this month. Your current posts are still here. Check your connection and retry.';
      retry.hidden = false;
      if (!dialog.open) { year.value = manifest.chunks[index]!.date.slice(0, 4); drawMonths(); dialog.showModal(); }
      retry.focus();
    }
  };
  months.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-month]') : null;
    if (button && !button.disabled) void jump(monthStartIndex(manifest, button.dataset.month!));
  });
  latest.addEventListener('click', () => void jump(0, 'push', true));
  retry.addEventListener('click', () => void jump(target, 'push', targetLatest));
  document.querySelectorAll('[data-jump-latest]').forEach(button => button.addEventListener('click', () => void jump(0, 'push', true)));
  const followLocation = () => {
    const match = location.hash.match(/^#month=(\d{4}-\d{2})$/);
    const index = match ? monthStartIndex(manifest, match[1]!) : 0;
    currentLocation = location.hash;
    if (index >= 0) void jump(index, 'none', !match);
  };
  window.addEventListener('popstate', () => { if (currentLocation !== location.hash) followLocation(); });
  window.addEventListener('hashchange', () => { if (currentLocation !== location.hash) followLocation(); });
  // Gallery history entries use the same URL, so Back from a gallery never resets the timeline.
  if (/^#month=/.test(location.hash)) followLocation();
  else {
    if (manifest.startAtLatestDay) align(days.firstElementChild as HTMLElement);
    else window.scrollTo(0, document.documentElement.scrollHeight);
  }
  updateEdges();
  previousY = window.scrollY;
  window.addEventListener('scroll', () => {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      const up = window.scrollY < previousY; previousY = window.scrollY; ticking = false;
      if (up && !failedOlder && older.getBoundingClientRect().bottom > 0 && older.getBoundingClientRect().top < offset() + 250) void adjacent('older');
    });
  }, { passive: true });
  window.addEventListener('online', () => {
    if (dialog.open && !retry.hidden) void jump(target, 'push', targetLatest);
    else if (failedOlder) void adjacent('older');
    else if (failedNewer) void adjacent('newer');
  });
}
