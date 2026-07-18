/* Light/dark theme handling.
 *
 * Loaded as a blocking script in <head> on every page so the saved theme is
 * applied to <html> before the body paints (no flash of the wrong theme).
 * When no explicit choice is stored, the CSS falls back to the OS preference
 * via prefers-color-scheme, so we only set data-theme once the user has
 * actually picked a side.
 */
(function () {
  var KEY = "wk-theme";
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ }
  }

  // Apply as early as possible (runs before <body> exists).
  var pref = stored();
  if (pref === "light" || pref === "dark") {
    root.setAttribute("data-theme", pref);
  }

  function currentIsLight() {
    var attr = root.getAttribute("data-theme");
    if (attr === "light") return true;
    if (attr === "dark") return false;
    // No explicit choice — mirror the OS preference.
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    save(theme);
    updateButton();
  }

  var btn = null;
  function updateButton() {
    if (!btn) return;
    var light = currentIsLight();
    // Show the icon for the mode you'd switch TO.
    btn.textContent = light ? "🌙" : "☀️";
    btn.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
    btn.setAttribute("title", light ? "Switch to dark mode" : "Switch to light mode");
  }

  function injectButton() {
    var header = document.querySelector("header.site");
    if (!header || header.querySelector(".theme-toggle")) return;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    // If there's no lock-banner to push things right, do it ourselves.
    if (!header.querySelector("#lock-banner")) btn.classList.add("push");

    btn.addEventListener("click", function () {
      apply(currentIsLight() ? "dark" : "light");
    });

    header.appendChild(btn);
    updateButton();
  }

  // Keep the icon in sync if the OS preference changes while on "auto".
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onChange = function () { if (!stored()) updateButton(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectButton);
  } else {
    injectButton();
  }
})();
