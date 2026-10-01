#!/bin/zsh
# make-clean.sh <raw-dir-name>  : cutlist.json -> clean.mp4 -> clean transcript
export PATH="$HOME/.local/bin:$PATH"
cd ~/Grow/TrainingVideos
d=work/$1
python3 scripts/apply-cutlist.py $d > $d/render.log 2>&1 || { echo RENDER_FAIL $1; exit 1; }
cd $d
ffmpeg -v error -y -i clean.mp4 -vn -ac 1 -ar 16000 clean.wav
/Library/Frameworks/Python.framework/Versions/3.10/bin/whisper clean.wav --model base.en --language en --word_timestamps True --output_format all --output_dir . > clean-whisper.log 2>&1
echo CLEANDONE >> clean-whisper.log
echo CLEANDONE $1
