/* app.js —— 共享脚本：身份、API、tabBar、提示、工具函数 */
(function () {
  const UID_KEY = 'clf_uid';

  function getUserId() {
    let id = localStorage.getItem(UID_KEY);
    if (!id) {
      id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(UID_KEY, id);
    }
    return id;
  }

  async function api(path, opts) {
    const o = opts || {};
    const res = await fetch('/api/' + path, {
      method: o.method || 'GET',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'x-user-id': getUserId() },
        o.headers || {}
      ),
      body: o.body ? JSON.stringify(o.body) : undefined
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, errMsg: '服务器返回异常（' + res.status + '）' };
    }
    if (!res.ok && !data.errMsg) data.errMsg = '请求失败（' + res.status + '）';
    return data;
  }

  /* ---------- 提示 ---------- */
  let toastTimer = null;
  function toast(msg, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2000);
  }

  function confirmBox(title, content, okText) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal"><h3>' + esc(title) + '</h3><p>' + esc(content) + '</p>' +
        '<div class="btn-row"><button class="btn" data-x="0">取消</button>' +
        '<button class="btn btn-primary" data-x="1">' + esc(okText || '确认') + '</button></div></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]');
        if (!b) {
          if (e.target === mask) {
            mask.remove();
            resolve(false);
          }
          return;
        }
        mask.remove();
        resolve(b.getAttribute('data-x') === '1');
      });
    });
  }

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function fmtDate(ts) {
    if (!ts) return '未填写';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const diff = now - d;
    if (diff < 24 * 3600 * 1000) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function ago(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
    return fmtDate(ts);
  }

  function levelClass(score) {
    if (score >= 85) return 'high';
    if (score >= 70) return 'mid';
    return 'low';
  }

  function typeLabel(t) {
    return t === 'lost' ? '失物' : '招领';
  }

  function locText(p) {
    if (!p) return '';
    const list = (p.locations && p.locations.length ? p.locations : [{ campus: p.campus, building: p.building }]) || [];
    return list
      .filter((x) => x && x.campus)
      .map((x) => x.building || x.campus)
      .join(' / ');
  }

  function timeText(p) {
    if (!p) return '';
    if (p.timeUnknown) return '时间记不清';
    if (p.eventTimeEnd) return fmtDate(p.eventTime) + ' ～ ' + fmtDate(p.eventTimeEnd);
    return fmtDate(p.eventTime);
  }

  /* ---------- tabBar ---------- */
  const TABS = [
    { key: 'index', href: '/index.html', text: '广场', icon: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>' },
    { key: 'publish', href: '/publish.html', text: '发布', icon: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' },
    { key: 'message', href: '/message.html', text: '消息', icon: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/></svg>' },
    { key: 'mine', href: '/mine.html', text: '我的', icon: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8" r="3.4"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/></svg>' }
  ];

  function mountTab(active) {
    const nav = document.createElement('nav');
    nav.className = 'tabbar';
    nav.innerHTML = TABS.map(
      (t) =>
        '<a href="' + t.href + '" class="' + (t.key === active ? 'on' : '') + '">' +
        '<span class="ico">' + t.icon + '</span><span>' + t.text + '</span>' +
        (t.key === 'message' ? '<span class="dot" id="tabDot" style="display:none"></span>' : '') +
        '</a>'
    ).join('');
    document.body.appendChild(nav);
  }

  let lastUnread = 0;
  async function refreshUnread() {
    try {
      const r = await api('messages');
      const n = r.unread || 0;
      lastUnread = n;
      const dot = document.getElementById('tabDot');
      if (dot) {
        dot.style.display = n > 0 ? 'block' : 'none';
        dot.textContent = n > 99 ? '99+' : n;
      }
      document.querySelectorAll('[data-unread]').forEach((el) => {
        el.textContent = n > 99 ? '99+' : n;
        el.style.display = n > 0 ? 'inline-flex' : 'none';
      });
      return n;
    } catch (e) {
      return lastUnread;
    }
  }

  /** 顶部提示条 */
  function banner(container, text, kind) {
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'notice ' + (kind || '');
    div.innerHTML = text;
    container.prepend(div);
    return div;
  }

  function storageWarn(container, storage) {
    if (!container || !storage) return;
    if (storage.backend !== 'redis') {
      banner(
        container,
        '<b>当前未连接云端数据库</b>：数据暂存在本机文件里，刷新后仍在，但换一台电脑就看不到了。<br>' +
          '在 Vercel 项目的 Storage 里创建一个 Upstash Redis（或 Vercel KV），环境变量会自动注入，重新部署后这里会变成「云端已连接」。',
        'err'
      );
    }
  }

  const ICO = {
    pin: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-1.5px;margin-right:2px"><path d="M12 21s-6.5-5.3-6.5-10a6.5 6.5 0 1 1 13 0C18.5 15.7 12 21 12 21z"/><circle cx="12" cy="11" r="2.1"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-1.5px;margin-right:2px"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    box: '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l8-4 8 4v9l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v9"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15.5 15.5L20 20"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:3px"><rect x="5" y="10.5" width="14" height="9" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
    mail: '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/></svg>'
  };

  window.APP = {
    getUserId,
    api,
    toast,
    confirm: confirmBox,
    esc,
    fmtDate,
    fmtTime,
    ago,
    levelClass,
    typeLabel,
    locText,
    timeText,
    mountTab,
    refreshUnread,
    banner,
    storageWarn,
    ICO
  };
})();
