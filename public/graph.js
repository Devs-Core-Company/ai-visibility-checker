// AI Visibility Checker: internal link graph (canvas, force layout, no libraries).
(function () {
  'use strict';
  var canvas = document.getElementById('site-graph');
  if (!canvas || !canvas.getContext) return;
  var status = document.getElementById('site-graph-status');
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var nodes = [], edges = [], view = { x: 0, y: 0, k: 1 }, hover = null, drag = null;

  function colour(n) {
    if (n.status >= 400 || n.status === 0) return '#f0616d';
    if (n.status >= 300) return '#9aa4ae';
    if (n.depth < 0) return '#f0616d';
    if (n.depth <= 1) return '#0092d3';
    if (n.depth <= 3) return '#5fd69b';
    return '#f2c14e';
  }

  function layout(steps) {
    var k = Math.sqrt((W * H) / Math.max(1, nodes.length)) * 0.6;
    for (var s = 0; s < steps; s++) {
      var t = 1 - s / steps;
      for (var i = 0; i < nodes.length; i++) { nodes[i].dx = 0; nodes[i].dy = 0; }
      // Repulsion (sampled for big graphs).
      var stride = nodes.length > 600 ? 3 : 1;
      for (i = 0; i < nodes.length; i++) {
        var a = nodes[i];
        for (var j = (i % stride) + i + 1; j < nodes.length; j += stride) {
          var b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01;
          var f = (k * k) / d2;
          a.dx += dx * f; a.dy += dy * f; b.dx -= dx * f; b.dy -= dy * f;
        }
      }
      for (i = 0; i < edges.length; i++) {
        var u = nodes[edges[i][0]], v = nodes[edges[i][1]];
        var ex = u.x - v.x, ey = u.y - v.y, d = Math.sqrt(ex * ex + ey * ey) + 0.01, g = d / k;
        u.dx -= ex * g * 0.5; u.dy -= ey * g * 0.5; v.dx += ex * g * 0.5; v.dy += ey * g * 0.5;
      }
      for (i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.dx -= n.x * 0.01; n.dy -= n.y * 0.01; // gravity to the centre
        var m = Math.sqrt(n.dx * n.dx + n.dy * n.dy) || 1, lim = 12 * t + 0.5;
        n.x += (n.dx / m) * Math.min(m, lim); n.y += (n.dy / m) * Math.min(m, lim);
      }
    }
  }

  function toScreen(n) { return [W / 2 + (n.x + view.x) * view.k, H / 2 + (n.y + view.y) * view.k]; }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(154,164,174,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < edges.length; i++) {
      var a = toScreen(nodes[edges[i][0]]), b = toScreen(nodes[edges[i][1]]);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i], p = toScreen(n);
      ctx.fillStyle = colour(n);
      ctx.beginPath();
      ctx.arc(p[0], p[1], n.r * Math.max(0.6, Math.sqrt(view.k)), 0, Math.PI * 2);
      ctx.fill();
    }
    if (hover) {
      var hp = toScreen(hover);
      var label = hover.url.replace(/^https?:\/\/[^/]+/, '') || '/';
      label += '  · depth ' + hover.depth + ' · ' + hover.inlinks + ' inlinks · ' + hover.issues + ' issues';
      ctx.font = '12px system-ui, sans-serif';
      var w = ctx.measureText(label).width + 12;
      var x = Math.min(hp[0] + 10, W - w - 4), y = Math.max(hp[1] - 28, 4);
      ctx.fillStyle = 'rgba(16,16,19,0.92)'; ctx.fillRect(x, y, w, 22);
      ctx.fillStyle = '#e8e8e8'; ctx.fillText(label, x + 6, y + 15);
    }
  }

  function pick(ev) {
    var r = canvas.getBoundingClientRect();
    var mx = ((ev.clientX - r.left) / r.width) * W, my = ((ev.clientY - r.top) / r.height) * H;
    var best = null, bd = 144;
    for (var i = 0; i < nodes.length; i++) {
      var p = toScreen(nodes[i]), d = (p[0] - mx) * (p[0] - mx) + (p[1] - my) * (p[1] - my);
      if (d < bd) { bd = d; best = nodes[i]; }
    }
    return { node: best, mx: mx, my: my };
  }

  canvas.addEventListener('mousemove', function (ev) {
    if (drag) {
      var r = canvas.getBoundingClientRect();
      view.x += (((ev.clientX - drag.x) / r.width) * W) / view.k;
      view.y += (((ev.clientY - drag.y) / r.height) * H) / view.k;
      drag = { x: ev.clientX, y: ev.clientY, moved: true };
      draw();
      return;
    }
    var h = pick(ev).node;
    if (h !== hover) { hover = h; canvas.style.cursor = h ? 'pointer' : 'grab'; draw(); }
  });
  canvas.addEventListener('mousedown', function (ev) { drag = { x: ev.clientX, y: ev.clientY, moved: false }; });
  window.addEventListener('mouseup', function (ev) {
    if (drag && !drag.moved) {
      var n = pick(ev).node;
      if (n) window.location.href = canvas.getAttribute('data-page') + encodeURIComponent(n.url);
    }
    drag = null;
  });
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    view.k = Math.min(8, Math.max(0.2, view.k * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    draw();
  }, { passive: false });

  fetch(canvas.getAttribute('data-src'), { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      nodes = data.nodes.map(function (n, i) {
        var ang = i * 2.399963, rad = 8 * Math.sqrt(i + 1);
        n.x = Math.cos(ang) * rad; n.y = Math.sin(ang) * rad;
        n.r = 2.5 + Math.min(10, Math.sqrt(n.inlinks || 0));
        return n;
      });
      edges = data.edges;
      layout(nodes.length > 800 ? 120 : 250);
      draw();
      if (status)
        status.textContent = nodes.length + ' pages, ' + edges.length + ' internal links' +
          (data.truncated ? ' (the largest pages only)' : '') +
          (data.hasEdges ? '' : '. Links are stored from this version on: re-run the audit to see them.');
    })
    .catch(function () { if (status) status.textContent = 'Could not load the graph.'; });
})();
