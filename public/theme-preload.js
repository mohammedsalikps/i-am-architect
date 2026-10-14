// The saved light/dark theme (src/ui/theme.ts, same storage key), applied to <html>
// before the first paint so a reload never flashes the other theme. A same-origin
// file, not an inline script: the production Content-Security-Policy allows none.
(function () {
  var theme = "light";
  try {
    var saved = window.localStorage.getItem("iarchitect.theme");
    if (saved === "dark" || saved === "light") theme = saved;
  } catch (error) {
    // Storage refused (some privacy modes): the default.
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
