// AI Visibility Checker dashboard: small progressive enhancements. Every page works without it.
(function () {
  'use strict';

  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () {
      t.classList.remove('show');
    }, 1800);
  }

  // Copy buttons: data-copy="#id" copies that element's text, data-copy-text copies the value.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy],[data-copy-text]');
    if (!btn) return;
    e.preventDefault();
    var text = btn.getAttribute('data-copy-text');
    if (text === null) {
      var el = document.querySelector(btn.getAttribute('data-copy'));
      text = el ? el.textContent : '';
    }
    var done = function () {
      toast(btn.getAttribute('data-copied') || 'Copied');
    };
    if (navigator.clipboard && window.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallback(text);
        done();
      });
    } else {
      fallback(text);
      done();
    }
  });

  function fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  // Mobile menu
  var toggle = document.querySelector('.menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var side = document.querySelector('.side');
      var open = side.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Sortable tables: <table data-sortable>, header buttons .sort
  document.querySelectorAll('table[data-sortable]').forEach(function (table) {
    var heads = table.querySelectorAll('th');
    heads.forEach(function (th, idx) {
      var b = th.querySelector('button.sort');
      if (!b) return;
      b.addEventListener('click', function () {
        var dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        heads.forEach(function (h) {
          h.removeAttribute('aria-sort');
        });
        th.setAttribute('aria-sort', dir);
        var body = table.tBodies[0];
        var rows = Array.prototype.slice.call(body.rows);
        var num = th.classList.contains('num');
        rows.sort(function (a, b2) {
          var x = a.cells[idx].getAttribute('data-v') || a.cells[idx].textContent.trim();
          var y = b2.cells[idx].getAttribute('data-v') || b2.cells[idx].textContent.trim();
          var r = num ? Number(x) - Number(y) : x.localeCompare(y);
          return dir === 'ascending' ? r : -r;
        });
        rows.forEach(function (r) {
          body.appendChild(r);
        });
      });
    });
  });

  // Client-side filter: <input data-filter="#tableId"> hides rows that don't contain the text.
  document.querySelectorAll('[data-filter]').forEach(function (input) {
    var target = document.querySelector(input.getAttribute('data-filter'));
    if (!target) return;
    input.addEventListener('input', function () {
      var q = input.value.toLowerCase();
      target.querySelectorAll('[data-row]').forEach(function (row) {
        row.hidden = q !== '' && row.textContent.toLowerCase().indexOf(q) === -1;
      });
    });
  });

  // Confirm dangerous actions: <form data-confirm="...">
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Visibility cost estimate: live update when engines / repeats / prompts change.
  var est = document.querySelector('[data-estimate]');
  if (est) {
    var form = est.closest('form');
    var per = JSON.parse(est.getAttribute('data-estimate') || '{}');
    var update = function () {
      var engines = Array.prototype.slice
        .call(form.querySelectorAll('input[name=engines]:checked'))
        .map(function (i) {
          return i.value;
        });
      var repeats = Number((form.querySelector('[name=repeats]') || {}).value || 1);
      var promptsEl = form.querySelector('[name=prompts]');
      var prompts = promptsEl
        ? promptsEl.value.split('\n').filter(function (l) {
            return l.trim();
          }).length
        : Number(est.getAttribute('data-prompts') || 0);
      var total = 0;
      engines.forEach(function (e) {
        total += (per[e] || 0.01) * prompts * repeats;
      });
      est.textContent =
        engines.length * prompts * repeats + ' answers, about $' + total.toFixed(2) + ' (estimate)';
    };
    form.addEventListener('input', update);
    update();
  }

  // Live audit progress via Server-Sent Events: <div data-job="id" data-events="url">
  var job = document.querySelector('[data-job]');
  if (job && window.EventSource) {
    var log = job.querySelector('.log');
    var bar = job.querySelector('.progress');
    var fill = bar && bar.querySelector('span');
    var status = job.querySelector('[data-status]');
    var cancel = job.querySelector('[data-cancel]');
    var es = new EventSource(job.getAttribute('data-events'));
    var add = function (text, level) {
      if (!log) return;
      var line = document.createElement('div');
      if (level) line.className = level;
      line.textContent = text;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    };
    es.addEventListener('progress', function (ev) {
      var d = JSON.parse(ev.data);
      if (d.type === 'phase') {
        if (status) status.textContent = d.message || d.phase;
        add('> ' + d.phase + (d.message ? ': ' + d.message : ''));
      } else if (d.type === 'page') {
        var total = d.crawled + d.queued;
        if (fill && total) {
          bar.classList.remove('indeterminate');
          fill.style.width = Math.min(100, Math.round((d.crawled / total) * 100)) + '%';
        }
        if (status) status.textContent = 'Crawled ' + d.crawled + ' pages, ' + d.queued + ' queued';
        add(d.status + ' ' + d.url);
      } else if (d.type === 'log') {
        add(d.message, d.level);
      }
    });
    es.addEventListener('done', function (ev) {
      var d = JSON.parse(ev.data);
      es.close();
      if (fill) fill.style.width = '100%';
      if (bar) bar.classList.remove('indeterminate');
      if (cancel) cancel.hidden = true;
      if (d.error) {
        if (status) status.textContent = 'Failed: ' + d.error;
        add(d.error, 'error');
      } else if (d.redirect) {
        if (status) status.textContent = 'Done. Opening the results.';
        window.location.href = d.redirect;
      }
    });
    es.onerror = function () {
      if (status && es.readyState === 2) status.textContent = 'Lost the connection to the dashboard.';
    };
  }
})();
