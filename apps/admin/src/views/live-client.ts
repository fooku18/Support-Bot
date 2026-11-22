/**
 * Settings change notices, served as `/assets/live.js` without inline script.
 * A new version or server epoch offers a reload; forms and their current input
 * stay untouched. The authenticated socket carries no page or producer data.
 */
export const LIVE_CLIENT_JS = String.raw`(function () {
  'use strict';
  var regions = Array.prototype.slice.call(document.querySelectorAll('[data-live-notice]'));
  if (regions.length === 0 || !('WebSocket' in window)) return;
  var status = document.getElementById('live-status');
  var socket = null;
  var epoch = null;
  var retryMs = 1000;
  var timer = null;
  var signedOut = false;

  function setStatus(text, kind) {
    if (!status) return;
    status.textContent = text;
    status.setAttribute('data-state', kind);
  }

  regions.forEach(function (region) {
    region.liveTopics = region.getAttribute('data-live-topics').split(/\s+/).filter(Boolean);
    try {
      region.liveVersions = JSON.parse(region.getAttribute('data-live-versions') || '{}');
    } catch (e) {
      region.liveVersions = {};
    }
    region.liveEpoch = region.getAttribute('data-live-epoch');
  });

  function allTopics() {
    var seen = {};
    regions.forEach(function (region) {
      region.liveTopics.forEach(function (topic) { seen[topic] = true; });
    });
    return Object.keys(seen).slice(0, 32);
  }

  function onVersions(versions) {
    regions.forEach(function (region) {
      region.liveTopics.forEach(function (topic) {
        if (Object.prototype.hasOwnProperty.call(versions, topic) &&
            (versions[topic] > (region.liveVersions[topic] || 0) || region.liveEpoch !== epoch)) {
          region.hidden = false;
          region.liveVersions[topic] = versions[topic];
          region.liveEpoch = epoch;
        }
      });
    });
  }

  function connect() {
    clearTimeout(timer);
    if (signedOut || (socket && (socket.readyState === 0 || socket.readyState === 1))) return;
    setStatus('Updates: connecting…', 'connecting');
    socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live');
    socket.onopen = function () {
      retryMs = 1000;
      socket.send(JSON.stringify({ type: 'subscribe', topics: allTopics() }));
    };
    socket.onmessage = function (message) {
      var body;
      try { body = JSON.parse(message.data); } catch (e) { return; }
      if (body.type === 'hello') {
        epoch = body.epoch;
        setStatus('Updates: connected', 'live');
      } else if (body.type === 'versions' || body.type === 'changed') {
        epoch = body.epoch;
        onVersions(body.versions || {});
      }
    };
    socket.onclose = function (event) {
      socket = null;
      if (event.code === 4401) {
        signedOut = true;
        setStatus('Updates: signed out; reload the page', 'off');
        return;
      }
      setStatus('Updates: disconnected; reconnecting', 'stale');
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      retryMs = 1000;
      connect();
    }
  });
  window.addEventListener('online', function () {
    retryMs = 1000;
    connect();
  });
  connect();
})();
`;
