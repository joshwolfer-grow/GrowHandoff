#!/bin/zsh
cd ~/Grow/TrainingVideos
until grep -q BATCH2DONE work/final-batch2.log; do sleep 20; done
r=raw-06_11-07; python3 scripts/assemble.py work/$r > work/$r/assemble3.log 2>&1 && python3 scripts/qa-stills.py work/$r >> work/$r/assemble3.log 2>&1 && echo "OK $r" || echo "FAIL $r"
echo BATCH3DONE
