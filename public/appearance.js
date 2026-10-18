const themeKey = "openza-tasks-theme";
export function resolveTheme(preference, darkSystem) {
  return preference === "Dark" || preference === "System" && darkSystem ? "dark" : "light";
}
export function initializeAppearance() {
  const system = matchMedia("(prefers-color-scheme: dark)");
  let preference = "System";
  try { preference = localStorage.getItem(themeKey) || preference; } catch {}
  if (!["System", "Light", "Dark"].includes(preference)) preference = "System";
  const picker = document.getElementById("theme-preference");
  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(preference, system.matches);
    document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
    if (picker) picker.value = preference;
  };
  picker?.addEventListener("change", () => {
    preference = picker.value;
    try { localStorage.setItem(themeKey, preference); } catch {}
    apply();
  });
  system.addEventListener("change", apply);
  window.addEventListener("storage", event => {
    if (event.key === themeKey) { preference = event.newValue || "System"; apply(); }
  });
  apply();
}
if (typeof document !== "undefined") initializeAppearance();
