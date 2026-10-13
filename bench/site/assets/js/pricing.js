// Loads the price table from the API.
(function () {
  var box = document.getElementById('price-table');
  fetch(box.getAttribute('data-src')).then(function (r) { return r.json(); }).then(function (d) {
    var rows = d.items.map(function (i) { return '<tr><td>' + i.name + '</td><td>£' + i.price.toLocaleString('en-GB') + '</td></tr>'; }).join('');
    box.innerHTML = '<table><thead><tr><th>Treatment</th><th>Fee</th></tr></thead><tbody>' + rows + '</tbody></table>';
  });
})();
