#!/bin/zsh
export PATH="$HOME/.local/bin:$PATH"
cd ~/Grow/TrainingVideos
b=$1
/Library/Frameworks/Python.framework/Versions/3.10/bin/whisper work/$b/audio.wav --model base.en --language en --word_timestamps True --output_format all --output_dir work/$b > work/$b/whisper.log 2>&1
echo DONE $b
