#!/bin/zsh
cd ~/Grow/TrainingVideos
ls work | grep '^raw-' | xargs -P 2 -n 1 scripts/transcribe-one.sh
echo ALLDONE
