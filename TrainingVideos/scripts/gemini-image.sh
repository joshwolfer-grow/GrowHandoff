#!/bin/zsh
# usage: gemini-image.sh "prompt" output.png
source ~/Grow/TrainingVideos/.env
PROMPT="$1"; OUT="${2:-out.png}"
curl -s --max-time 120 -X POST "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent" \
 -H "x-goog-api-key: $GEMINI_API_KEY" -H 'Content-Type: application/json' \
 -d "$(python3 -c "import json,sys;print(json.dumps({'contents':[{'parts':[{'text':sys.argv[1]}]}],'generationConfig':{'responseModalities':['IMAGE'],'imageConfig':{'aspectRatio':'16:9'}}}))" "$PROMPT")" \
| python3 -c "
import json,base64,sys
d=json.load(sys.stdin)
for p in d.get('candidates',[{}])[0].get('content',{}).get('parts',[]):
    if 'inlineData' in p:
        open(sys.argv[1],'wb').write(base64.b64decode(p['inlineData']['data'])); print('saved',sys.argv[1]); break
else: print('FAIL', str(d)[:200])
" "$OUT"
