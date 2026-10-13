// Small progressive enhancements.
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-href]');
  if (el) { window.location.href = el.getAttribute('data-href'); }
  var tab = e.target.closest('[data-tab]');
  if (tab) {
    var root = tab.closest('[data-tabs]');
    root.querySelectorAll('[data-tab]').forEach(function (t) { t.classList.toggle('is-active', t === tab); });
    root.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== tab.getAttribute('data-tab'); });
  }
});
