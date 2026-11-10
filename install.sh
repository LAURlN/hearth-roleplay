#!/usr/bin/env bash
set -euo pipefail

repo_url="${HEARTH_REPO_URL:-https://github.com/LAURlN/hearth-roleplay.git}"
install_dir="${HEARTH_DIR:-$HOME/hearth}"
bin_dir="${HEARTH_BIN_DIR:-${PREFIX:-$HOME/.local}/bin}"

die() { printf 'Hearth: %s\n' "$*" >&2; exit 1; }

printf '\nInstalling Hearth…\n'
needs_packages=0
for executable in git node npm; do
  if ! command -v "$executable" >/dev/null 2>&1; then needs_packages=1; fi
done
if command -v node >/dev/null 2>&1 && ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then needs_packages=1; fi
if [[ "$needs_packages" == 1 ]]; then
  command -v pkg >/dev/null 2>&1 || die 'Install Git and Node 22+ (including npm), then run this installer again.'
  pkg update -y
  pkg install -y git nodejs-lts
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die 'Node 22 or newer is required.'

if [[ -e "$install_dir/.git" ]]; then
  actual_origin="$(git -C "$install_dir" remote get-url origin)"
  [[ "${actual_origin%.git}" == "${repo_url%.git}" ]] || die "The existing directory belongs to another repository: $install_dir. Set HEARTH_DIR to a different directory."
  [[ "$(git -C "$install_dir" branch --show-current)" == main ]] || die 'The existing checkout is not on main. Switch it to main before updating.'
  git -C "$install_dir" pull --ff-only
else
  git clone --branch main --single-branch -- "$repo_url" "$install_dir"
fi
install_dir="$(cd "$install_dir" && pwd -P)"
mkdir -p "$bin_dir"
if [[ -e "$bin_dir/hearth" ]] && ! grep -q '^# Hearth launcher$' "$bin_dir/hearth"; then
  die "An unrelated command already exists at $bin_dir/hearth. Choose another HEARTH_BIN_DIR."
fi
launcher_temp="$(mktemp "$bin_dir/.hearth.XXXXXX")"
trap 'if [[ -n "${launcher_temp:-}" && -f "$launcher_temp" ]]; then rm -- "$launcher_temp"; fi' EXIT
printf '#!%s\n# Hearth launcher\nexec bash %q "$@"\n' "$BASH" "$install_dir/scripts/termux-start.sh" > "$launcher_temp"
chmod 755 "$launcher_temp"
mv -f -- "$launcher_temp" "$bin_dir/hearth"
launcher_temp=''
printf '\nInstalled in %s\nStart again: hearth\nUpdate and start: hearth update\n' "$install_dir"
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to your PATH, or run %s/hearth directly.\n' "$bin_dir" "$bin_dir" ;; esac

if [[ "${HEARTH_NO_START:-0}" != 1 ]]; then
  # curl | bash supplies a pipe as stdin. Restore the terminal for a possible
  # first ChatGPT login and for normal foreground Ctrl+C handling.
  if { true < /dev/tty; } 2>/dev/null; then
    exec bash "$install_dir/scripts/termux-start.sh" < /dev/tty
  else
    exec bash "$install_dir/scripts/termux-start.sh"
  fi
fi
