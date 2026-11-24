"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ExposureMetric } from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";
import { Eye, Orbit, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

export interface Surface3DColumn {
  id: string;
  dateLabel: string;
  tag: string;
}

export interface Surface3DRow {
  strike: number;
  isAtm: boolean;
  isKingNode: boolean;
  values: Record<string, number>;
}

interface Surface3DViewProps {
  ticker: string;
  spotPrice: number;
  metric: ExposureMetric;
  kingStrike: number;
  kingStrength: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  columns: Surface3DColumn[];
  rows: Surface3DRow[];
  atmRowIndex: number;
}

interface HoveredNodeInfo {
  strike: number;
  dateLabel: string;
  tag: string;
  value: number;
  isKing: boolean;
  isAtm: boolean;
}

/**
 * Maps upright normalized height [-1, +1] to Hyperion's 3D mountain color scale:
 * - Negative Gamma (-γ) Valleys (ratio < 0, dropping downward):
 *   Indigo (#4338ca) -> Deep Purple (#6b21a8 / #9333ea)
 * - Zero Gamma Plane (ratio ~ 0):
 *   Deep Teal (#0d9488)
 * - Positive Gamma (+γ) Peaks (ratio > 0, extruding upward):
 *   Teal (#14b8a6) -> Cyan (#11cdef) -> Bright Yellow (#facc15 / #fde047)
 */
function getThreeColorForUprightHeight(
  normalizedY: number,
  isKingPeak: boolean
): THREE.Color {
  if (isKingPeak && normalizedY > 0.25) {
    return new THREE.Color("#fde047");
  }

  const r = Math.max(-1, Math.min(1, normalizedY));
  const color = new THREE.Color();

  if (r < 0) {
    const mag = Math.abs(r);
    if (mag < 0.5) {
      color.lerpColors(
        new THREE.Color("#0f766e"),
        new THREE.Color("#4f46e5"),
        mag / 0.5
      );
    } else {
      color.lerpColors(
        new THREE.Color("#4f46e5"),
        new THREE.Color("#7e22ce"),
        (mag - 0.5) / 0.5
      );
    }
    return color;
  }

  if (r < 0.35) {
    color.lerpColors(
      new THREE.Color("#0d9488"),
      new THREE.Color("#14b8a6"),
      r / 0.35
    );
  } else if (r < 0.7) {
    color.lerpColors(
      new THREE.Color("#14b8a6"),
      new THREE.Color("#11cdef"),
      (r - 0.35) / 0.35
    );
  } else {
    color.lerpColors(
      new THREE.Color("#11cdef"),
      new THREE.Color("#facc15"),
      (r - 0.7) / 0.3
    );
  }
  return color;
}

/**
 * Creates a high-resolution, high-contrast 3D text sprite for axis ticks and titles
 * (scaled 1.75x–2x for crisp legibility at any camera orbit distance)
 */
function createTextSprite(
  text: string,
  color = "#f1f5f9",
  fontSize = 54,
  scaleWidth = 5.4
): { sprite: THREE.Sprite; dispose: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 144;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `900 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // High-contrast dark outline halo so numbers pop over grid lines and surface mesh
    ctx.strokeStyle = "rgba(11, 13, 23, 0.95)";
    ctx.lineWidth = 10;
    ctx.lineJoin = "round";
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scaleWidth, scaleWidth * 0.28, 1);

  return {
    sprite,
    dispose: () => {
      texture.dispose();
      material.dispose();
    },
  };
}

function formatSurfaceAxisVal(valM: number, sign: "+" | "-"): string {
  const absM = Math.abs(valM);
  if (!Number.isFinite(absM) || absM < 0.001) return "$0";
  if (absM >= 1000) {
    const b = absM / 1000;
    return `${sign}${b >= 10 ? b.toFixed(0) : b.toFixed(1)}B`;
  }
  if (absM >= 1) {
    return `${sign}${absM >= 10 ? absM.toFixed(0) : absM.toFixed(1)}M`;
  }
  const k = absM * 1000;
  return `${sign}${k.toFixed(0)}K`;
}

function formatSurfaceStrike(strike: number): string {
  if (!Number.isFinite(strike) || strike <= 0) return "—";
  return strike % 1 !== 0 ? Number(strike.toFixed(2)).toString() : strike.toFixed(0);
}

function getMetricAxisTitle(metric: ExposureMetric): string {
  switch (metric) {
    case "VEX":
      return "Total Vanna";
    case "DEX":
      return "Total Delta";
    case "Charm":
      return "Total Charm";
    case "GEX":
    default:
      return "Total Gamma";
  }
}

export function Surface3DView({
  ticker,
  spotPrice,
  metric,
  kingStrike,
  kingStrength,
  callWall,
  putWall,
  zeroGamma,
  columns,
  rows,
  atmRowIndex,
}: Surface3DViewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [renderStyle, setRenderStyle] = useState<"hybrid" | "surface" | "bars">(
    "surface"
  );
  const [autoRotate, setAutoRotate] = useState<boolean>(false);
  const [hoveredNode, setHoveredNode] = useState<HoveredNodeInfo | null>(null);
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const sceneHandlesRef = useRef<{
    scene: THREE.Scene;
    dataGroup: THREE.Group;
    disposables: { dispose: () => void }[];
    barMeshes: THREE.Mesh[];
  } | null>(null);

  // Camera spherical coordinates (+Y is strictly UP)
  const cameraStateRef = useRef({
    theta: 0.64, // horizontal azimuth angle (radians)
    phi: 1.08, // polar angle from +Y up axis (radians)
    radius: 36,
    targetX: 0,
    targetY: 2.2, // centered on the upright mountain range
    targetZ: 0,
  });

  // Slice ~35 strikes around ATM and sort ascending by strike for the Strike Z-axis
  const slicedRows = useMemo(() => {
    const half = 17;
    const start = Math.max(0, atmRowIndex - half);
    const end = Math.min(rows.length, start + half * 2 + 1);
    return [...rows.slice(start, end)].sort((a, b) => a.strike - b.strike);
  }, [rows, atmRowIndex]);

  /**
   * True Signed Dealer Exposure Matrix:
   * - Positive Exposure (+γ / +VEX) extrudes UPWARD (+Y) into cyan/yellow ridges
   * - Negative Exposure (-γ / -VEX) drops DOWNWARD (-Y) into purple/indigo canyons
   * Never sign-flips negative dealer exposure into fake positive peaks.
   */
  const { uprightValues, maxPositiveVal, maxNegativeVal } = useMemo(() => {
    const matrix = new Map<number, Record<string, number>>();
    let maxPos = 0.1;
    let maxNeg = 0.1;

    for (const r of slicedRows) {
      const rowMap: Record<string, number> = {};
      for (const c of columns) {
        const rawCandidate = r.values[c.id] ?? 0;
        const val = Number.isFinite(rawCandidate) ? rawCandidate : 0;
        rowMap[c.id] = val;
        if (val > maxPos) maxPos = val;
        if (val < 0 && Math.abs(val) > maxNeg) maxNeg = Math.abs(val);
      }
      matrix.set(r.strike, rowMap);
    }

    return {
      uprightValues: matrix,
      maxPositiveVal: maxPos,
      maxNegativeVal: maxNeg,
    };
  }, [slicedRows, columns]);

  const adjustZoom = (delta: number) => {
    cameraStateRef.current.radius = Math.max(
      16,
      Math.min(64, cameraStateRef.current.radius + delta)
    );
  };

  const resetCamera = () => {
    cameraStateRef.current = {
      theta: 0.64,
      phi: 1.08,
      radius: 36,
      targetX: 0,
      targetY: 2.2,
      targetZ: 0,
    };
  };

  // Effect 1: Single persistent WebGLRenderer + scene + orbit controls
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 960;
    const height = container.clientHeight || 520;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0d17");
    scene.fog = new THREE.FogExp2("#0b0d17", 0.01);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 220);
    camera.up.set(0, 1, 0); // Strictly upright +Y axis

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight("#ffffff", 0.9);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight("#ffffff", 1.25);
    dirLight1.position.set(20, 32, 24);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight("#11cdef", 0.55);
    dirLight2.position.set(-22, 16, -18);
    scene.add(dirLight2);

    const dataGroup = new THREE.Group();
    scene.add(dataGroup);

    // Zero-Gamma ($0) Reference Floor Grid at Y = 0
    const gridHelper = new THREE.GridHelper(28, 20, "#334155", "#1e293b");
    gridHelper.position.y = 0;
    scene.add(gridHelper);

    const handles = {
      scene,
      dataGroup,
      disposables: [] as { dispose: () => void }[],
      barMeshes: [] as THREE.Mesh[],
    };
    sceneHandlesRef.current = handles;

    // Raycaster & Mouse Orbit Controls
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let isDragging = false;
    let isPanning = false;
    let prevX = 0;
    let prevY = 0;

    const domEl = renderer.domElement;

    const onPointerDown = (e: MouseEvent) => {
      isDragging = true;
      isPanning = e.button === 2 || e.shiftKey;
      prevX = e.clientX;
      prevY = e.clientY;
    };

    const onPointerMove = (e: MouseEvent) => {
      if (!isDragging && e.target !== domEl) {
        setHoveredNode((prev) => (prev !== null ? null : prev));
        return;
      }

      const rect = domEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (isDragging) {
        const dx = e.clientX - prevX;
        const dy = e.clientY - prevY;
        prevX = e.clientX;
        prevY = e.clientY;

        if (isPanning) {
          cameraStateRef.current.targetX -= dx * 0.03;
          cameraStateRef.current.targetZ -= dy * 0.03;
        } else {
          cameraStateRef.current.theta -= dx * 0.0075;
          cameraStateRef.current.phi = Math.max(
            0.28,
            Math.min(Math.PI * 0.46, cameraStateRef.current.phi - dy * 0.0065)
          );
        }
        return;
      }

      // Hover raycasting on 3D nodes
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(handles.barMeshes, false);
      if (intersects.length > 0) {
        const hit = intersects[0].object.userData as HoveredNodeInfo;
        setHoveredNode(hit);
      } else {
        setHoveredNode((prev) => (prev !== null ? null : prev));
      }
    };

    const onPointerUp = () => {
      isDragging = false;
      isPanning = false;
    };

    const onPointerLeave = () => {
      setHoveredNode((prev) => (prev !== null ? null : prev));
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraStateRef.current.radius = Math.max(
        16,
        Math.min(64, cameraStateRef.current.radius + e.deltaY * 0.025)
      );
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    domEl.addEventListener("mousedown", onPointerDown);
    domEl.addEventListener("mouseleave", onPointerLeave);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    domEl.addEventListener("wheel", onWheel, { passive: false });
    domEl.addEventListener("contextmenu", onContextMenu);

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || 960;
      const h = container.clientHeight || 520;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    let animFrameId = 0;
    let lastRenderSig = "";
    const animate = () => {
      animFrameId = requestAnimationFrame(animate);

      if (autoRotateRef.current && !isDragging) {
        cameraStateRef.current.theta += 0.0035;
      }

      const { theta, phi, radius, targetX, targetY, targetZ } =
        cameraStateRef.current;
      const renderSig = `${theta.toFixed(4)}|${phi.toFixed(4)}|${radius.toFixed(2)}|${targetX.toFixed(2)}|${targetY.toFixed(2)}|${targetZ.toFixed(2)}|${dataGroup.children.length}`;
      if (renderSig === lastRenderSig) {
        return;
      }
      lastRenderSig = renderSig;

      camera.position.x =
        targetX + radius * Math.sin(phi) * Math.sin(theta);
      camera.position.y = targetY + radius * Math.cos(phi);
      camera.position.z =
        targetZ + radius * Math.sin(phi) * Math.cos(theta);
      camera.lookAt(targetX, targetY, targetZ);

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animFrameId);
      domEl.removeEventListener("mousedown", onPointerDown);
      domEl.removeEventListener("mouseleave", onPointerLeave);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      domEl.removeEventListener("wheel", onWheel);
      domEl.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("resize", onResize);
      handles.disposables.forEach((d) => d.dispose());
      handles.disposables = [];
      handles.barMeshes = [];
      dataGroup.clear();
      sceneHandlesRef.current = null;
      gridHelper.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      domEl.remove();
    };
  }, []);

  // Effect 2: Rebuild only dynamic dataGroup geometry/sprites on data/metric/renderStyle updates
  useEffect(() => {
    const handles = sceneHandlesRef.current;
    if (!handles) return;

    const { dataGroup } = handles;
    handles.disposables.forEach((d) => d.dispose());
    handles.disposables = [];
    handles.barMeshes = [];
    dataGroup.clear();

    const disposables = handles.disposables;
    const barMeshes = handles.barMeshes;

    const numX = Math.max(1, columns.length);
    const numZ = Math.max(1, slicedRows.length);
    const spanX = 22;
    const spanZ = 24;

    // Upright Y-Axis scale matching true signed dealer exposure:
    // +Y peaks extrude upward up to +9.0 units
    // -Y canyons drop downward down to -7.5 units
    const maxPositiveHeight = 9.0;
    const maxNegativeDepth = 7.5;

    const getX = (colIdx: number) =>
      numX > 1 ? (colIdx / (numX - 1) - 0.5) * spanX : 0;
    const getZ = (rowIdx: number) =>
      numZ > 1 ? (rowIdx / (numZ - 1) - 0.5) * spanZ : 0;

    const getUprightY = (val: number): { y: number; normRatio: number } => {
      if (!Number.isFinite(val)) {
        return { y: 0, normRatio: 0 };
      }
      if (val >= 0) {
        const norm = Math.min(1, val / Math.max(0.01, maxPositiveVal));
        return {
          y: norm * maxPositiveHeight,
          normRatio: norm,
        };
      } else {
        const norm = Math.min(
          1,
          Math.abs(val) / Math.max(0.01, maxNegativeVal)
        );
        return {
          y: -norm * maxNegativeDepth,
          normRatio: -norm,
        };
      }
    };

    // 3D Bounding Frame & Dynamic Vertical Metric Axis
    const axisX = -spanX / 2 - 1.6;
    const axisZ = -spanZ / 2 - 1.4;
    const yTicks = [
      { label: formatSurfaceAxisVal(maxPositiveVal, "+"), y: maxPositiveHeight, color: "#fde047" },
      { label: formatSurfaceAxisVal(maxPositiveVal * 0.667, "+"), y: maxPositiveHeight * 0.667, color: "#22d3ee" },
      { label: formatSurfaceAxisVal(maxPositiveVal * 0.333, "+"), y: maxPositiveHeight * 0.333, color: "#2dd4bf" },
      { label: "$0", y: 0, color: "#f1f5f9" },
      { label: formatSurfaceAxisVal(maxNegativeVal, "-"), y: -maxNegativeDepth, color: "#c084fc" },
    ];

    // Vertical Axis Pole
    const poleGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(axisX, -maxNegativeDepth, axisZ),
      new THREE.Vector3(axisX, maxPositiveHeight + 0.8, axisZ),
    ]);
    const poleMat = new THREE.LineBasicMaterial({ color: "#64748b" });
    disposables.push(poleGeo, poleMat);
    dataGroup.add(new THREE.Line(poleGeo, poleMat));

    yTicks.forEach((tick) => {
      // Back-wall elevation reference line
      const guideGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(axisX, tick.y, axisZ),
        new THREE.Vector3(spanX / 2, tick.y, axisZ),
        new THREE.Vector3(spanX / 2, tick.y, spanZ / 2),
      ]);
      const guideMat = new THREE.LineBasicMaterial({
        color: tick.y === 0 ? "#64748b" : "#334155",
        transparent: true,
        opacity: tick.y === 0 ? 0.75 : 0.45,
      });
      disposables.push(guideGeo, guideMat);
      dataGroup.add(new THREE.Line(guideGeo, guideMat));

      const lbl = createTextSprite(tick.label, tick.color, 56, 5.4);
      lbl.sprite.position.set(axisX - 2.3, tick.y, axisZ);
      disposables.push(lbl);
      dataGroup.add(lbl.sprite);
    });

    // Dynamic Metric Axis Title
    const metricAxisTitle = createTextSprite(
      getMetricAxisTitle(metric),
      "#f8fafc",
      58,
      7.4
    );
    metricAxisTitle.sprite.position.set(
      axisX - 2.1,
      maxPositiveHeight + 2.0,
      axisZ
    );
    disposables.push(metricAxisTitle);
    dataGroup.add(metricAxisTitle.sprite);

    // Expiration (X-Axis) Tick Labels along front edge
    columns.forEach((col, colIdx) => {
      if (colIdx % 2 !== 0 && colIdx !== columns.length - 1) return;
      const x = getX(colIdx);
      const expLbl = createTextSprite(col.dateLabel, "#e2e8f0", 54, 5.2);
      expLbl.sprite.position.set(x, -0.9, spanZ / 2 + 2.2);
      disposables.push(expLbl);
      dataGroup.add(expLbl.sprite);
    });
    const expAxisTitle = createTextSprite("Expiration", "#38bdf8", 58, 7.0);
    expAxisTitle.sprite.position.set(0, -2.3, spanZ / 2 + 4.1);
    disposables.push(expAxisTitle);
    dataGroup.add(expAxisTitle.sprite);

    // Strike (Z-Axis) Tick Labels along right edge
    const strikeStepInterval = Math.max(1, Math.floor(numZ / 6));
    slicedRows.forEach((row, rowIdx) => {
      if (rowIdx % strikeStepInterval !== 0 && !row.isAtm) return;
      const z = getZ(rowIdx);
      const strikeLbl = createTextSprite(
        `$${formatSurfaceStrike(row.strike)}`,
        row.isAtm ? "#38bdf8" : row.isKingNode ? "#fde047" : "#e2e8f0",
        54,
        5.2
      );
      strikeLbl.sprite.position.set(spanX / 2 + 2.4, -0.7, z);
      disposables.push(strikeLbl);
      dataGroup.add(strikeLbl.sprite);
    });
    const strikeAxisTitle = createTextSprite("Strike", "#a5b4fc", 58, 6.6);
    strikeAxisTitle.sprite.position.set(spanX / 2 + 4.6, -2.1, 0);
    disposables.push(strikeAxisTitle);
    dataGroup.add(strikeAxisTitle.sprite);

    // 1. Continuous Upright 3D Mountain Surface Mesh (X = Expiration, Y = Upright Exposure, Z = Strike)
    if (
      (renderStyle === "hybrid" || renderStyle === "surface") &&
      numX >= 2 &&
      numZ >= 2
    ) {
      const positions: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];

      for (let zIdx = 0; zIdx < numZ; zIdx++) {
        const row = slicedRows[zIdx];
        const z = getZ(zIdx);
        const rowMap = uprightValues.get(row.strike) ?? row.values;

        for (let xIdx = 0; xIdx < numX; xIdx++) {
          const col = columns[xIdx];
          const x = getX(xIdx);
          const effectiveVal = rowMap[col.id] ?? 0;
          const { y, normRatio } = getUprightY(effectiveVal);

          positions.push(x, y, z);
          const c = getThreeColorForUprightHeight(normRatio, row.isKingNode);
          colors.push(c.r, c.g, c.b);
        }
      }

      for (let zIdx = 0; zIdx < numZ - 1; zIdx++) {
        for (let xIdx = 0; xIdx < numX - 1; xIdx++) {
          const a = zIdx * numX + xIdx;
          const b = zIdx * numX + (xIdx + 1);
          const c = (zIdx + 1) * numX + xIdx;
          const d = (zIdx + 1) * numX + (xIdx + 1);

          indices.push(a, c, b);
          indices.push(b, c, d);
        }
      }

      const surfaceGeo = new THREE.BufferGeometry();
      surfaceGeo.setIndex(indices);
      surfaceGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3)
      );
      surfaceGeo.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(colors, 3)
      );
      surfaceGeo.computeVertexNormals();
      disposables.push(surfaceGeo);

      const surfaceMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.3,
        metalness: 0.12,
        transparent: true,
        opacity: renderStyle === "hybrid" ? 0.72 : 0.94,
      });
      disposables.push(surfaceMat);

      const surfaceMesh = new THREE.Mesh(surfaceGeo, surfaceMat);
      dataGroup.add(surfaceMesh);

      // Crisp wireframe contour mesh over the mountain surface
      const wireMat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        wireframe: true,
        transparent: true,
        opacity: 0.42,
      });
      disposables.push(wireMat);
      const wireMesh = new THREE.Mesh(surfaceGeo, wireMat);
      dataGroup.add(wireMesh);
    }

    // 2. Extruded 3D Bars on each (Expiration, Strike) node (also used for hover raycasting)
    const barW = Math.min(0.85, (spanX / numX) * 0.5);
    const barD = Math.min(0.52, (spanZ / numZ) * 0.55);
    const unitBoxGeo = new THREE.BoxGeometry(barW, 1, barD);
    disposables.push(unitBoxGeo);

    for (let zIdx = 0; zIdx < numZ; zIdx++) {
      const row = slicedRows[zIdx];
      const z = getZ(zIdx);
      const rowMap = uprightValues.get(row.strike) ?? row.values;

      // Spot ATM Strike Blue Line across X-axis
      if (row.isAtm) {
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-spanX * 0.55, 0.04, z),
          new THREE.Vector3(spanX * 0.55, 0.04, z),
        ]);
        const lineMat = new THREE.LineBasicMaterial({
          color: "#3b82f6",
        });
        disposables.push(lineGeo, lineMat);
        dataGroup.add(new THREE.Line(lineGeo, lineMat));
      }

      for (let xIdx = 0; xIdx < numX; xIdx++) {
        const col = columns[xIdx];
        const x = getX(xIdx);
        const rawVal = rowMap[col.id] ?? 0;
        const effectiveVal = Number.isFinite(rawVal) ? rawVal : 0;
        const { y, normRatio } = getUprightY(effectiveVal);
        const absHeight = Math.max(0.1, Math.abs(y));
        const isKingBar = row.isKingNode && normRatio > 0.3;

        const barColor = getThreeColorForUprightHeight(normRatio, isKingBar);
        const barMat = new THREE.MeshStandardMaterial({
          color: barColor,
          emissive: isKingBar ? new THREE.Color("#facc15") : barColor,
          emissiveIntensity: isKingBar ? 0.55 : 0.18,
          roughness: 0.25,
          metalness: 0.2,
          transparent: renderStyle === "surface",
          opacity: renderStyle === "surface" ? 0.01 : 0.92,
        });
        disposables.push(barMat);

        const mesh = new THREE.Mesh(unitBoxGeo, barMat);
        mesh.scale.y = absHeight;
        mesh.position.set(x, y >= 0 ? absHeight / 2 : -absHeight / 2, z);
        mesh.userData = {
          strike: row.strike,
          dateLabel: col.dateLabel,
          tag: col.tag,
          value: effectiveVal,
          isKing: row.isKingNode,
          isAtm: row.isAtm,
        } satisfies HoveredNodeInfo;

        dataGroup.add(mesh);
        barMeshes.push(mesh);
      }
    }
  }, [
    columns,
    slicedRows,
    uprightValues,
    maxPositiveVal,
    maxNegativeVal,
    renderStyle,
    metric,
  ]);

  return (
    <div className="relative h-[580px] w-full rounded-lg border border-white/10 bg-[#0b0d17] overflow-hidden select-none">
      {/* Top-Left HUD Overlay */}
      <div className="absolute top-3 left-3 z-20 rounded-xl bg-[#111422]/95 backdrop-blur-md border border-white/20 p-3.5 space-y-1.5 max-w-md pointer-events-none shadow-2xl">
        <div className="flex items-center gap-2">
          <Orbit className="h-4 w-4 text-[#11cdef]" />
          <span className="text-sm font-mono font-extrabold text-white uppercase tracking-wider">
            {ticker} 3D {metric} Surface Mesh
          </span>
        </div>
        <div className="text-xs font-mono text-slate-100 space-y-1 leading-relaxed">
          <div>
            Y-Axis: <span className="text-yellow-300 font-bold">{getMetricAxisTitle(metric)}</span> · X-Axis:{" "}
            <span className="text-cyan-300 font-bold">{columns.length} Expirations</span> · Z-Axis:{" "}
            <span className="text-indigo-300 font-bold">{slicedRows.length} Strikes</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-yellow-300 font-extrabold">
              ★ King: ${formatSurfaceStrike(kingStrike)} ({Number.isFinite(kingStrength) ? kingStrength : 0}pts)
            </span>
            <span className="text-slate-400">·</span>
            <span className="text-[#11cdef] font-bold">CW ${formatSurfaceStrike(callWall)}</span>
            <span className="text-slate-400">·</span>
            <span className="text-[#f5365c] font-bold">PW ${formatSurfaceStrike(putWall)}</span>
          </div>
          <div className="text-xs text-slate-200 font-medium">
            Zero γ: <span className="text-amber-300 font-bold">{Number.isFinite(zeroGamma) && zeroGamma > 0 ? `$${zeroGamma.toFixed(2)}` : "—"}</span> · Blue Line = Spot (
            <span className="text-sky-300 font-bold">{Number.isFinite(spotPrice) && spotPrice > 0 ? `$${spotPrice.toFixed(2)}` : "—"}</span>)
          </div>
        </div>
      </div>

      {/* Top-Right 3D Controls Overlay */}
      <div className="absolute top-3 right-3 z-20 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-full bg-[#111422]/95 backdrop-blur-md border border-white/20 p-1 text-xs font-mono shadow-lg">
          {(
            [
              { id: "surface", label: "3D Surface" },
              { id: "hybrid", label: "Surface + Bars" },
              { id: "bars", label: "3D Bars" },
            ] as const
          ).map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setRenderStyle(mode.id)}
              className={cn(
                "px-3 py-1 rounded-full font-bold transition-all",
                renderStyle === mode.id
                  ? "bg-[#1c223a] border border-[#5e72e4] text-white"
                  : "text-slate-300 hover:text-white"
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setAutoRotate((r) => !r)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-mono font-bold transition-colors shadow-lg",
            autoRotate
              ? "bg-[#1c223a] border-[#11cdef] text-[#11cdef]"
              : "bg-[#111422]/95 border-white/20 text-slate-200 hover:text-white"
          )}
        >
          <Eye className="h-3.5 w-3.5" />
          <span>{autoRotate ? "Orbiting" : "Auto-Orbit"}</span>
        </button>

        <div className="inline-flex items-center rounded-full bg-[#111422]/95 border border-white/20 p-1 text-slate-200 shadow-lg">
          <button
            type="button"
            onClick={() => adjustZoom(4)}
            className="px-2 py-0.5 hover:text-white"
            title="Zoom out 3D camera"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => adjustZoom(-4)}
            className="px-2 py-0.5 hover:text-white"
            title="Zoom in 3D camera"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={resetCamera}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-mono font-bold hover:text-white border-l border-white/15"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* Hovered 3D Node Tooltip */}
      {hoveredNode && (
        <div className="absolute bottom-14 left-3 z-20 rounded-xl bg-[#111422]/95 border border-[#11cdef]/70 px-3.5 py-2.5 text-sm font-mono shadow-xl pointer-events-none">
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-white">
              Strike ${formatSurfaceStrike(hoveredNode.strike)}
            </span>
            <span className="rounded bg-white/15 px-2 py-0.5 text-xs font-bold text-cyan-300">
              {hoveredNode.dateLabel} ({hoveredNode.tag})
            </span>
            {hoveredNode.isKing && (
              <span className="rounded bg-amber-300 px-2 py-0.5 text-xs font-extrabold text-slate-950">
                ★ KING
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-slate-200">
            {metric} Exposure:{" "}
            <span
              className={cn(
                "text-sm font-extrabold",
                hoveredNode.value >= 0 ? "text-yellow-300" : "text-purple-300"
              )}
            >
              {hoveredNode.value >= 0 ? "+" : "-"}$
              {Math.abs(hoveredNode.value).toFixed(2)}M
            </span>
          </div>
        </div>
      )}

      {/* Bottom Controls & Legend Bar */}
      <div className="absolute bottom-2.5 left-3 right-3 z-20 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#111422]/90 backdrop-blur-md border border-white/15 px-3 py-1.5 text-xs font-mono font-medium text-slate-200 pointer-events-none shadow-lg">
        <span>
          Left-Drag: Rotate 3D Orbit · Right-Drag / Shift-Drag: Pan · Scroll: Zoom · Hover: Inspect Node
        </span>
        <span className="font-semibold text-white">
          <span className="text-yellow-300">
            Upward Cyan/Yellow Peaks = +{metric === "GEX" ? "γ" : metric} ({formatSurfaceAxisVal(maxPositiveVal, "+")})
          </span>{" "}
          ·{" "}
          <span className="text-purple-300">
            Downward Purple/Indigo Valleys = -{metric === "GEX" ? "γ" : metric} ({formatSurfaceAxisVal(maxNegativeVal, "-")})
          </span>
        </span>
      </div>

      {/* Three.js WebGL Mount Container */}
      <div ref={mountRef} className="h-full w-full cursor-grab active:cursor-grabbing" />
    </div>
  );
}
