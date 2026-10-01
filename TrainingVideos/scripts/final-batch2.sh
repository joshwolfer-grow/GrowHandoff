#!/bin/zsh
cd ~/Grow/TrainingVideos
until grep -q BATCHDONE work/final-batch.log; do sleep 20; done
for r in raw-02_10-35 raw-03_10-46; do
  echo "== redo $r $(date)"; python3 scripts/assemble.py work/$r > work/$r/assemble3.log 2>&1 && python3 scripts/qa-stills.py work/$r >> work/$r/assemble3.log 2>&1 && echo "OK $r" || echo "FAIL $r"
done
echo BATCH2DONE
