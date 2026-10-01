# Sourced, not run. Sets GROW_DRIVE to the "Grow - Corporate" shared drive.
# Same rule as scripts/_drive.py: GROW_DRIVE wins, else the first mounted
# GoogleDrive-* account that has the shared drive (the path carries the
# signed-in email, so it differs per person).
if [ -z "${GROW_DRIVE:-}" ]; then
  for _d in "$HOME"/Library/CloudStorage/GoogleDrive-*/"Shared drives/Grow - Corporate"; do
    [ -d "$_d" ] && { GROW_DRIVE="$_d"; break; }
  done
  GROW_DRIVE="${GROW_DRIVE:-$HOME/Library/CloudStorage/GoogleDrive-NOT-MOUNTED/Shared drives/Grow - Corporate}"
fi
