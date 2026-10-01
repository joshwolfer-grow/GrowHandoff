"""Where the "Grow - Corporate" shared drive is mounted on this Mac.

Google Drive for Desktop mounts it under the signed-in account's email, so the
path is different for every person who runs these scripts. GROW_DRIVE overrides;
otherwise the first GoogleDrive-* account that has the shared drive wins. When
nothing is mounted the returned path simply does not exist, and callers already
treat that as "Drive not mounted".
"""
import glob, os

def grow_drive():
    env = os.environ.get('GROW_DRIVE')
    if env:
        return os.path.expanduser(env)
    hits = sorted(glob.glob(os.path.expanduser(
        '~/Library/CloudStorage/GoogleDrive-*/Shared drives/Grow - Corporate')))
    return hits[0] if hits else os.path.expanduser(
        '~/Library/CloudStorage/GoogleDrive-NOT-MOUNTED/Shared drives/Grow - Corporate')
