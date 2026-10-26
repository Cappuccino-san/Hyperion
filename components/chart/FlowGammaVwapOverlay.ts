/**
 * Flow VWAP x Gamma & Dynamic Dispersion Bands Canvas Overlay Renderer
 *
 * Renders:
 * 1. Flow VWAP Centerline: Solid gold curve (#eab308, width: 2px) + Right axis tag badge
 * 2. Dispersion Cloud:
 *    - Outer Bands (+-2 sigma): Dashed gold/amber (#ca8a04, strokeDasharray [4, 4], width: 1.2px)
 *    - Inner Bands (+-1 sigma): Dotted amber (#a16207, strokeDasharray [2, 2], width: 1px)
 *    - Envelope Shading: Subtle semi-transparent amber gradient between -2 sigma and +2 sigma
 * 3. Confluence Marker Callouts:
 *    - Highlighted reversal circle marker and overextension badge when spot pierces +-2 sigma
 *      within +-0.10% of King Node, Call Wall, or Put Wall.
 */

import { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";

export interface ConfluenceLevel {
  name: string;
  strike: number;
}

export interface RenderFlowGammaVwapOptions {
  ctx: CanvasRenderingContext2D;
  points: FlowGammaVwapSnapshot[];
  safeActiveIdx: number;
  barToX: (index: number) => number;
  priceToY: (price: number) => number;
  padLeft: number;
  plotRightX: number;
  padTop: number;
  padBottom: number;
  chartHeight: number;
  rightAxisWidth?: number;
  confluenceLevels?: ConfluenceLevel[];
  showCenterline?: boolean;
  showBands?: boolean;
  showShading?: boolean;
  showConfluenceMarkers?: boolean;
  showRightAxisBadge?: boolean;
}

export function drawFlowGammaVwapOverlay(options: RenderFlowGammaVwapOptions): void {
  const {
    ctx,
    points,
    safeActiveIdx,
    barToX,
    priceToY,
    padLeft,
    plotRightX,
    padTop,
    padBottom,
    chartHeight,
    rightAxisWidth = 74,
    confluenceLevels = [],
    showCenterline = true,
    showBands = true,
    showShading = true,
    showConfluenceMarkers = true,
    showRightAxisBadge = true,
  } = options;

  if (!points || points.length === 0 || safeActiveIdx < 0) return;

  const validLimit = Math.min(safeActiveIdx, points.length - 1);
  if (validLimit < 0) return;

  // -------------------------------------------------------------
  // 1. Envelope Shading (Fill between -2 sigma and +2 sigma)
  // -------------------------------------------------------------
  if (showShading && validLimit >= 1) {
    ctx.save();
    let topMinY = Number.POSITIVE_INFINITY;
    let bottomMaxY = Number.NEGATIVE_INFINITY;

    ctx.beginPath();
    // Trace +2 sigma forward
    for (let i = 0; i <= validLimit; i++) {
      const pt = points[i];
      const x = barToX(i);
      const y = priceToY(pt.upper2s ?? pt.upper2Sigma);
      if (y < topMinY) topMinY = y;
      if (y > bottomMaxY) bottomMaxY = y;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    // Trace -2 sigma backward
    for (let i = validLimit; i >= 0; i--) {
      const pt = points[i];
      const x = barToX(i);
      const y = priceToY(pt.lower2s ?? pt.lower2Sigma);
      if (y < topMinY) topMinY = y;
      if (y > bottomMaxY) bottomMaxY = y;
      ctx.lineTo(x, y);
    }
    ctx.closePath();

    if (Number.isFinite(topMinY) && Number.isFinite(bottomMaxY) && bottomMaxY > topMinY) {
      const gradient = ctx.createLinearGradient(0, topMinY, 0, bottomMaxY);
      gradient.addColorStop(0, "rgba(234, 179, 8, 0.08)");
      gradient.addColorStop(0.5, "rgba(234, 179, 8, 0.035)");
      gradient.addColorStop(1, "rgba(234, 179, 8, 0.08)");
      ctx.fillStyle = gradient;
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(234, 179, 8, 0.05)";
      ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------
  // 2. Dispersion Cloud / Bands (+-2 sigma and +-1 sigma)
  // -------------------------------------------------------------
  if (showBands) {
    // A. Outer Bands (+-2 sigma): Thin dashed gold/amber (#ca8a04, [4, 4], 1.2px)
    ctx.save();
    ctx.strokeStyle = "#ca8a04";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);

    // +2 sigma
    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].upper2s ?? points[i].upper2Sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // -2 sigma
    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].lower2s ?? points[i].lower2Sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // B. Inner Bands (+-1 sigma): Faint dotted amber (#a16207, [2, 2], 1px)
    ctx.save();
    ctx.strokeStyle = "#a16207";
    ctx.lineWidth = 1.0;
    ctx.setLineDash([2, 2]);

    // +1 sigma
    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].upper1s ?? points[i].upper1Sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // -1 sigma
    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].lower1s ?? points[i].lower1Sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------
  // 3. Flow VWAP Centerline: Solid gold curve (#eab308, width: 2px)
  // -------------------------------------------------------------
  if (showCenterline) {
    ctx.save();
    ctx.strokeStyle = "#eab308";
    ctx.lineWidth = 2.0;
    ctx.setLineDash([]);
    ctx.shadowBlur = 8;
    ctx.shadowColor = "rgba(234, 179, 8, 0.45)";

    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].flowVwap);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------
  // 4. Confluence Marker Callouts (+-2 sigma pierce near Key Node)
  // -------------------------------------------------------------
  if (showConfluenceMarkers && confluenceLevels.length > 0) {
    let lastMarkedBar = -999;

    for (let i = 0; i <= validLimit; i++) {
      // Avoid overlapping markers within 2 bars
      if (i - lastMarkedBar < 3) continue;

      const pt = points[i];
      const spot = pt.spot;
      const upper2 = pt.upper2s ?? pt.upper2Sigma;
      const lower2 = pt.lower2s ?? pt.lower2Sigma;

      const isUpperPierce = spot >= upper2 * 0.9995;
      const isLowerPierce = spot <= lower2 * 1.0005;

      if (!isUpperPierce && !isLowerPierce) continue;

      // Check for confluence within +-0.10% (0.0010) of any key level
      let matchedLevel: ConfluenceLevel | null = null;
      for (const level of confluenceLevels) {
        if (!level.strike || level.strike <= 0) continue;
        const diffRatio = Math.abs(spot - level.strike) / level.strike;
        const bandDiffRatio = Math.abs((isUpperPierce ? upper2 : lower2) - level.strike) / level.strike;
        if (diffRatio <= 0.0010 || bandDiffRatio <= 0.0010) {
          matchedLevel = level;
          break;
        }
      }

      if (matchedLevel) {
        lastMarkedBar = i;
        const cx = barToX(i);
        const cy = priceToY(spot);

        ctx.save();
        // 1. Subtle glowing target circles (◎ / radial glow rings) around pivot candle
        ctx.shadowBlur = 10;
        ctx.shadowColor = "#eab308";
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(cx, cy, 9.5, 0, Math.PI * 2);
        ctx.stroke();

        // 2. Inner Reversal Core Dot
        ctx.setLineDash([]);
        ctx.fillStyle = isUpperPierce ? "#f43f5e" : "#10b981";
        ctx.strokeStyle = "#fef08a";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 3. Directional Triangle Micro-Marker (below/above wicks)
        ctx.beginPath();
        const arrowH = 5;
        const arrowW = 4;
        const arrowY = isUpperPierce ? cy - 15 : cy + 15;
        if (isUpperPierce) {
          // Downward-pointing arrow indicating bearish mean-reversion off +2σ resistance
          ctx.moveTo(cx, arrowY + arrowH);
          ctx.lineTo(cx - arrowW, arrowY);
          ctx.lineTo(cx + arrowW, arrowY);
        } else {
          // Upward-pointing arrow indicating bullish mean-reversion off -2σ support
          ctx.moveTo(cx, arrowY - arrowH);
          ctx.lineTo(cx - arrowW, arrowY);
          ctx.lineTo(cx + arrowW, arrowY);
        }
        ctx.closePath();
        ctx.fillStyle = isUpperPierce ? "#f43f5e" : "#10b981";
        ctx.shadowBlur = 6;
        ctx.shadowColor = isUpperPierce ? "#f43f5e" : "#10b981";
        ctx.fill();

        ctx.restore();
      }
    }
  }

  // -------------------------------------------------------------
  // 5. Right Price Axis Tag: Gold Badge `FVWAP {val}`
  // -------------------------------------------------------------
  const activePt = points[validLimit];
  if (showRightAxisBadge && activePt && activePt.flowVwap > 0) {
    const fvwapY = priceToY(activePt.flowVwap);

    if (fvwapY >= padTop && fvwapY <= chartHeight - padBottom) {
      ctx.save();
      const badgeX = plotRightX + 3;
      const badgeW = rightAxisWidth - 6;
      const badgeH = 17;
      const badgeY = fvwapY - badgeH / 2;

      // Glow + Border
      ctx.shadowBlur = 8;
      ctx.shadowColor = "rgba(234, 179, 8, 0.75)";
      ctx.fillStyle = "rgba(234, 179, 8, 0.95)";
      ctx.strokeStyle = "#fef08a";
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
      ctx.fill();
      ctx.stroke();

      // Bold text
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#000000";
      ctx.font = "bold 9px ui-monospace, SFMono-Regular, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `FVWAP ${activePt.flowVwap.toFixed(1)}`,
        badgeX + badgeW / 2,
        badgeY + badgeH / 2 + 0.5
      );
      ctx.restore();
    }
  }
}
