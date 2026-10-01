#!/bin/zsh
# usage: pexels-fetch.sh "query" [photos|videos] [count]
source ~/Grow/TrainingVideos/.env
Q="$1"; TYPE="${2:-photos}"; N="${3:-6}"
OUT=~/Grow/TrainingVideos/assets/stock
mkdir -p "$OUT"
if [[ "$TYPE" == "videos" ]]; then
  curl -s -H "Authorization: $PEXELS_API_KEY" "https://api.pexels.com/videos/search?query=${Q// /+}&per_page=$N&orientation=landscape" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for v in d.get('videos',[]):
    files=[f for f in v['video_files'] if f.get('width')==1920] or v['video_files']
    print(v['id'], v['duration'], files[0]['link'])
"
else
  curl -s -H "Authorization: $PEXELS_API_KEY" "https://api.pexels.com/v1/search?query=${Q// /+}&per_page=$N&orientation=landscape" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('photos',[]):
    print(p['id'], p['src']['large2x'])
"
fi
