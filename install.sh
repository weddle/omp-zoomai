#!/usr/bin/env bash
# Install the zoom-ai omp extension into a project or into the omp agent dir.
#   ./install.sh                         -> ./.omp/extensions/zoom-ai           (current dir = project)
#   ./install.sh --project DIR           -> DIR/.omp/extensions/zoom-ai
#   ./install.sh --global                -> ${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/extensions/zoom-ai
#   ./install.sh --agent-dir DIR         -> DIR/extensions/zoom-ai               (e.g. ~/.omp/profiles/NAME/agent)
# Options:
#   --link         symlink instead of copy (follows updates to this checkout)
#   --with-config  project installs only: write .omp/config.yml with the judge role + Jev fallback,
#                  ONLY if that file does not exist yet (an existing config is never edited)
#   --uninstall    remove the installed extension from the chosen target (config is left alone)
# Never writes keys and never edits an existing config.yml.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/extension/zoom-ai"
mode=project; project="$PWD"; agent_dir=""; link=0; with_config=0; uninstall=0
while [ $# -gt 0 ]; do
	case "$1" in
		--project) mode=project; project="${2:?--project needs a directory}"; shift 2 ;;
		--global) mode=agent; agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"; shift ;;
		--agent-dir) mode=agent; agent_dir="${2:?--agent-dir needs a directory}"; shift 2 ;;
		--link) link=1; shift ;;
		--with-config) with_config=1; shift ;;
		--uninstall) uninstall=1; shift ;;
		-h|--help) sed -n '2,13p' "$0"; exit 0 ;;
		*) echo "install.sh: unknown argument: $1" >&2; exit 64 ;;
	esac
done
if [ "$mode" = project ]; then
	project="$(cd "$project" && pwd)"; omp_dir="$project/.omp"; dest="$omp_dir/extensions/zoom-ai"
else
	omp_dir=""; dest="$agent_dir/extensions/zoom-ai"
fi

if [ "$uninstall" = 1 ]; then
	if [ -L "$dest" ] || [ -e "$dest" ]; then rm -rf -- "$dest"; echo "removed $dest"; else echo "nothing installed at $dest"; fi
	echo "If you added 'judge: zoom-ai/...' to an omp config.yml, remove that line yourself (install.sh never edits config)."
	exit 0
fi

[ -f "$src/index.ts" ] || { echo "install.sh: $src/index.ts not found" >&2; exit 1; }
mkdir -p "$(dirname "$dest")"
if [ -L "$dest" ] || [ -e "$dest" ]; then rm -rf -- "$dest"; fi
if [ "$link" = 1 ]; then ln -s "$src" "$dest"; else mkdir -p "$dest" && cp "$src"/*.ts "$dest"/; fi
echo "installed zoom-ai extension -> $dest$([ "$link" = 1 ] && echo " (symlink)")"

snippet='modelRoles:
  judge: zoom-ai/zoom-decisions-pro
retry:
  fallbackChains:
    judge:
      - typesafe/jev-1.13.0'
if [ "$with_config" = 1 ] && [ -n "$omp_dir" ]; then
	if [ -e "$omp_dir/config.yml" ]; then
		echo "left existing $omp_dir/config.yml untouched; merge this yourself:"; echo "$snippet"
	else
		printf '%s\n' "# Written by omp-zoomai install.sh. Inert unless ZOOM_AI_ENABLE=1 and ZOOM_AI_API_KEY are set;" \
			"# then Zoom judges first and Jev is the fallback." "$snippet" >"$omp_dir/config.yml"
		echo "wrote $omp_dir/config.yml"
	fi
else
	echo "To use it as the judge (Jev fallback), add to the omp config.yml:"; echo "$snippet"
fi
echo "Enable per run: ZOOM_AI_ENABLE=1 ZOOM_AI_API_KEY=... omp ..."
