#!/usr/bin/env bash
# Reproducibly convert the hand-authored SVG figures to tight, vector PDFs for
# LaTeX/arXiv. arXiv does not run Inkscape, so we ship the PDFs, not the SVGs.
#
# Pipeline (per figure): headless Chrome renders the SVG to a (letter-padded)
# vector PDF, then Ghostscript measures the content bounding box and crops to it
# with a small margin. Output stays vector with embedded fonts, which pdffonts
# can confirm.
#
# Requires: google-chrome-stable (or chromium), ghostscript (gs).
# Mirrors zeta-lite/docs/paper/tex/figures/build-fig1.sh.
set -euo pipefail
cd "$(dirname "$0")"

FIGS=(fig1-architecture fig2-schema fig3-context-assembly)
MARGIN=4  # pts around the content box

CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser)"

for name in "${FIGS[@]}"; do
  SRC="../../figures/${name}.svg"
  OUT="${name}.pdf"
  RAW="$(mktemp --suffix=.pdf)"

  # 1. SVG -> vector PDF (padded to letter by Chrome).
  "$CHROME" --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
    --print-to-pdf="$RAW" "file://$(readlink -f "$SRC")" >/dev/null 2>&1

  # 2. Measure the content bounding box.
  read -r x0 y0 x1 y1 < <(
    gs -q -dNOPAUSE -dBATCH -sDEVICE=bbox "$RAW" 2>&1 \
      | awk '/HiResBoundingBox/ {print $2, $3, $4, $5}'
  )

  # 3. Crop to the box + margin, preserving vector content.
  W=$(awk "BEGIN{printf \"%d\", ($x1-$x0)+2*$MARGIN + 0.999}")
  H=$(awk "BEGIN{printf \"%d\", ($y1-$y0)+2*$MARGIN + 0.999}")
  OX=$(awk "BEGIN{printf \"%.3f\", -($x0-$MARGIN)}")
  OY=$(awk "BEGIN{printf \"%.3f\", -($y0-$MARGIN)}")

  gs -q -o "$OUT" -sDEVICE=pdfwrite \
     -dDEVICEWIDTHPOINTS="$W" -dDEVICEHEIGHTPOINTS="$H" -dFIXEDMEDIA \
     -c "<</PageOffset [$OX $OY]>> setpagedevice" -f "$RAW"

  rm -f "$RAW"
  echo "wrote $OUT (${W}x${H} pts)"
  pdffonts "$OUT" | head -3
done
