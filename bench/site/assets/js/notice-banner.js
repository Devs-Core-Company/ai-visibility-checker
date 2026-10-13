// Shows a notice above the article shortly after load.
window.addEventListener('load', function () {
  setTimeout(function () {
    var main = document.getElementById('main');
    var b = document.createElement('div');
    b.className = 'notice-banner';
    b.textContent = 'Surgery two is closed on Friday afternoon for equipment servicing. Please call to rearrange if your appointment is affected.';
    main.insertBefore(b, main.firstChild);
  }, 600);
});
