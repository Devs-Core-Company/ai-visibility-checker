// Renders the patient stories page entirely on the client.
fetch('/data/stories.json').then(function (r) { return r.json(); }).then(function (d) {
  var app = document.getElementById('app');
  var html = '<h1>' + d.title + '</h1><p class="lead">' + d.intro + '</p>';
  d.stories.forEach(function (s) { html += '<h2>' + s.name + '</h2><p><strong>' + s.treatment + '.</strong> ' + s.text + '</p>'; });
  app.innerHTML = html;
});
