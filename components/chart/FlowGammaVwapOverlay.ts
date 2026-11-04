/**
 * Flow VWAP x Gamma, Flux Field PDE & Dynamic Dispersion Bands Canvas Overlay Renderer
 *
 * Renders (matching Skylit / Flux Field Tick-Level Accuracy Specification):
 * 1. Flow VWAP Centerline: Smooth orange/gold curve (#f59e0b, width: 2.2px) + Right axis tag badge
 * 2. Dispersion Cloud:
 *    - Outer Bands (+-2 sigma): Dotted/dashed soft silver-amber envelope
 *    - Inner Bands (+-1 sigma): Fine dotted envelope
 *    - Envelope Shading: Subtle dark-glass & amber gradient between -2 sigma and +2 sigma
 * 3. Structural Flux Field Boundaries:
 *    - Floor Node (p_F) & Ceiling Node (p_C) dashed lines
 *    - Equilibrium Midpoint (p_F + W/2) fine white dotted line (lim_{t->inf} VWAP_flow = P/2)
 * 4. Tick-Level Accuracy Wick Callouts & Confluence Markers:
 *    - Highlighted reversal markers when candle high/low wicks pierce or reject off +-1s / +-2s
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
  showStructuralNodes?: boolean;
  showBandWickSignals?: boolean;
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
    showStructuralNodes = true,
    showBandWickSignals = true,
  } = options;

  if (!points || points.length === 0 || safeActiveIdx < 0) return;

  const validLimit = Math.min(safeActiveIdx, points.length - 1);
  if (validLimit < 0) return;

  const activePt = points[validLimit];

  // -------------------------------------------------------------
  // 0. Structural Flux Field Nodes (Floor p_F, Ceiling p_C, Midpoint P/2)
  // -------------------------------------------------------------
  if (showStructuralNodes && activePt) {
    const { floorNode, ceilingNode, midpointNode } = activePt;

    ctx.save();
    // Ceiling Node (p_C) & Floor Node (p_F): Dashed horizontal lines (matching Image 3 top/bottom dashed rays)
    ctx.strokeStyle = "rgba(148, 163, 184, 0.45)";
    ctx.lineWidth = 1.1;
    ctx.setLineDash([4, 4]);

    if (ceilingNode && ceilingNode > 0) {
      const cy = priceToY(ceilingNode);
      if (cy >= padTop && cy <= chartHeight - padBottom) {
        ctx.beginPath();
        ctx.moveTo(padLeft, cy);
        ctx.lineTo(plotRightX, cy);
        ctx.stroke();
      }
    }

    if (floorNode && floorNode > 0) {
      const fy = priceToY(floorNode);
      if (fy >= padTop && fy <= chartHeight - padBottom) {
        ctx.beginPath();
        ctx.moveTo(padLeft, fy);
        ctx.lineTo(plotRightX, fy);
        ctx.stroke();
      }
    }

    // Equilibrium Midpoint (p_F + W/2): Fine white dotted ray (matching Image 3 middle white dotted line)
    if (midpointNode && midpointNode > 0) {
      const my = priceToY(midpointNode);
      if (my >= padTop && my <= chartHeight - padBottom) {
        ctx.strokeStyle = "rgba(226, 232, 240, 0.48)";
        ctx.lineWidth = 1.0;
        ctx.setLineDash([1.5, 2.5]);
        ctx.beginPath();
        ctx.moveTo(padLeft, my);
        ctx.lineTo(plotRightX, my);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

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
      gradient.addColorStop(0, "rgba(255, 255, 255, 0.055)");
      gradient.addColorStop(0.5, "rgba(245, 158, 11, 0.03)");
      gradient.addColorStop(1, "rgba(255, 255, 255, 0.055)");
      ctx.fillStyle = gradient;
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
      ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------
  // 2. Dispersion Cloud / Bands (+-2 sigma and +-1 sigma)
  // -------------------------------------------------------------
  if (showBands) {
    // A. Outer Bands (+-2 sigma): Crisp dotted silver/amber envelope (matching Image 3)
    ctx.save();
    ctx.strokeStyle = "rgba(203, 213, 225, 0.55)";
    ctx.lineWidth = 1.15;
    ctx.setLineDash([2, 2.5]);

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

    // B. Inner Bands (+-1 sigma): Faint dotted envelope (matching Image 3 inner band)
    ctx.save();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.42)";
    ctx.lineWidth = 1.0;
    ctx.setLineDash([1.5, 2.5]);

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
  // 3. Flow VWAP Centerline: Smooth orange/amber curve (#f59e0b, width: 2.2px)
  // -------------------------------------------------------------
  if (showCenterline) {
    ctx.save();
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.shadowBlur = 7;
    ctx.shadowColor = "rgba(245, 158, 11, 0.38)";

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
  // 4. Tick-Level Wick Accuracy & Confluence Callouts (+-1s / +-2s)
  // -------------------------------------------------------------
  if (showConfluenceMarkers || showBandWickSignals) {
    let lastMarkedBar = -999;

    for (let i = 1; i <= validLimit; i++) {
      // Avoid overlapping markers within 2 bars
      if (i - lastMarkedBar < 3) continue;

      const pt = points[i];
      const spot = pt.spot;
      const high = pt.candleHigh ?? spot;
      const low = pt.candleLow ?? spot;
      const upper2 = pt.upper2s ?? pt.upper2Sigma;
      const lower2 = pt.lower2s ?? pt.lower2Sigma;
      const upper1 = pt.upper1s ?? pt.upper1Sigma;
      const lower1 = pt.lower1s ?? pt.lower1Sigma;

      const isUpper2Pierce = high >= upper2 * 0.9996 && spot <= upper2 * 1.0005;
      const isLower2Pierce = low <= lower2 * 1.0004 && spot >= lower2 * 0.9995;
      const isUpper1Reject = pt.bandSignal === "UPPER_1S_REJECT";
      const isLower1Bounce = pt.bandSignal === "LOWER_1S_BOUNCE";

      const isUpperSignal = isUpper2Pierce || isUpper1Reject;
      const isLowerSignal = isLower2Pierce || isLower1Bounce;

      if (!isUpperSignal && !isLowerSignal) continue;

      // Check for confluence within +-0.15% of any key level OR direct +-2s wick pierce
      let hasConfluence = isUpper2Pierce || isLower2Pierce || Boolean(pt.bandSignal);
      if (!hasConfluence && confluenceLevels.length > 0) {
        for (const level of confluenceLevels) {
          if (!level.strike || level.strike <= 0) continue;
          const diffRatio = Math.abs(spot - level.strike) / level.strike;
          const bandPrice = isUpperSignal ? upper2 : lower2;
          const bandDiffRatio = Math.abs(bandPrice - level.strike) / level.strike;
          if (diffRatio <= 0.0012 || bandDiffRatio <= 0.0012) {
            hasConfluence = true;
            break;
          }
        }
      }

      if (hasConfluence) {
        lastMarkedBar = i;
        const cx = barToX(i);
        const anchorPrice = isUpperSignal
          ? Math.max(high, isUpper2Pierce ? upper2 : upper1)
          : Math.min(low, isLower2Pierce ? lower2 : lower1);
        const cy = priceToY(anchorPrice);

        ctx.save();
        // 1. Subtle glowing target ring around wick tip
        const is2Sigma = isUpper2Pierce || isLower2Pierce;
        const ringColor = isUpperSignal ? "#f43f5e" : "#10b981";
        ctx.shadowBlur = is2Sigma ? 9 : 5;
        ctx.shadowColor = ringColor;
        ctx.strokeStyle = is2Sigma ? "#facc15" : ringColor;
        ctx.lineWidth = is2Sigma ? 1.3 : 1.0;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(cx, cy, is2Sigma ? 8.0 : 6.0, 0, Math.PI * 2);
        ctx.stroke();

        // 2. Inner Reversal Core Dot right at the wick touch
        ctx.setLineDash([]);
        ctx.fillStyle = ringColor;
        ctx.strokeStyle = "#fef08a";
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(cx, cy, is2Sigma ? 3.0 : 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 3. Directional Triangle Micro-Marker (below/above wicks)
        ctx.beginPath();
        const arrowH = is2Sigma ? 5 : 4;
        const arrowW = is2Sigma ? 4 : 3.2;
        const arrowY = isUpperSignal ? cy - 13 : cy + 13;
        if (isUpperSignal) {
          ctx.moveTo(cx, arrowY + arrowH);
          ctx.lineTo(cx - arrowW, arrowY);
          ctx.lineTo(cx + arrowW, arrowY);
        } else {
          ctx.moveTo(cx, arrowY - arrowH);
          ctx.lineTo(cx - arrowW, arrowY);
          ctx.lineTo(cx + arrowW, arrowY);
        }
        ctx.closePath();
        ctx.fillStyle = ringColor;
        ctx.shadowBlur = 5;
        ctx.shadowColor = ringColor;
        ctx.fill();

        ctx.restore();
      }
    }
  }

  // -------------------------------------------------------------
  // 5. Right Price Axis Tag: Gold Badge `FVWAP {val}` + Flux Chi
  // -------------------------------------------------------------
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
      ctx.shadowColor = "rgba(245, 158, 11, 0.75)";
      ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
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
