// Sets the theme from the system setting before the first paint (a file, not an inline script,
// because the page's content security policy forbids inline scripts).
(function () {
  var query = window.matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    if (query.matches) document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }
  apply();
  if (query.addEventListener) query.addEventListener("change", apply);
})();
