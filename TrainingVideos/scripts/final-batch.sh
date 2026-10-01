#!/bin/zsh
cd ~/Grow/TrainingVideos
for r in raw-02_10-35 raw-03_10-46 raw-05_11-00 raw-04_10-51 raw-06_11-07; do
  until grep -q wrote work/$r/stab.log 2>/dev/null; do sleep 20; done
  echo "== $r $(date)"; python3 scripts/assemble.py work/$r > work/$r/assemble2.log 2>&1 && python3 scripts/qa-stills.py work/$r >> work/$r/assemble2.log 2>&1 && echo "OK $r" || echo "FAIL $r"
done
echo BATCHDONE
