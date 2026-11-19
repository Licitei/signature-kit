#!/bin/bash
set -euo pipefail

model=$1
oem=$2
psm=$3
repeats=$4
shift 4

for sample; do
    id=${sample%:*}
    dpi=${sample##*:}
    for ((trial = 1; trial <= repeats; trial++)); do
        before=$(date +%s%N)
        /usr/bin/time -v -o "/output/$id.$trial.time" \
            tesseract "/dataset/$id.pgm" "/output/$id.$trial" \
            --tessdata-dir "/models/$model" -l por --dpi "$dpi" --oem "$oem" --psm "$psm" tsv
        after=$(date +%s%N)
        printf '%s\t%s\t%s\n' "$id" "$trial" "$((after - before))"
    done
done
