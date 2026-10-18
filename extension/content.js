'use strict';
// Tracks modifier keys on link clicks (force/bypass OpenDM) and shows the
// "Download this video" panel over web players when the background script detects media.
(() => {
  if (window.__opendm) return;
  window.__opendm = true;
  let insertHeld = false;
  let cfg = { active: false, forceKey: 'Insert', mode: 'full' };
  let media = [];
  let hiddenByUser = false;

  const safeSend = (msg, cb) => {
    try {
      chrome.runtime.sendMessage(msg, cb);
    } catch { /* extension reloaded */ }
  };
  safeSend({ type: 'odm-get-config' }, (r) => {
    if (chrome.runtime.lastError || !r) return;
    cfg = r;
    if (r.media?.length) {
      media = r.media;
      schedulePanel();
    }
  });

  addEventListener('keydown', (e) => e.key === 'Insert' && (insertHeld = true), true);
  addEventListener('keyup', (e) => e.key === 'Insert' && (insertHeld = false), true);
  addEventListener('blur', () => (insertHeld = false));

  const forceHeld = (e) => ({ Insert: insertHeld, Alt: e.altKey, Shift: e.shiftKey, Ctrl: e.ctrlKey })[cfg.forceKey] || false;

  addEventListener('mousedown', (e) => {
    if (!e.target.closest?.('a[href]')) return;
    safeSend({ type: 'odm-click', alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, insert: insertHeld });
  }, true);

  // Force key on any link: hand it to OpenDM even if the browser would just navigate.
  addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || !cfg.active || !cfg.forceKey || !forceHeld(e)) return;
    if (!/^(https?|ftp):/i.test(a.href)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    safeSend({ type: 'odm-download-link', url: a.href });
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'odm-media') {
      media = msg.items || [];
      cfg.mode = msg.mode || cfg.mode;
      cfg.active = true;
      schedulePanel();
    } else if (msg.type === 'odm-notice' && window === top) {
      toast(msg.message);
    }
  });

  // ---- panel -----------------------------------------------------------------------------------

  let host, shadow, btn, menu, target, raf;

  function fmtSize(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < 3) {
      n /= 1024;
      i++;
    }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function largestPlayer() {
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video, audio')) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (r.width > 120 && r.height > 30 && a > area) {
        best = v;
        area = a;
      }
    }
    return best;
  }

  function schedulePanel() {
    if (hiddenByUser || !media.length) return;
    if (document.readyState === 'loading') return document.addEventListener('DOMContentLoaded', schedulePanel, { once: true });
    target = largestPlayer();
    const isTopWithoutFrames = window === top && !document.querySelector('iframe, frame');
    if (!target && !isTopWithoutFrames) return;
    ensurePanel();
    renderMenu();
    position();
  }

  function ensurePanel() {
    if (host) return;
    host = document.createElement('opendm-panel');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;';
    shadow = host.attachShadow({ mode: 'closed' });
    const icon = chrome.runtime.getURL('icons/icon32.png');
    shadow.innerHTML = `<style>
      :host{all:initial}
      .wrap{font:13px/1.3 "Segoe UI",system-ui,sans-serif;color:#1c2027}
      .btn{display:flex;align-items:center;gap:7px;background:#15806cee;color:#fff;border:0;border-radius:7px;padding:6px 10px 6px 7px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.35);font:inherit;font-weight:600}
      .btn:hover{background:#106b5a}
      .btn img{width:18px;height:18px;border-radius:4px}
      .mini .label{display:none}.mini .btn{padding:6px}
      .x{margin-left:4px;opacity:.75;font-weight:400;padding:0 3px}.x:hover{opacity:1}
      .menu{margin-top:6px;background:#fff;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.3);padding:4px;min-width:260px;max-width:420px;max-height:320px;overflow:auto;display:none}
      .menu.open{display:block}
      .it{display:flex;gap:10px;align-items:center;padding:7px 9px;border-radius:5px;cursor:pointer}
      .it:hover{background:#15806c;color:#fff}.it:hover .m{color:#fff}
      .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .m{color:#6b7280;font-size:12px;white-space:nowrap}
      .head{padding:6px 9px;color:#6b7280;font-size:12px}
      @media (prefers-color-scheme:dark){.menu{background:#26282d;color:#e6e8eb}.head,.m{color:#9aa1ad}}
    </style><div class="wrap"><button class="btn" part="btn"><img src="${icon}" alt=""><span class="label">Download this video</span><span class="x" title="Hide">✕</span></button><div class="menu" role="menu"></div></div>`;
    btn = shadow.querySelector('.btn');
    menu = shadow.querySelector('.menu');
    btn.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) {
        hiddenByUser = true;
        host.remove();
        return;
      }
      if (media.length === 1) return download(media[0]);
      menu.classList.toggle('open');
    });
    document.documentElement.append(host);
    addEventListener('scroll', position, { passive: true, capture: true });
    addEventListener('resize', position, { passive: true });
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement;
      (fs || document.documentElement).append(host);
    });
  }

  function label(m) {
    let name = '';
    try {
      name = decodeURIComponent(new URL(m.url).pathname.split('/').pop() || '');
    } catch { /* ignore */ }
    if (m.kind === 'hls') return 'HLS stream' + (name ? ` · ${name}` : '');
    if (m.kind === 'dash') return 'DASH manifest' + (name ? ` · ${name}` : '');
    return name || m.url;
  }

  function renderMenu() {
    shadow.querySelector('.wrap').classList.toggle('mini', cfg.mode === 'mini');
    menu.innerHTML = '<div class="head">Choose what to download</div>';
    for (const m of media) {
      const row = document.createElement('div');
      row.className = 'it';
      row.setAttribute('role', 'menuitem');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = label(m);
      const meta = document.createElement('span');
      meta.className = 'm';
      meta.textContent = [m.ext?.toUpperCase(), fmtSize(m.size)].filter(Boolean).join(' · ');
      row.append(n, meta);
      row.addEventListener('click', () => download(m));
      menu.append(row);
    }
  }

  function download(m) {
    menu.classList.remove('open');
    safeSend({ type: 'odm-download-media', item: m }, (r) => {
      if (chrome.runtime.lastError) return;
      toast(r?.ok ? 'Sent to OpenDM' : 'Could not reach OpenDM — is the app running?');
    });
  }

  function position() {
    if (!host) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (target && !target.isConnected) target = largestPlayer();
      const w = 220;
      if (target) {
        const r = target.getBoundingClientRect();
        const visible = r.bottom > 0 && r.top < innerHeight && r.width > 0;
        host.style.display = visible ? '' : 'none';
        host.style.transform = `translate(${Math.max(4, Math.min(innerWidth - w, r.right - w))}px, ${Math.max(4, r.top + 8)}px)`;
      } else {
        host.style.transform = `translate(${innerWidth - w - 16}px, 16px)`;
      }
    });
  }

  function toast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:24px;left:50%;transform:translateX(-50%);background:#1c2027;color:#fff;font:13px "Segoe UI",system-ui,sans-serif;padding:9px 14px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:80vw';
    document.documentElement.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  new MutationObserver(() => {
    if (media.length && !hiddenByUser && (!target || !target.isConnected)) schedulePanel();
  }).observe(document, { childList: true, subtree: true });
})();
