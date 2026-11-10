/**
 * Flow VWAP x Gamma, Flux Field PDE & Dynamic Volumetric Dispersion Corridor Overlay Renderer
 *
 * Upgraded to match Benchmark Flux Fields (SPXW, SPY, QQQ specification):
 * 1. 3-Tier Volumetric Golden-Amber Flux Corridor:
 *    - Tier 1: Inner [-1σ, +1σ] warm translucent amber equilibrium core
 *    - Tier 2: Dense golden exhaustion cushion ribbons between [+1σ, +2σ] and [-1σ, -2σ]
 *    - Tier 3: Luminous ±2σ golden exhaustion walls, dashed ±1σ inner contours, and soft-glow Flow-VWAP core
 * 2. High-Contrast Beaded Liquidity / Gamma Nodes ("Pearl Necklaces"):
 *    - Golden/Amber pearls (#fbbf24 / #fef08a) for Call Gamma, King nodes, and overhead resistance
 *    - Purple/Violet pearls (#c084fc / #f3e8ff) for Put Gamma, Put walls, and support
 *    - Proximity-modulated clustered pearls with specular 3D highlights
 * 3. Precision Wick Rejection Callout Reticles (White Highlight Rings):
 *    - NMS-filtered detection of candle wicks tapping or piercing beads/bands and rejecting back inside
 *    - Dual-layer white target reticles (r=10px) over dark contrast backing ring
 * 4. Contextual Right-Axis Reference Badges:
 *    - Clean, de-collided pill badges for PDH, PMH, PML, Day +1σ, Day -1σ with dashed lead-in ticks
 */

import { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";

export interface ConfluenceLevel {
  name: string;
  strike: number;
}

export interface StrikeNodeOverlayItem {
  strike: number;
  y?: number;
  weight?: number; // normalized [0, 1]
  isKing?: boolean;
  polarity?: "call" | "put" | "neutral";
}

export interface ReferenceBadgeItem {
  label: string;
  price: number;
  y?: number;
  bg?: string;
  border?: string;
  text?: string;
  lineColor?: string;
}

export interface OverlayCandleBar {
  barIndex?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  timeLabel?: string;
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
  strikeNodes?: StrikeNodeOverlayItem[];
  referenceBadges?: ReferenceBadgeItem[];
  showBeadedStrikes?: boolean;
  candles?: OverlayCandleBar[];
}

interface WickRejectionCallout {
  barIndex: number;
  x: number;
  y: number;
  levelPrice: number;
  isUpper: boolean;
  isCallOrUpper: boolean;
  score: number;
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
    strikeNodes = [],
    referenceBadges = [],
    showBeadedStrikes = true,
    candles = [],
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
    ctx.strokeStyle = "rgba(148, 163, 184, 0.38)";
    ctx.lineWidth = 1.0;
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

    if (midpointNode && midpointNode > 0) {
      const my = priceToY(midpointNode);
      if (my >= padTop && my <= chartHeight - padBottom) {
        ctx.strokeStyle = "rgba(226, 232, 240, 0.45)";
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
  // 1. 3-Tier Volumetric Golden-Amber Flux Corridor (Benchmark Image 1)
  // -------------------------------------------------------------
  if (showShading && validLimit >= 1) {
    ctx.save();
    let topMinY = Number.POSITIVE_INFINITY;
    let bottomMaxY = Number.NEGATIVE_INFINITY;

    for (let i = 0; i <= validLimit; i++) {
      const pt = points[i];
      const yUp2 = priceToY(pt.upper2s ?? pt.upper2Sigma);
      const yDn2 = priceToY(pt.lower2s ?? pt.lower2Sigma);
      if (yUp2 < topMinY) topMinY = yUp2;
      if (yDn2 > bottomMaxY) bottomMaxY = yDn2;
    }

    if (!Number.isFinite(topMinY) || !Number.isFinite(bottomMaxY) || bottomMaxY <= topMinY) {
      topMinY = padTop;
      bottomMaxY = chartHeight - padBottom;
    }

    // Tier 1A: Base Full Corridor (-2σ to +2σ) Warm Amber Gradient
    const corridorGrad = ctx.createLinearGradient(0, topMinY, 0, bottomMaxY);
    corridorGrad.addColorStop(0.0, "rgba(251, 191, 36, 0.28)");
    corridorGrad.addColorStop(0.22, "rgba(245, 158, 11, 0.16)");
    corridorGrad.addColorStop(0.5, "rgba(217, 119, 6, 0.08)");
    corridorGrad.addColorStop(0.78, "rgba(245, 158, 11, 0.16)");
    corridorGrad.addColorStop(1.0, "rgba(251, 191, 36, 0.28)");

    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].upper2s ?? points[i].upper2Sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = validLimit; i >= 0; i--) {
      const x = barToX(i);
      const y = priceToY(points[i].lower2s ?? points[i].lower2Sigma);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = corridorGrad;
    ctx.fill();

    // Tier 1B: Upper Golden Exhaustion Cushion Ribbon (+1σ to +2σ)
    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].upper2s ?? points[i].upper2Sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = validLimit; i >= 0; i--) {
      const x = barToX(i);
      const y = priceToY(points[i].upper1s ?? points[i].upper1Sigma);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(251, 191, 36, 0.22)";
    ctx.fill();

    // Tier 1C: Lower Golden Exhaustion Cushion Ribbon (-1σ to -2σ)
    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].lower1s ?? points[i].lower1Sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = validLimit; i >= 0; i--) {
      const x = barToX(i);
      const y = priceToY(points[i].lower2s ?? points[i].lower2Sigma);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(251, 191, 36, 0.22)";
    ctx.fill();

    ctx.restore();
  }

  // -------------------------------------------------------------
  // 2. Dispersion Contours (Luminous ±2σ Gold Walls & ±1σ Dashed Amber)
  // -------------------------------------------------------------
  if (showBands) {
    // A. Outer Bands (±2σ): Luminous Golden Walls with ambient blur
    ctx.save();
    ctx.strokeStyle = "rgba(251, 191, 36, 0.88)";
    ctx.lineWidth = 1.65;
    ctx.shadowColor = "rgba(245, 158, 11, 0.45)";
    ctx.shadowBlur = 6;
    ctx.setLineDash([]);

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

    // B. Inner Bands (±1σ): Warm Amber Dashed Envelope
    ctx.save();
    ctx.strokeStyle = "rgba(253, 224, 71, 0.58)";
    ctx.lineWidth = 1.15;
    ctx.setLineDash([4, 4]);

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
  // 3. Flow VWAP Centerline: Dual-Pass Soft Bloom + Golden Core
  // -------------------------------------------------------------
  if (showCenterline) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([]);

    // Pass 1: Ambient golden-orange glow
    ctx.beginPath();
    for (let i = 0; i <= validLimit; i++) {
      const x = barToX(i);
      const y = priceToY(points[i].flowVwap);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 5.0;
    ctx.strokeStyle = "rgba(245, 158, 11, 0.28)";
    ctx.stroke();

    // Pass 2: Crisp luminous golden-amber core
    ctx.lineWidth = 2.1;
    ctx.strokeStyle = "#fbbf24";
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
  // 3B. High-Contrast Beaded Strike Nodes ("Pearl Necklaces")
  // -------------------------------------------------------------
  if (showBeadedStrikes && strikeNodes.length > 0 && validLimit >= 1) {
    const topBeadNodes = [...strikeNodes]
      .filter((n) => n.isKing || (n.weight ?? 0) >= 0.35)
      .sort((a, b) => ((b.isKing ? 2 : 0) + (b.weight ?? 0)) - ((a.isKing ? 2 : 0) + (a.weight ?? 0)))
      .slice(0, 4);

    const curSpot = activePt.spot;
    const tol = Math.max(activePt.sigma * 1.5, curSpot * 0.005);

    ctx.save();
    for (const node of topBeadNodes) {
      if (!node.strike || node.strike <= 0) continue;
      const y = node.y !== undefined ? node.y : priceToY(node.strike);
      if (y < padTop - 10 || y > chartHeight - padBottom + 10) continue;

      const isGolden =
        node.isKing ||
        node.polarity === "call" ||
        (node.polarity !== "put" && node.strike >= curSpot);

      const coreColor = isGolden ? "#fbbf24" : "#c084fc";
      const specColor = isGolden ? "#fef08a" : "#f3e8ff";
      const haloColor = isGolden ? "rgba(245, 158, 11, 0.35)" : "rgba(168, 85, 247, 0.35)";
      const trackColor = isGolden ? "rgba(251, 191, 36, 0.16)" : "rgba(192, 132, 252, 0.16)";

      // Find active cluster span where price was near this strike
      let firstActiveIdx = -1;
      let lastActiveIdx = -1;

      for (let i = 0; i <= validLimit; i++) {
        const pt = points[i];
        const h = pt.candleHigh ?? pt.spot;
        const l = pt.candleLow ?? pt.spot;
        const dist = node.strike >= l && node.strike <= h ? 0 : Math.min(Math.abs(h - node.strike), Math.abs(l - node.strike));
        if (dist <= tol || i >= Math.max(0, validLimit - 24)) {
          if (firstActiveIdx === -1) firstActiveIdx = i;
          lastActiveIdx = i;
        }
      }

      if (firstActiveIdx === -1) continue;

      // Connecting thread across the cluster
      const xStart = barToX(firstActiveIdx);
      const xEnd = barToX(lastActiveIdx);
      ctx.beginPath();
      ctx.moveTo(xStart, y);
      ctx.lineTo(xEnd, y);
      ctx.lineWidth = node.isKing ? 1.2 : 0.8;
      ctx.strokeStyle = trackColor;
      ctx.setLineDash(node.isKing ? [] : [2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      const baseRadius = 2.1 + Math.min(1, Math.max(0, node.weight ?? 0.5)) * 1.35 + (node.isKing ? 0.45 : 0);

      // Render pearl beads along cluster
      for (let i = firstActiveIdx; i <= lastActiveIdx; i++) {
        if (i % 2 !== 0 && !node.isKing && i < validLimit - 12) continue; // cluster stride
        const pt = points[i];
        const h = pt.candleHigh ?? pt.spot;
        const l = pt.candleLow ?? pt.spot;
        const dist = node.strike >= l && node.strike <= h ? 0 : Math.min(Math.abs(h - node.strike), Math.abs(l - node.strike));
        const normDist = dist / Math.max(1e-5, tol);

        const isTouched = dist <= tol * 0.22;
        const r = isTouched ? baseRadius * 1.25 : baseRadius * Math.max(0.72, 1 - normDist * 0.28);
        const bx = barToX(i);

        if (isTouched || node.isKing) {
          ctx.beginPath();
          ctx.arc(bx, y, r + 2.0, 0, Math.PI * 2);
          ctx.fillStyle = haloColor;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(bx, y, r, 0, Math.PI * 2);
        ctx.fillStyle = coreColor;
        ctx.fill();

        // 3D specular highlight
        if (r >= 2.2) {
          ctx.beginPath();
          ctx.arc(bx - r * 0.25, y - r * 0.25, Math.max(0.75, r * 0.35), 0, Math.PI * 2);
          ctx.fillStyle = specColor;
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // -------------------------------------------------------------
  // 4. Precision Wick Rejection Callouts (White Target Reticles - Image 1)
  // -------------------------------------------------------------
  if (showConfluenceMarkers || showBandWickSignals) {
    const candidates: WickRejectionCallout[] = [];
    const spotPrice = activePt.spot;

    for (let i = 1; i <= validLimit; i++) {
      const pt = points[i];
      const spot = pt.spot;
      const cHigh = pt.candleHigh ?? (candles[i]?.high ?? spot);
      const cLow = pt.candleLow ?? (candles[i]?.low ?? spot);
      const cOpen = pt.candleOpen ?? (candles[i]?.open ?? spot);
      const cClose = pt.candleClose ?? (candles[i]?.close ?? spot);

      const range = Math.max(0.01, cHigh - cLow);
      const bodyTop = Math.max(cOpen, cClose);
      const bodyBot = Math.min(cOpen, cClose);
      const upperWick = cHigh - bodyTop;
      const lowerWick = bodyBot - cLow;

      const upper2 = pt.upper2s ?? pt.upper2Sigma;
      const lower2 = pt.lower2s ?? pt.lower2Sigma;
      const upper1 = pt.upper1s ?? pt.upper1Sigma;
      const lower1 = pt.lower1s ?? pt.lower1Sigma;
      const sigma = pt.sigma > 0 ? pt.sigma : Math.max(spotPrice * 0.002, range);
      const tol = Math.max(sigma * 0.16, spotPrice * 0.0004);

      // Collect levels to test at bar i
      const levelsToTest: Array<{
        price: number;
        weight: number;
        isCallOrUpper: boolean;
      }> = [
        { price: upper2, weight: 1.25, isCallOrUpper: true },
        { price: upper1, weight: 0.95, isCallOrUpper: true },
        { price: lower1, weight: 0.95, isCallOrUpper: false },
        { price: lower2, weight: 1.25, isCallOrUpper: false },
      ];

      for (const st of strikeNodes) {
        if (st.strike > 0) {
          levelsToTest.push({
            price: st.strike,
            weight: 0.8 + (st.weight ?? 0.5) * 0.5 + (st.isKing ? 0.4 : 0),
            isCallOrUpper: st.isKing || st.polarity === "call" || (st.polarity !== "put" && st.strike >= spotPrice),
          });
        }
      }

      for (const lvl of levelsToTest) {
        // Upper Wick Rejection: High reached level, but candle closed below it
        if (
          upperWick >= range * 0.16 &&
          cHigh >= lvl.price - tol &&
          cHigh <= lvl.price + tol * 2.5 &&
          bodyTop <= lvl.price + tol * 0.4
        ) {
          const wickRatio = upperWick / range;
          const proximity = 1 - Math.min(1, Math.abs(cHigh - lvl.price) / (tol * 2.5));
          candidates.push({
            barIndex: i,
            x: barToX(i),
            y: priceToY(cHigh),
            levelPrice: lvl.price,
            isUpper: true,
            isCallOrUpper: lvl.isCallOrUpper,
            score: (wickRatio * 1.5 + proximity) * lvl.weight,
          });
        }

        // Lower Wick Rejection: Low reached level, but candle closed above it
        if (
          lowerWick >= range * 0.16 &&
          cLow <= lvl.price + tol &&
          cLow >= lvl.price - tol * 2.5 &&
          bodyBot >= lvl.price - tol * 0.4
        ) {
          const wickRatio = lowerWick / range;
          const proximity = 1 - Math.min(1, Math.abs(cLow - lvl.price) / (tol * 2.5));
          candidates.push({
            barIndex: i,
            x: barToX(i),
            y: priceToY(cLow),
            levelPrice: lvl.price,
            isUpper: false,
            isCallOrUpper: lvl.isCallOrUpper,
            score: (wickRatio * 1.5 + proximity) * lvl.weight,
          });
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const selected: WickRejectionCallout[] = [];
      const maxCallouts = 7;

      for (const c of candidates) {
        let suppressed = false;
        for (const s of selected) {
          const barDist = Math.abs(c.barIndex - s.barIndex);
          const pixelDist = Math.hypot(c.x - s.x, c.y - s.y);
          if (pixelDist < 26 || (barDist < 3 && Math.abs(c.y - s.y) < 16)) {
            suppressed = true;
            break;
          }
        }
        if (!suppressed) {
          selected.push(c);
          if (selected.length >= maxCallouts) break;
        }
      }

      // Render Precision White Highlight Rings (Image 1 Style)
      ctx.save();
      for (const callout of selected) {
        const ringRadius = 10.0;

        // 1. Dark contrast backing ring
        ctx.beginPath();
        ctx.arc(callout.x, callout.y, ringRadius, 0, Math.PI * 2);
        ctx.lineWidth = 3.4;
        ctx.strokeStyle = "rgba(9, 13, 22, 0.85)";
        ctx.stroke();

        // 2. Crisp luminous white callout ring
        ctx.save();
        ctx.beginPath();
        ctx.arc(callout.x, callout.y, ringRadius, 0, Math.PI * 2);
        ctx.lineWidth = 1.85;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
        ctx.shadowColor = "rgba(255, 255, 255, 0.65)";
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.restore();

        // 3. Highlighted central bead inside the ring
        const beadColor = callout.isCallOrUpper ? "#fde047" : "#e9d5ff";
        ctx.beginPath();
        ctx.arc(callout.x, callout.y, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = beadColor;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // -------------------------------------------------------------
  // 5. Contextual Right-Axis Badges (PDH, PMH, PML, Day ±1σ)
  // -------------------------------------------------------------
  if (referenceBadges.length > 0) {
    const validBadges = referenceBadges
      .map((b) => ({
        ...b,
        y: b.y !== undefined ? b.y : priceToY(b.price),
      }))
      .filter((b) => Number.isFinite(b.y) && b.y >= padTop + 8 && b.y <= chartHeight - padBottom - 8)
      .sort((a, b) => a.y - b.y);

    if (validBadges.length > 0) {
      const minGap = 17;
      const resolvedY = validBadges.map((v) => v.y);
      for (let i = 1; i < resolvedY.length; i++) {
        if (resolvedY[i] - resolvedY[i - 1] < minGap) {
          resolvedY[i] = resolvedY[i - 1] + minGap;
        }
      }

      ctx.save();
      ctx.font = 'bold 9px ui-monospace, SFMono-Regular, "JetBrains Mono", monospace';
      ctx.textBaseline = "middle";

      for (let i = 0; i < validBadges.length; i++) {
        const item = validBadges[i];
        const badgeY = Math.min(chartHeight - padBottom - 8, Math.max(padTop + 8, resolvedY[i]));
        const text = item.label;
        const textW = ctx.measureText(text).width;
        const padX = 5;
        const badgeW = textW + padX * 2;
        const badgeH = 15;
        const badgeX = plotRightX + 3;

        // Dashed lead-in reference tick
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 0.9;
        ctx.strokeStyle = item.lineColor ?? "rgba(148, 163, 184, 0.45)";
        ctx.beginPath();
        ctx.moveTo(plotRightX - 28, item.y);
        ctx.lineTo(badgeX - 2, badgeY);
        ctx.stroke();
        ctx.restore();

        // Badge pill fill
        ctx.fillStyle = item.bg ?? "#111422";
        ctx.strokeStyle = item.border ?? "rgba(148, 163, 184, 0.6)";
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY - badgeH / 2, badgeW, badgeH, 3);
        ctx.fill();
        ctx.stroke();

        // Badge text
        ctx.fillStyle = item.text ?? "#ffffff";
        ctx.fillText(text, badgeX + padX, badgeY + 0.5);
      }
      ctx.restore();
    }
  }

  // -------------------------------------------------------------
  // 6. Right Price Axis Tag: Gold Badge `FVWAP {val}`
  // -------------------------------------------------------------
  if (showRightAxisBadge && activePt && activePt.flowVwap > 0) {
    const fvwapY = priceToY(activePt.flowVwap);

    if (fvwapY >= padTop && fvwapY <= chartHeight - padBottom) {
      ctx.save();
      const badgeX = plotRightX + 3;
      const badgeW = Math.min(rightAxisWidth - 6, 76);
      const badgeH = 17;
      const badgeY = fvwapY - badgeH / 2;

      ctx.shadowBlur = 8;
      ctx.shadowColor = "rgba(245, 158, 11, 0.75)";
      ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
      ctx.strokeStyle = "#fef08a";
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = "#000000";
      ctx.font = 'bold 9px ui-monospace, SFMono-Regular, "JetBrains Mono", monospace';
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
