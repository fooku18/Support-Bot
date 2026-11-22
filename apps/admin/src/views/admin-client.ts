/**
 * Page enhancements, served as `/assets/admin.js` (the CSP allows no inline
 * script). Every page works without it. It loads in <head> without `defer`
 * so a saved theme applies before the first paint, and binds its controls
 * once the document is parsed:
 *
 * - theme toggle (light/dark; without a choice the system decides),
 * - sidebar collapse,
 * - closing open menus (<details data-menu>) on an outside click or Escape,
 * - the command palette (Ctrl/Cmd+K), filled from `GET /palette.json`.
 *
 * Preferences stay in this browser (localStorage). Results are built with
 * DOM APIs and textContent only.
 */
export const ADMIN_CLIENT_JS = String.raw`(function () {
  'use strict';
  var root = document.documentElement;
  function read(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  var savedTheme = read('sa-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') root.setAttribute('data-theme', savedTheme);
  if (read('sa-sidebar') === 'collapsed') root.setAttribute('data-sidebar', 'collapsed');

  function effectiveTheme() {
    var chosen = root.getAttribute('data-theme');
    if (chosen === 'light' || chosen === 'dark') return chosen;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function bindTheme() {
    var buttons = all('[data-theme-toggle]');
    function label() {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      buttons.forEach(function (button) {
        button.setAttribute('aria-label', 'Switch to ' + next + ' theme');
        button.hidden = false;
      });
    }
    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        write('sa-theme', next);
        label();
      });
    });
    label();
  }

  function bindSidebar() {
    all('[data-sidebar-toggle]').forEach(function (button) {
      function label() {
        var collapsed = root.getAttribute('data-sidebar') === 'collapsed';
        button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      }
      button.hidden = false;
      label();
      button.addEventListener('click', function () {
        if (root.getAttribute('data-sidebar') === 'collapsed') {
          root.removeAttribute('data-sidebar');
          write('sa-sidebar', 'expanded');
        } else {
          root.setAttribute('data-sidebar', 'collapsed');
          write('sa-sidebar', 'collapsed');
        }
        label();
      });
    });
  }

  function closeMenus(except) {
    all('details[data-menu][open]').forEach(function (menu) {
      if (menu !== except && !menu.contains(except)) menu.removeAttribute('open');
    });
  }
  function bindMenus() {
    document.addEventListener('click', function (event) {
      var target = event.target;
      var inside = target && target.closest ? target.closest('details[data-menu]') : null;
      closeMenus(inside);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      var open = all('details[data-menu][open]');
      if (open.length === 0) return;
      open.forEach(function (menu) {
        menu.removeAttribute('open');
        var summary = menu.querySelector('summary');
        if (summary) summary.focus();
      });
    });
  }

  function bindPalette() {
    var dialog = document.getElementById('palette');
    var input = document.getElementById('palette-input');
    var list = document.getElementById('palette-list');
    if (!dialog || !input || !list || typeof dialog.showModal !== 'function') return;
    var openers = all('[data-palette-open]');
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    openers.forEach(function (button) {
      button.hidden = false;
      var key = button.querySelector('kbd');
      if (key && mac) key.textContent = '⌘K';
      button.addEventListener('click', open);
    });
    var items = null;
    var shown = [];
    var active = 0;

    function load() {
      if (items !== null) return Promise.resolve(items);
      return fetch('/palette.json', { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (body) {
          items = Array.isArray(body.items) ? body.items : [];
          return items;
        });
    }
    function matches(item, words) {
      var text = (item.label + ' ' + (item.sub || '') + ' ' + item.group).toLowerCase();
      for (var i = 0; i < words.length; i += 1) if (text.indexOf(words[i]) === -1) return false;
      return true;
    }
    function select(index) {
      var options = list.querySelectorAll('[role=option]');
      if (options.length === 0) return;
      active = (index + options.length) % options.length;
      Array.prototype.forEach.call(options, function (option, i) {
        option.setAttribute('aria-selected', i === active ? 'true' : 'false');
      });
      input.setAttribute('aria-activedescendant', options[active].id);
      options[active].scrollIntoView({ block: 'nearest' });
    }
    function message(text) {
      list.textContent = '';
      var row = document.createElement('li');
      row.className = 'pal-g';
      row.textContent = text;
      list.appendChild(row);
    }
    function draw() {
      var words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = (items || []).filter(function (item) { return matches(item, words); }).slice(0, 60);
      list.textContent = '';
      if (shown.length === 0) {
        message(items === null ? 'Loading…' : 'Nothing matches.');
        return;
      }
      var group = null;
      shown.forEach(function (item, index) {
        if (item.group !== group) {
          group = item.group;
          var heading = document.createElement('li');
          heading.className = 'pal-g';
          heading.setAttribute('role', 'presentation');
          heading.textContent = group;
          list.appendChild(heading);
        }
        var option = document.createElement('li');
        option.className = 'pal-o';
        option.id = 'pal-' + index;
        option.setAttribute('role', 'option');
        var title = document.createElement('span');
        title.className = 't';
        title.textContent = item.label;
        option.appendChild(title);
        if (item.sub) {
          var sub = document.createElement('span');
          sub.className = 'sub';
          sub.textContent = item.sub;
          option.appendChild(sub);
        }
        option.addEventListener('mousemove', function () { if (active !== index) select(index); });
        option.addEventListener('click', function () { go(index); });
        list.appendChild(option);
      });
      select(0);
    }
    function go(index) {
      var item = shown[index];
      if (!item || typeof item.href !== 'string' || item.href.charAt(0) !== '/') return;
      dialog.close();
      window.location.assign(item.href);
    }
    function open() {
      if (dialog.open) return;
      closeMenus(null);
      input.value = '';
      dialog.showModal();
      input.focus();
      draw();
      load().then(draw, function () { message('Could not load the list. Reload the page.'); });
    }
    input.addEventListener('input', draw);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); select(active + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); select(active - 1); }
      else if (event.key === 'Enter') { event.preventDefault(); go(active); }
    });
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        if (dialog.open) dialog.close(); else open();
      }
    });
  }

  function init() {
    bindTheme();
    bindSidebar();
    bindMenus();
    bindPalette();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
