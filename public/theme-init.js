(() => {
  const key = "srtl-theme";
  let stored = null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    // Restricted storage should not prevent the application shell from rendering.
  }
  const preference = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = preference === "dark" || (preference === "system" && systemDark) ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.querySelector("#srtl-theme-color")?.setAttribute("content", theme === "dark" ? "#070b11" : "#c0c8d3");
})();
