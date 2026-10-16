#!/bin/bash
# Double-click in Finder to run Pixi Editor in a visible Terminal window (handy to watch the log).
# Same as PixiEditor.app, which runs it in the background instead. Ctrl+C stops the editor.
exec "$(dirname "$0")/PixiEditor.app/Contents/MacOS/launcher" --console "$@"
