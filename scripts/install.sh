#!/bin/bash
# dsh-browser 安装：从本地 checkout 构建并安装。
# dsh-browser installer: build and install from a local checkout.
# The local address can be discovered; the bridge credential must be entered in the extension.
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

print_step() {
  printf '\n[%s/4] %s\n' "$1" "$2"
  printf '      %s\n' "$3"
}

print_pair() {
  printf '%s\n' "$1"
  printf '   %s\n' "$2"
}

fail_pair() {
  printf '\n错误：%s\n' "$1" >&2
  printf 'Error: %s\n' "$2" >&2
  exit 1
}

has_workspace() {
  local candidate="$1"
  [ -f "$candidate/package.json" ] &&
    [ -f "$candidate/pnpm-lock.yaml" ] &&
    [ -f "$candidate/extensions/dsh-browser/package.json" ] &&
    [ -f "$candidate/packages/browser/bridge-browser/package.json" ] &&
    [ -f "$candidate/scripts/install.sh" ]
}

workspace_root_from_script() {
  local script_path="${BASH_SOURCE[0]:-}"
  local script_dir
  local candidate

  [ -n "$script_path" ] && [ -f "$script_path" ] || return 1
  script_dir="$(cd "$(dirname "$script_path")" && pwd)"
  candidate="$(cd "$script_dir/.." && pwd)"
  has_workspace "$candidate" || return 1
  printf '%s\n' "$candidate"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_pair "$2" "$3"
}

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

has_display() {
  [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]
}

copy_to_clipboard() {
  local text="$1"

  if is_macos; then
    command -v pbcopy >/dev/null 2>&1 || return 1
    printf '%s' "$text" | pbcopy && return 0
    return 1
  fi

  # The X11/Wayland helpers need a display, and they fork a daemon that keeps owning the
  # selection; keep its stdio off the terminal so the installer's own output stays readable.
  has_display || return 1
  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$text" | wl-copy >/dev/null 2>&1 && return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$text" | xclip -selection clipboard >/dev/null 2>&1 && return 0
  fi
  if command -v xsel >/dev/null 2>&1; then
    printf '%s' "$text" | xsel --clipboard --input >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Echoes a launch target for the local Chrome/Chromium install: on macOS an app bundle path
# or a LaunchServices app name (both accepted by `open -a`), on Linux an executable on PATH.
find_browser_target() {
  local name

  if is_macos; then
    local dir app
    for dir in "/Applications" "$HOME/Applications"; do
      for name in "Google Chrome" "Google Chrome Canary" "Chromium"; do
        app="$dir/$name.app"
        if [ -x "$app/Contents/MacOS/$name" ]; then
          printf '%s\n' "$app"
          return 0
        fi
      done
    done

    # Fallback: recognize apps registered with LaunchServices in non-standard locations.
    for name in "Google Chrome" "Google Chrome Canary" "Chromium"; do
      if open -Ra "$name" >/dev/null 2>&1; then
        printf '%s\n' "$name"
        return 0
      fi
    done
    return 1
  fi

  for name in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$name" >/dev/null 2>&1; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  return 1
}

open_chrome_extensions() {
  local url="chrome://extensions"
  local target
  local pid

  target="$(find_browser_target)" || target=""

  if is_macos; then
    if [ -n "$target" ]; then
      open -a "$target" "$url" >/dev/null 2>&1 && return 0
    fi
    open -b com.google.Chrome "$url" >/dev/null 2>&1 && return 0
    return 1
  fi

  has_display || return 1
  if [ -n "$target" ]; then
    # Launch detached: a first run starts a foreground browser process that would otherwise
    # block the installer until the user quits it.
    "$target" "$url" >/dev/null 2>&1 </dev/null &
    pid=$!
    # Forwarding the URL to a running instance exits almost immediately; a fresh window keeps
    # running. Wait briefly so a browser that fails to start is reported as such.
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    wait "$pid" && return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 </dev/null && return 0
  fi
  return 1
}

print_browser_install_hint() {
  if is_macos; then
    if command -v brew >/dev/null 2>&1; then
      print_pair "请手动安装：brew install --cask google-chrome" "Install it manually: brew install --cask google-chrome"
    else
      print_pair "请手动安装 Google Chrome：https://www.google.com/chrome/" "Install Google Chrome manually: https://www.google.com/chrome/"
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    print_pair "请手动安装：sudo apt-get update && sudo apt-get install -y chromium-browser（或 chromium）" "Install it manually: sudo apt-get update && sudo apt-get install -y chromium-browser (or chromium)"
  elif command -v dnf >/dev/null 2>&1; then
    print_pair "请手动安装：sudo dnf install -y chromium" "Install it manually: sudo dnf install -y chromium"
  elif command -v yum >/dev/null 2>&1; then
    print_pair "请手动安装：sudo yum install -y chromium" "Install it manually: sudo yum install -y chromium"
  elif command -v zypper >/dev/null 2>&1; then
    print_pair "请手动安装：sudo zypper --non-interactive install chromium" "Install it manually: sudo zypper --non-interactive install chromium"
  elif command -v pacman >/dev/null 2>&1; then
    print_pair "请手动安装：sudo pacman -S --noconfirm chromium" "Install it manually: sudo pacman -S --noconfirm chromium"
  else
    print_pair "未找到可用的软件包管理器，请手动安装 Chrome 或 Chromium。" "No supported package manager was found; install Chrome or Chromium manually."
  fi
}

install_browser() {
  local sudo_cmd=""

  if is_macos; then
    if command -v brew >/dev/null 2>&1; then
      brew install --cask google-chrome || true
    else
      print_browser_install_hint
    fi
    return 0
  fi

  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo_cmd="sudo"
    else
      print_pair "需要管理员权限才能安装浏览器。" "Administrator rights are required to install a browser."
      print_browser_install_hint
      return 0
    fi
  fi

  if command -v apt-get >/dev/null 2>&1; then
    $sudo_cmd apt-get update || true
    $sudo_cmd apt-get install -y chromium-browser || $sudo_cmd apt-get install -y chromium || true
  elif command -v dnf >/dev/null 2>&1; then
    $sudo_cmd dnf install -y chromium || true
  elif command -v yum >/dev/null 2>&1; then
    $sudo_cmd yum install -y chromium || true
  elif command -v zypper >/dev/null 2>&1; then
    $sudo_cmd zypper --non-interactive install chromium || true
  elif command -v pacman >/dev/null 2>&1; then
    $sudo_cmd pacman -S --noconfirm chromium || true
  else
    print_browser_install_hint
  fi
  return 0
}

ensure_chrome() {
  if find_browser_target >/dev/null 2>&1; then
    return 0
  fi

  print_pair "未检测到 Chrome/Chromium 浏览器。" "No Chrome/Chromium browser was detected."

  # Installing a browser system-wide is a surprising side effect for a one-line installer,
  # so it stays opt-in and never runs sudo on its own.
  if [ "${DSH_INSTALL_BROWSER:-0}" != "1" ]; then
    print_browser_install_hint
    print_pair "安装后重新运行本脚本；或设置 DSH_INSTALL_BROWSER=1 让脚本尝试自动安装。" "Install it and rerun this script, or set DSH_INSTALL_BROWSER=1 to let the installer attempt it."
    return 1
  fi

  print_pair "DSH_INSTALL_BROWSER=1，尝试自动安装……" "DSH_INSTALL_BROWSER=1 is set; attempting to install…"
  install_browser

  if find_browser_target >/dev/null 2>&1; then
    return 0
  fi
  print_pair "自动安装未完成，本次安装会继续，但需要你手动安装浏览器后再加载扩展。" "Automatic browser installation did not complete; continuing, but install a browser manually before loading the extension."
  return 1
}

if ROOT="$(workspace_root_from_script)"; then
  :
else
  fail_pair "请从 DSH Stride 的完整源码目录运行 scripts/install.sh。" "Run scripts/install.sh from a complete DSH Stride checkout."
fi

EXT="$ROOT/extensions/dsh-browser"
PLUGIN="$ROOT/packages/browser/bridge-browser"
WEB_PROFILE_MANIFEST="$DSH_HOME_DIR/profiles/web/package.json"
BRIDGE_PLUGIN="@eilyeee/dsh-stride-browser-bridge"
LEGACY_PLUGINS=("@yuxianglin/dsh-bridge-browser" "@deepseek-ai/dsh-bridge-browser")

profile_has_dependency() {
  local manifest="$1"
  local package_name="$2"

  [ -f "$manifest" ] || return 1
  node -e '
    const manifest = require(process.argv[1]);
    process.exit(Object.hasOwn(manifest.dependencies ?? {}, process.argv[2]) ? 0 : 1);
  ' "$manifest" "$package_name"
}

require_command pnpm "未找到 pnpm；请先启用 Corepack 或安装 pnpm。" "pnpm was not found; enable Corepack or install pnpm first."
require_command node "未找到 Node.js；请先安装受支持的 Node.js 版本。" "Node.js was not found; install a supported Node.js version first."
require_command rsync "未找到 rsync；请先安装 rsync。" "rsync was not found; install rsync first."

print_step 1 "构建浏览器桥" "Build the browser bridge"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null 2>&1)
(cd "$ROOT" && pnpm --filter @eilyeee/dsh-stride-browser-bridge run build >/dev/null 2>&1)

print_step 2 "注册到本机 web profile" "Register with the local web profile"
# Keep the existing registration until the new package has installed successfully.
(cd "$ROOT" && pnpm exec dsh plugin --profile web add -w "$BRIDGE_PLUGIN@link:$PLUGIN" >/dev/null)
for legacy_plugin in "${LEGACY_PLUGINS[@]}"; do
  if profile_has_dependency "$WEB_PROFILE_MANIFEST" "$legacy_plugin"; then
    (cd "$ROOT" && pnpm exec dsh plugin --profile web remove "$legacy_plugin" >/dev/null)
  fi
done

print_step 3 "构建 Chrome 扩展" "Build the Chrome extension"
(cd "$ROOT" && pnpm --filter dsh-browser-extension run build >/dev/null 2>&1)

print_step 4 "准备扩展并打开 Chrome" "Prepare the extension and open Chrome"
ensure_chrome || true
DIST_DIR="$DSH_HOME_DIR/browser-extension"
if [ -f "$DIST_DIR/manifest.json" ]; then
  IS_UPDATE=1
else
  IS_UPDATE=0
fi
mkdir -p "$DIST_DIR"
rsync -a --delete-after "$EXT/dist/" "$DIST_DIR/"
if copy_to_clipboard "$DIST_DIR"; then
  CLIPBOARD_READY=1
else
  CLIPBOARD_READY=0
fi

if open_chrome_extensions; then
  CHROME_OPENED=1
else
  CHROME_OPENED=0
fi
printf '\n'
if [ "$CHROME_OPENED" -ne 1 ]; then
  print_pair "无法自动打开 Chrome，请手动打开浏览器并在地址栏输入 chrome://extensions。" "Could not open Chrome automatically; open the browser and type chrome://extensions in the address bar."
fi
if [ "$IS_UPDATE" -eq 1 ]; then
  print_pair "检测到已有扩展目录，文件已安全更新。" "Existing extension directory detected; its files were updated safely."
  print_pair "打开 Google Chrome（注意不是 Edge/Firefox）：" "Open Google Chrome (not Edge/Firefox):"
  printf '\n'
  print_pair "    地址栏输入 chrome://extensions" "    Type chrome://extensions in the address bar"
  printf '\n'
  print_pair "如果页面上已有“dsh 浏览器助手”卡片：" "If the “dsh Browser Assistant” card is already listed:"
  print_pair "  点击卡片上的“重新加载”按钮，让扩展加载新文件。" "  Click “Reload” on that card so it picks up the updated files."
  printf '\n'
  print_pair "如果没有该卡片（例如从未加载过）：" "If the card is not listed (e.g. it was never loaded):"
  print_pair "  打开右上角 “开发者模式”" "  Enable “Developer mode” in the upper-right corner"
  print_pair "  点左上角 “加载已解压的扩展程序”" "  Click “Load unpacked” in the upper-left corner"
  print_pair "  选择这个目录：" "  Select this directory:"
  printf '   %s\n' "$DIST_DIR"
  printf '\n'
  print_pair "出现 “dsh 浏览器助手” 卡片即成功。" "When the “dsh Browser Assistant” card appears, it is loaded."
else
  if [ "$CHROME_OPENED" -eq 1 ]; then
    print_pair "Chrome 扩展管理页已打开，请完成以下操作：" "Chrome Extensions is open. Complete these steps:"
  else
    print_pair "请在 Chrome 扩展管理页完成以下操作：" "Complete these steps on the Chrome Extensions page:"
  fi
  printf '\n'
  print_pair "1. 开启右上角的“开发者模式”" "Enable “Developer mode” in the upper-right corner"
  print_pair "2. 点击“加载已解压的扩展程序”" "Click “Load unpacked”"
  if is_macos; then
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "3. 按 Cmd+Shift+G，粘贴以下路径（已复制到剪贴板）：" "Press Cmd+Shift+G and paste this path (already copied):"
    else
      print_pair "3. 按 Cmd+Shift+G，粘贴以下路径：" "Press Cmd+Shift+G and paste this path:"
    fi
  else
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "3. 粘贴以下路径（已复制到剪贴板）：" "Paste this path (already copied):"
    else
      print_pair "3. 复制并粘贴以下路径：" "Copy and paste this path:"
    fi
  fi
  printf '   %s\n' "$DIST_DIR"
fi

printf '\n'
print_pair "加载完成后：" "After loading the extension:"
print_pair "• 点击工具栏中的 DeepSeek 鲸鱼图标，打开侧边栏" "Click the DeepSeek whale icon in the toolbar to open the side panel"
print_pair "• 启动 Host 后，在仓库根目录运行 pnpm run pair:browser，将一次性配对码填入侧栏设置" "After starting the Host, run pnpm run pair:browser from the repository and enter the one-time code in side-panel settings"
printf '• 启动固定版本：cd %q && pnpm start\n' "$ROOT"
printf '   Start the pinned version: cd %q && pnpm start\n' "$ROOT"
printf '\n'
