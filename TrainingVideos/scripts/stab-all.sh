#!/bin/zsh
cd ~/Grow/TrainingVideos
until grep -q wrote work/raw-02_10-35/stab.log; do sleep 15; done
for r in raw-03_10-46 raw-05_11-00 raw-04_10-51 raw-06_11-07; do
  python3 scripts/stabilize.py work/$r/clean.mp4 work/$r/clean-stab.mp4 > work/$r/stab.log 2>&1 && echo "STAB OK $r" || echo "STAB FAIL $r"
done
echo STABDONE
