import {
  DEFAULT_THEME_ID,
  getThemePreset,
  themeColorsToCSSVars,
} from "../themes";

export type ColorMode = "system" | "light" | "dark";

function resolveMode(mode: ColorMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** 注入归档主题 CSS 变量（Pi 原生壳，不依赖 OpenCode store） */
export function applyTheme(
  themeId: string = DEFAULT_THEME_ID,
  mode: ColorMode = "system",
): "light" | "dark" {
  const preset = getThemePreset(themeId) ?? getThemePreset(DEFAULT_THEME_ID)!;
  const resolved = resolveMode(mode);
  const colors = resolved === "dark" ? preset.dark : preset.light;
  const css = themeColorsToCSSVars(colors);

  let el = document.getElementById("piui-theme-vars");
  if (!el) {
    el = document.createElement("style");
    el.id = "piui-theme-vars";
    document.head.appendChild(el);
  }
  el.textContent = `:root {\n  ${css}\n}`;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  return resolved;
}
