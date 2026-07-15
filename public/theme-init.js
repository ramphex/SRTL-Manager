(() => {
  const key = "srtl-theme";
  const stored = window.localStorage.getItem(key);
  const preference = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = preference === "dark" || (preference === "system" && systemDark) ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
})();
