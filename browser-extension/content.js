(() => {
  const ID = /^\d{15,22}$/;
  const button = document.createElement('button');
  button.className = 'shiyin-download-audio';
  button.type = 'button';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3v11m-4-4 4 4 4-4M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3');
  icon.append(path);
  const label = document.createElement('span');
  label.className = 'shiyin-download-label';
  label.textContent = '保存';
  button.append(icon, label);
  button.setAttribute('aria-label', '选择保存音频或视频');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'shiyin-save-options');
  button.title = '保存当前视频的音频或视频';
  const menu = document.createElement('div');
  menu.id = 'shiyin-save-options';
  menu.className = 'shiyin-save-options';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', '选择保存类型');
  menu.hidden = true;
  const audioOption = document.createElement('button');
  audioOption.type = 'button';
  audioOption.textContent = '保存音频';
  const videoOption = document.createElement('button');
  videoOption.type = 'button';
  videoOption.textContent = '保存视频';
  menu.append(audioOption, videoOption);
  const notice = document.createElement('div');
  notice.className = 'shiyin-audio-notice';
  notice.setAttribute('role', 'status');
  let timer;
  const recentSubmissions = new Map();
  let visibleVideoId = null;
  let menuVideoId = null;
  function closeMenu(restoreFocus = false) {
    menu.hidden = true;
    menuVideoId = null;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !button.hidden) button.focus();
  }
  function message(text) {
    notice.textContent = text;
    notice.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => notice.classList.remove('visible'), 5000);
  }
  function visibleRect(element) {
    const r = element.getBoundingClientRect();
    const left = Math.max(0, r.left), top = Math.max(0, r.top);
    const right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    if (right - left < 150 || bottom - top < 120) return null;
    return { left, top, right, bottom, area: (right - left) * (bottom - top) };
  }
  function current() {
    if (location.hostname === 'www.bilibili.com') {
      const match = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
      if (!match) return null;
      const part = new URL(location.href).searchParams.get('p') || '1';
      if (!/^(?:[1-9]\d{0,3}|10000)$/.test(part)) return null;
      const player = document.querySelector('#bilibili-player, .bpx-player-container, #playerWrap');
      const rect = player && visibleRect(player);
      return rect ? { id: `${match[1]}:${part}`, rect } : null;
    }
    // The feed contains preloaded neighbours. Only the site-marked active card
    // may supply the ID; never derive it from neighbouring links or stale URLs.
    const marked = [...document.querySelectorAll('[data-e2e="feed-active-video"]')]
      .map(card => ({ card, rect: visibleRect(card), id: card.getAttribute('data-e2e-vid') }))
      .filter(x => x.rect);
    if (marked.length === 1) {
      const video = marked[0].card.querySelector('video');
      return { id: ID.test(marked[0].id || '') ? marked[0].id : null, rect: (video && visibleRect(video)) || marked[0].rect };
    }
    // A transition with multiple active cards is ambiguous: wait for it to settle.
    if (marked.length > 1 || document.querySelector('[data-e2e="feed-active-video"], [data-e2e="feed-video"]')) return null;
    const videos = [...document.querySelectorAll('video')]
      .map(video => ({ video, rect: visibleRect(video) }))
      .filter(x => x.rect)
      .sort((a, b) => b.rect.area - a.rect.area);
    if (!videos.length || (videos[1] && videos[1].rect.area > videos[0].rect.area * .5)) return null;
    const url = new URL(location.href);
    const pathId = url.pathname.match(/^\/video\/(\d{15,22})(?:\/|$)/)?.[1];
    const modalId = url.searchParams.get('modal_id');
    const id = pathId || (ID.test(modalId || '') ? modalId : null);
    return { id, rect: videos[0].rect };
  }
  function submit(kind) {
    // Resolve again at click time, not from the previous frame.
    const active = current();
    if (active && visibleVideoId !== active.id) {
      notice.classList.remove('visible');
      visibleVideoId = active.id;
    }
    if (!active?.id || active.id !== menuVideoId) {
      closeMenu();
      return message('当前视频已变化或尚未识别，请重新选择。');
    }
    closeMenu();
    const requestKey = `${kind}:${active.id}`;
    const now = Date.now();
    for (const [key, time] of recentSubmissions) if (now - time >= 3000) recentSubmissions.delete(key);
    if (recentSubmissions.has(requestKey))
      return message('刚刚已尝试打开拾音，请在应用中查看保存请求。');
    recentSubmissions.set(requestKey, now);
    const a = document.createElement('a');
    const bili = location.hostname === 'www.bilibili.com';
    const [id, part] = active.id.split(':');
    a.href = `shiyin-audio://${bili ? 'bilibili' : 'douyin'}/${kind === 'video' ? 'video' : 'download'}?id=${id}${bili ? `&p=${part}` : ''}`;
    a.click();
    message(kind === 'video' ? '已请求打开拾音，请在应用中确认保存视频。水印以实际画面为准。' : '已请求打开拾音。请允许浏览器打开应用，并在拾音中确认保存音频。');
  }
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (!menu.hidden) return closeMenu();
    const active = current();
    if (!active?.id) return message('暂时无法识别当前视频，请稍候再试。');
    visibleVideoId = active.id;
    notice.classList.remove('visible');
    menuVideoId = active.id;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  });
  audioOption.addEventListener('click', event => { event.stopPropagation(); submit('audio'); });
  videoOption.addEventListener('click', event => { event.stopPropagation(); submit('video'); });
  document.addEventListener('click', event => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
  }, true);
  function attach() {
    if (!document.body) return;
    if (!button.isConnected) document.body.append(button);
    if (!menu.isConnected) document.body.append(menu);
    if (!notice.isConnected) document.body.append(notice);
    const active = current();
    button.hidden = !active;
    if (!active) { closeMenu(); notice.classList.remove('visible'); visibleVideoId = null; return; }
    if (visibleVideoId !== active.id) {
      closeMenu();
      notice.classList.remove('visible');
      visibleVideoId = active.id;
    }
    label.textContent = active.id ? '保存' : '识别视频';
    button.setAttribute('aria-label', active.id ? '选择保存音频或视频' : '查看当前视频识别提示');
    button.title = active.id ? '保存当前视频的音频或视频' : '暂未识别到当前视频，点击查看提示';
    const { top, right } = active.rect;
    const x = Math.max(8, innerWidth - right + 16);
    const y = Math.max(8, top + 16);
    button.style.right = `${x}px`;
    button.style.top = `${y}px`;
    menu.style.right = `${x}px`;
    menu.style.top = `${y + 46}px`;
    notice.style.right = `${x}px`;
    notice.style.top = `${y + 46}px`;
  }
  attach();
  setInterval(attach, 500);
  addEventListener('resize', attach);
  addEventListener('scroll', attach, true);
})();
