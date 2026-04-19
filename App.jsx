import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Wind, Sun, Palette, Compass, Layers, Layout,
  ShieldCheck, AlertTriangle, Upload, Bot, Plus,
  Minus, Trash2, FileText, Sparkles, RotateCcw
} from "lucide-react";

// ─────────────────────────────────────────────
// CONSTANTS & DATA
// ─────────────────────────────────────────────
const DIRECTION_ORDER = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const CSV_AGGREGATION_MODES = {
  frequency: "Frequency (count)",
  speedWeighted: "Speed-weighted"
};

const DIRECTION_ALIASES = {
  N: "N",
  NORTH: "N",
  NNE: "NNE",
  NORTHEASTBYNORTH: "NNE",
  NE: "NE",
  NORTHEAST: "NE",
  ENE: "ENE",
  EASTNORTHEAST: "ENE",
  E: "E",
  EAST: "E",
  ESE: "ESE",
  EASTSOUTHEAST: "ESE",
  SE: "SE",
  SOUTHEAST: "SE",
  SSE: "SSE",
  SOUTHEASTBYSOUTH: "SSE",
  S: "S",
  SOUTH: "S",
  SSW: "SSW",
  SOUTHSOUTHWEST: "SSW",
  SW: "SW",
  SOUTHWEST: "SW",
  WSW: "WSW",
  WESTSOUTHWEST: "WSW",
  W: "W",
  WEST: "W",
  WNW: "WNW",
  WESTNORTHWEST: "WNW",
  NW: "NW",
  NORTHWEST: "NW",
  NNW: "NNW",
  NORTHNORTHWEST: "NNW"
};

const initialDataRaw = [
  { direction: "N", value: 0.3 },
  { direction: "NNW", value: 0.3 },
  { direction: "NW", value: 0.3 },
  { direction: "WNW", value: 0.3 },
  { direction: "W", value: 15.0 },
  { direction: "WSW", value: 35.0 },
  { direction: "SW", value: 25.0 },
  { direction: "SSW", value: 0.3 },
  { direction: "S", value: 0.3 },
  { direction: "SSE", value: 0.3 },
  { direction: "SE", value: 0.3 },
  { direction: "ESE", value: 0.3 },
  { direction: "E", value: 4.0 },
  { direction: "ENE", value: 12.0 },
  { direction: "NE", value: 6.0 },
  { direction: "NNE", value: 0.3 }
];

const GUIDELINES = {
  FAA: { crosswind_small: 10.5, crosswind_large: 20 },
  ICAO: { safety_threshold: 95.0 }
};

const ASSUMED_WIND_SPEED = 15;

const DEFAULT_LAYERS = [
  { id: 1, name: "P-401 HMA Surface", thickness: 4, modulus: 400000, color: "#334155" },
  { id: 2, name: "P-209 Base Course", thickness: 6, modulus: 75000, color: "#78716c" },
  { id: 3, name: "P-154 Subbase", thickness: 12, modulus: 35000, color: "#a8a29e" },
  { id: 4, name: "Subgrade", thickness: 24, modulus: 15000, color: "#92400e" }
];

const RUNWAY_DIRECTIONS = [
  { label: "N-S", angle: 0 },
  { label: "NNE-SSW", angle: 22.5 },
  { label: "NE-SW", angle: 45 },
  { label: "ENE-WSW", angle: 67.5 },
  { label: "E-W", angle: 90 },
  { label: "ESE-WNW", angle: 112.5 },
  { label: "SE-NW", angle: 135 },
  { label: "SSE-NNW", angle: 157.5 }
];

// ─────────────────────────────────────────────
// MATH HELPERS
// ─────────────────────────────────────────────
const normalizeDataOrder = (raw) => {
  const lookup = new Map(raw.map((d) => [d.direction, d.value]));
  return DIRECTION_ORDER.map((dir) => ({
    direction: dir,
    value: Number(lookup.get(dir) ?? 0),
  }));
};

const getCoordinates = (angleDegrees, radius, cx, cy) => {
  const angleRadians = (angleDegrees - 90) * (Math.PI / 180);
  return {
    x: cx + radius * Math.cos(angleRadians),
    y: cy + radius * Math.sin(angleRadians),
  };
};

const polarToCartesian = (centerX, centerY, radius, angleInDegrees) => {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
};

const describeWedge = (x, y, innerRadius, outerRadius, startAngle, endAngle) => {
  const startOuter = polarToCartesian(x, y, outerRadius, endAngle);
  const endOuter = polarToCartesian(x, y, outerRadius, startAngle);
  const startInner = polarToCartesian(x, y, innerRadius, endAngle);
  const endInner = polarToCartesian(x, y, innerRadius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    "M", startOuter.x, startOuter.y,
    "A", outerRadius, outerRadius, 0, largeArcFlag, 0, endOuter.x, endOuter.y,
    "L", endInner.x, endInner.y,
    "A", innerRadius, innerRadius, 0, largeArcFlag, 1, startInner.x, startInner.y,
    "Z",
  ].join(" ");
};

const normalizeDirectionLabel = (raw) => {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return DIRECTION_ALIASES[cleaned] ?? null;
};

const degreesToDirection = (degrees) => {
  if (!Number.isFinite(degrees)) return null;
  // Wrap to [0, 360) and map to nearest 22.5° sector.
  const wrapped = ((degrees % 360) + 360) % 360;
  const idx = Math.round(wrapped / 22.5) % DIRECTION_ORDER.length;
  return DIRECTION_ORDER[idx];
};

const parseWindCsvText = (csvText, options = {}) => {
  const aggregationMode = options.aggregationMode ?? "frequency";
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error("CSV is empty.");
  }

  const delimiter = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const rows = lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));

  const firstRow = rows[0].map((cell) => cell.toLowerCase());
  const hasHeader = firstRow.some((cell) =>
    cell.includes("direction") || cell.includes("dir") || cell.includes("value") ||
    cell.includes("percent") || cell === "station" || cell === "valid" || cell === "sknt" || cell === "drct"
  );

  if (hasHeader) {
    const headerMap = rows[0].map((cell) => cell.trim().toLowerCase().replace(/\s+/g, "_"));
    const degIdx = headerMap.findIndex((cell) =>
      cell.includes("wind_direction") ||
      cell === "direction_deg" ||
      cell === "direction_degrees" ||
      cell === "direction" ||
      cell === "drct" ||
      cell === "dir"
    );
    const speedIdx = headerMap.findIndex((cell) =>
      cell.includes("wind_speed") ||
      cell === "speed" ||
      cell === "velocity" ||
      cell === "sknt" ||
      cell === "knots"
    );

    if (degIdx < 0 && (headerMap.includes("station") || headerMap.includes("valid") || headerMap.includes("sknt"))) {
      throw new Error(`METAR/ASOS format detected but missing wind direction column (drct). Please ensure 'drct' is included in your download.`);
    }

    if (degIdx >= 0) {
      const bins = new Map(DIRECTION_ORDER.map((dir) => [dir, 0]));
      const speedBins = new Map(DIRECTION_ORDER.map((dir) => [dir, [0, 0, 0, 0]])); // [ <10, 10-20, 20-30, >30 ]
      let validWeight = 0;

      rows.slice(1).forEach((row) => {
        const deg = Number.parseFloat(row[degIdx]);
        const dir = degreesToDirection(deg);
        if (!dir) return;

        const rawSpeed = speedIdx >= 0 ? Number.parseFloat(row[speedIdx]) : 0;
        const speedVal = Number.isFinite(rawSpeed) ? rawSpeed : 0;

        const weight = aggregationMode === "speedWeighted"
          ? (speedVal >= 0 ? speedVal : 0)
          : 1;

        if (weight <= 0) return;

        bins.set(dir, (bins.get(dir) ?? 0) + weight);

        const sBins = speedBins.get(dir);
        if (speedVal < 10) sBins[0] += weight;
        else if (speedVal < 20) sBins[1] += weight;
        else if (speedVal < 30) sBins[2] += weight;
        else sBins[3] += weight;

        validWeight += weight;
      });

      if (validWeight === 0) {
        if (aggregationMode === "speedWeighted") {
          throw new Error("No valid positive weights found. Ensure wind_speed values exist for speed-weighted mode.");
        }
        throw new Error("No valid wind_direction degree values found in CSV.");
      }

      return DIRECTION_ORDER.map((dir) => {
        const dVal = bins.get(dir) ?? 0;
        const dSpeeds = speedBins.get(dir);
        return {
          direction: dir,
          value: Number(((dVal / validWeight) * 100).toFixed(1)),
          speeds: [
            Number(((dSpeeds[0] / validWeight) * 100).toFixed(1)),
            Number(((dSpeeds[1] / validWeight) * 100).toFixed(1)),
            Number(((dSpeeds[2] / validWeight) * 100).toFixed(1)),
            Number(((dSpeeds[3] / validWeight) * 100).toFixed(1))
          ]
        };
      });
    }
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0) {
    throw new Error("No data rows found in CSV.");
  }

  const mapped = [];
  let usedIndexMode = false;

  dataRows.forEach((row, idx) => {
    if (row.length === 0) return;

    const direction = normalizeDirectionLabel(row[0]);
    const parsedValue = Number.parseFloat(row[1]);

    if (direction && Number.isFinite(parsedValue)) {
      mapped.push({ direction, value: Math.max(0, parsedValue) });
      return;
    }

    const indexValue = Number.parseFloat(row[0]);
    if (Number.isFinite(indexValue) && row.length === 1) {
      usedIndexMode = true;
      mapped.push({ direction: DIRECTION_ORDER[idx] ?? null, value: Math.max(0, indexValue) });
    }
  });

  if (mapped.length === 0) {
    throw new Error("Expected CSV rows like 'direction,value' or a single value per row in standard 16-direction order.");
  }

  if (usedIndexMode && mapped.some((item) => !item.direction)) {
    throw new Error("Too many rows for index-based mode. Provide up to 16 rows, one value per direction.");
  }

  const directionMap = new Map(DIRECTION_ORDER.map((dir) => [dir, 0]));
  mapped.forEach(({ direction, value }) => {
    if (!directionMap.has(direction)) return;
    directionMap.set(direction, value);
  });

  return DIRECTION_ORDER.map((dir) => ({ direction: dir, value: directionMap.get(dir) ?? 0 }));
};

// ─────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────
const S = {
  app: (dark) => ({
    minHeight: "100vh",
    background: dark
      ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' opacity='0.03'%3E%3Cpath stroke='%23ffffff' stroke-width='0.5' fill='none' d='M0 80 Q 40 40 80 80 T 160 80 M 0 40 Q 40 0 80 40 T 160 40 M 0 120 Q 40 80 80 120 T 160 120'/%3E%3C/svg%3E"), radial-gradient(circle at 50% -10%, #172033 0%, #0a0f18 80%)`
      : "radial-gradient(circle at 15% 15%, rgba(245,158,11,0.2) 0%, transparent 40%), linear-gradient(140deg, #f8fafc 0%, #f1f5f9 100%)",
    color: dark ? "#f8fafc" : "#0f172a",
    fontFamily: "'Inter','Segoe UI',sans-serif",
    transition: "all 0.4s ease",
    padding: "24px"
  }),
  card: (dark) => ({
    background: dark ? "rgba(15,23,42,0.7)" : "rgba(255,255,255,0.75)",
    backdropFilter: "blur(24px)",
    border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`,
    borderRadius: "28px",
    padding: "28px",
    boxShadow: "0 25px 50px rgba(0,0,0,0.3)",
    display: "flex", flexDirection: "column"
  }),
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    maxWidth: "1280px",
    margin: "0 auto 28px auto"
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: "16px"
  },
  logoIcon: {
    width: "56px", height: "56px",
    borderRadius: "18px",
    background: "linear-gradient(135deg,#f59e0b,#6366f1)",
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 8px 32px rgba(217,119,6,0.4)"
  },
  title: {
    fontSize: "28px", fontWeight: 900,
    background: "linear-gradient(90deg,#fbbf24,#a78bfa)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
    margin: 0, letterSpacing: "-1px"
  },
  subtitle: {
    fontSize: "10px", fontWeight: 700,
    letterSpacing: "0.3em", opacity: 0.7,
    textTransform: "uppercase", marginTop: "2px"
  },
  nav: (dark) => ({
    display: "flex", gap: "6px",
    background: dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)",
    border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`,
    borderRadius: "999px",
    padding: "6px",
    maxWidth: "600px",
    margin: "0 auto 28px auto"
  }),
  navBtn: (active, dark) => ({
    flex: 1, padding: "12px 16px",
    borderRadius: "999px", border: "none",
    background: active ? "#f59e0b" : "transparent",
    color: active ? "#fff" : dark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)",
    fontWeight: 800, fontSize: "11px",
    textTransform: "uppercase", letterSpacing: "0.1em",
    cursor: "pointer", transition: "all 0.3s ease",
    display: "flex", alignItems: "center", justifyContent: "center", gap: "6px"
  }),
  label: (dark) => ({
    fontSize: "10px", fontWeight: 800,
    textTransform: "uppercase", letterSpacing: "0.2em",
    opacity: dark ? 0.6 : 0.7, display: "block", marginBottom: "8px"
  }),
  input: (dark) => ({
    width: "100%", padding: "10px 14px",
    borderRadius: "12px", border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.15)"}`,
    background: dark ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.8)",
    color: dark ? "#fff" : "#0f172a",
    fontSize: "13px", fontWeight: 700,
    outline: "none", boxSizing: "border-box"
  }),
  select: (dark) => ({
    width: "100%", padding: "10px 14px",
    borderRadius: "12px", border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.15)"}`,
    background: dark ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.8)",
    color: dark ? "#fff" : "#0f172a",
    fontSize: "13px", fontWeight: 700,
    outline: "none", cursor: "pointer", boxSizing: "border-box"
  }),
  btn: (variant = "primary") => ({
    padding: "12px 20px", borderRadius: "14px", border: "none",
    background: variant === "primary" ? "#f59e0b"
      : variant === "danger" ? "rgba(239,68,68,0.15)"
        : "rgba(255,255,255,0.08)",
    color: variant === "primary" ? "#fff"
      : variant === "danger" ? "#f87171"
        : "inherit",
    fontWeight: 800, fontSize: "11px",
    textTransform: "uppercase", letterSpacing: "0.1em",
    cursor: "pointer", transition: "all 0.2s ease",
    display: "flex", alignItems: "center", gap: "6px"
  }),
  complianceBadge: (ok) => ({
    padding: "24px", borderRadius: "20px",
    background: ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
    border: `2px solid ${ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
    display: "flex", alignItems: "center", gap: "16px"
  }),
  layerRow: (dark) => ({
    display: "flex", alignItems: "center", gap: "12px",
    padding: "14px 16px", borderRadius: "18px",
    background: dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
    border: `1px solid ${dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}`,
    marginBottom: "10px"
  }),
  thickCtrl: (dark) => ({
    display: "flex", alignItems: "center", gap: "4px",
    background: dark ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.9)",
    border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`,
    borderRadius: "12px", padding: "4px"
  }),
  iconBtn: (dark, color) => ({
    width: "32px", height: "32px", borderRadius: "8px", border: "none",
    background: color === "red" ? "rgba(239,68,68,0.15)"
      : color === "green" ? "rgba(34,197,94,0.15)"
        : dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
    color: color === "red" ? "#f87171"
      : color === "green" ? "#4ade80"
        : "inherit",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    transition: "all 0.2s ease"
  })
};

// ─────────────────────────────────────────────
// WIND ROSE COMPONENTS
// ─────────────────────────────────────────────
const WindRoseTypeI = ({ data, dark, activeDirection, onPickDirection }) => {
  const size = 330;
  const center = size / 2;
  const maxRadius = 120;
  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const scale = maxRadius / (maxValue + 2);

  const polygonPoints = data
    .map((item, index) => {
      const angle = index * 22.5;
      const { x, y } = getCoordinates(angle, item.value * scale, center, center);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="hover-card anim-slideUp" style={{ ...S.card(dark), alignItems: "center", justifyContent: "center", padding: "16px" }}>
      <div style={{ textAlign: "center", marginBottom: "16px" }}>
        <h3 style={{ margin: "0", fontSize: "14px", fontWeight: 800 }}>Type I Wind Rose</h3>
        <p style={{ margin: "4px 0 0", fontSize: "11px", opacity: 0.6 }}>Direction vs Duration</p>
      </div>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", width: "100%" }}>
        <svg width="100%" viewBox="0 0 330 330" style={{ maxWidth: "330px", overflow: "visible" }}>
          <defs>
            <radialGradient id="polyGlow" cx="50%" cy="50%" r="70%">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#d97706" stopOpacity="0.2" />
            </radialGradient>
          </defs>

          {[5, 10, 15].map((val) => (
            <g key={`circle-${val}`}>
              <circle cx={center} cy={center} r={val * scale} fill="none" stroke={dark ? "rgba(255,255,255,0.15)" : "#cbd5e1"} strokeDasharray="5 5" />
              <text x={center + 6} y={center - val * scale + 12} fontSize="10" fill={dark ? "rgba(255,255,255,0.5)" : "#64748b"}>{val}%</text>
            </g>
          ))}

          {data.map((item, index) => {
            const angle = index * 22.5;
            const endPos = getCoordinates(angle, maxRadius + 10, center, center);
            const textPos = getCoordinates(angle, maxRadius + 26, center, center);
            const pointPos = getCoordinates(angle, item.value * scale, center, center);
            const isActive = activeDirection === item.direction;
            return (
              <g key={`r-${item.direction}`} style={{ cursor: "pointer" }} onClick={() => onPickDirection?.(item.direction)}>
                <line x1={center} y1={center} x2={endPos.x} y2={endPos.y} stroke={isActive ? "#f59e0b" : dark ? "rgba(255,255,255,0.1)" : "#e2e8f0"} strokeWidth={isActive ? 1.7 : 1} />
                <text x={textPos.x} y={textPos.y} fontSize="10" textAnchor="middle" dominantBaseline="middle" fill={isActive ? "#f59e0b" : dark ? "rgba(255,255,255,0.8)" : "#334155"} fontWeight={isActive ? "800" : "600"}>{item.direction}</text>
                <circle cx={pointPos.x} cy={pointPos.y} r={isActive ? 4 : 2.2} fill={isActive ? "#f59e0b" : "#fbbf24"} opacity={isActive ? 1 : 0.65} />
              </g>
            );
          })}

          <polygon points={polygonPoints} fill="url(#polyGlow)" stroke="#d97706" strokeWidth="2.5" className="anim-popIn" style={{ transformOrigin: "165px 165px" }} />
          <circle cx={center} cy={center} r={4} fill={dark ? "#f8fafc" : "#0f172a"} className="anim-popIn" style={{ transformOrigin: "165px 165px", animationDelay: "0.2s" }} />
        </svg>
      </div>
    </div>
  );
};

const WindRoseTypeII = ({ data, dark, heading, activeDirection, onPickDirection }) => {
  const size = 330;
  const center = size / 2;
  const speedRadii = [42, 84, 126];
  const hasRealSpeeds = data.some(d => d.speeds);

  return (
    <div className="hover-card anim-slideUp" style={{ ...S.card(dark), alignItems: "center", justifyContent: "center", padding: "16px" }}>
      <div style={{ textAlign: "center", marginBottom: "16px" }}>
        <h3 style={{ margin: "0", fontSize: "14px", fontWeight: 800 }}>Type II Wind Rose</h3>
        <p style={{ margin: "4px 0 0", fontSize: "11px", opacity: 0.6 }}>
          {hasRealSpeeds ? "Generated from Actual CSV Speed Bins (Knots)" : "Generated by Assumed Speed Distribution (50% / 30% / 20%)"}
        </p>
      </div>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", width: "100%" }}>
        <svg width="100%" viewBox="0 0 330 330" style={{ maxWidth: "330px", overflow: "visible" }}>
          {speedRadii.map((r, i) => (
            <circle key={i} cx={center} cy={center} r={r} fill="none" stroke={dark ? "rgba(255,255,255,0.2)" : "#334155"} strokeWidth="1" opacity="0.45" />
          ))}
          {data.map((_, index) => {
            const angle = index * 22.5 - 11.25;
            const endPos = getCoordinates(angle, 126, center, center);
            return <line key={`b-${index}`} x1={center} y1={center} x2={endPos.x} y2={endPos.y} stroke={dark ? "rgba(255,255,255,0.2)" : "#334155"} strokeWidth="1" opacity="0.55" />;
          })}
          {data.map((item, index) => {
            const angle = index * 22.5;
            const labelPos = getCoordinates(angle, 142, center, center);
            const isActive = activeDirection === item.direction;

            let innerVal, midVal, outerVal;
            if (item.speeds) {
              innerVal = item.speeds[0].toFixed(1);
              midVal = item.speeds[1].toFixed(1);
              outerVal = (item.speeds[2] + item.speeds[3]).toFixed(1);
            } else {
              innerVal = (item.value * 0.5).toFixed(1);
              midVal = (item.value * 0.3).toFixed(1);
              outerVal = (item.value * 0.2).toFixed(1);
            }

            const innerPos = getCoordinates(angle, 30, center, center);
            const middlePos = getCoordinates(angle, 63, center, center);
            const outerPos = getCoordinates(angle, 104, center, center);

            return (
              <g key={item.direction} style={{ cursor: "pointer" }} onClick={() => onPickDirection?.(item.direction)}>
                <text x={labelPos.x} y={labelPos.y} fontSize="10" fontWeight={isActive ? "900" : "700"} fill={isActive ? "#f59e0b" : dark ? "#f87171" : "#be123c"} textAnchor="middle" dominantBaseline="middle">{item.direction}</text>
                {item.value > 0 && (
                  <>
                    <text x={innerPos.x} y={innerPos.y} fontSize="8" textAnchor="middle" fill={dark ? "#e2e8f0" : "#0f172a"}>{innerVal}</text>
                    <text x={middlePos.x} y={middlePos.y} fontSize="8" textAnchor="middle" fill={dark ? "#e2e8f0" : "#0f172a"}>{midVal}</text>
                    <text x={outerPos.x} y={outerPos.y} fontSize="8" textAnchor="middle" fill={dark ? "#e2e8f0" : "#0f172a"}>{outerVal}</text>
                  </>
                )}
              </g>
            );
          })}
          <circle cx={center} cy={center} r={16} fill={dark ? "#0f172a" : "#f8fafc"} stroke={dark ? "rgba(255,255,255,0.2)" : "#334155"} />
          <text x={center} y={center} fontSize="9" textAnchor="middle" dominantBaseline="middle" fill={dark ? "#e2e8f0" : "#0f172a"}>Calm</text>
          {heading !== undefined && (
            <rect
              x={center - 35}
              y={center - 145}
              width={70}
              height={290}
              fill="rgba(79, 129, 189, 0.3)"
              stroke="rgba(43, 87, 132, 0.9)"
              strokeWidth="2.5"
              transform={`rotate(${heading}, ${center}, ${center})`}
              pointerEvents="none"
            />
          )}
        </svg>
      </div>
    </div>
  );
};

const WindRoseStacked = ({ data, dark, activeDirection, onPickDirection }) => {
  const size = 430;
  const center = size / 2;
  const maxRadius = 170;
  const calmRadius = 18;
  const wedgeAngle = 22.5;
  const rawMax = Math.max(...data.map((d) => d.value), 1);
  // Ensure the top value rounds up to a multiple of 4 so grid rings are always integers
  const maxValue = Math.ceil((rawMax + 2) / 4) * 4;
  const scale = (maxRadius - calmRadius) / maxValue;

  const hasRealSpeeds = data.some(d => d.speeds);
  const speedColors = ["#fde047", "#fb7185", "#34d399", "#38bdf8"];
  const speedLabels = ["Low (<10kts)", "Medium (10-20kts)", "High (20-30kts)", "Severe (>30kts)"];

  return (
    <div className="hover-card anim-slideUp" style={{ ...S.card(dark), display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ textAlign: "center", marginBottom: "20px" }}>
        <h3 style={{ margin: "0", fontSize: "16px", fontWeight: 800 }}>Stacked Polar Wind Rose</h3>
        <p style={{ margin: "4px 0 0", fontSize: "12px", opacity: 0.6 }}>
          {hasRealSpeeds ? "Proportional knots bins from CSV data" : "Proportional speed bins by direction (Simulated)"}
        </p>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "60px", width: "100%", alignItems: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flex: 1 }}>
          <svg width="100%" viewBox="0 0 430 430" style={{ maxWidth: "430px", overflow: "visible" }}>
            {[0.25, 0.5, 0.75, 1].map((ratio) => {
              const currentRadius = calmRadius + (maxRadius - calmRadius) * ratio;
              const val = Math.round(maxValue * ratio);
              return (
                <g key={ratio}>
                  <circle cx={center} cy={center} r={currentRadius} fill="none" stroke={dark ? "rgba(255,255,255,0.15)" : "#cbd5e1"} strokeDasharray="4 6" />
                  <text x={center + 6} y={center - currentRadius + 14} fontSize="11" fill={dark ? "rgba(255,255,255,0.5)" : "#64748b"}>
                    {val}%
                  </text>
                </g>
              );
            })}
            {data.map((item, index) => {
              const startAngle = index * wedgeAngle - wedgeAngle / 2;
              const endAngle = startAngle + wedgeAngle;
              const isActive = activeDirection === item.direction;
              let currentInnerRadius = calmRadius;

              const speeds = item.speeds || [item.value * 0.2, item.value * 0.3, item.value * 0.3, item.value * 0.2];
              return (
                <g key={item.direction} style={{ cursor: "pointer" }} onClick={() => onPickDirection?.(item.direction)}>
                  {speeds.map((speedValue, speedIndex) => {
                    if (speedValue <= 0) return null;
                    const thickness = speedValue * scale;
                    const outerRadius = currentInnerRadius + thickness;
                    const path = describeWedge(center, center, currentInnerRadius, outerRadius, startAngle, endAngle);
                    currentInnerRadius = outerRadius;
                    const animDelay = `${(index * 0.02) + (speedIndex * 0.1)}s`;
                    return (
                      <path
                        key={`${item.direction}-${speedIndex}`}
                        className="wedge-interactive anim-wedge"
                        style={{ animationDelay: animDelay }}
                        d={path}
                        fill={speedColors[speedIndex]}
                        stroke={dark ? "#020617" : "#1e293b"}
                        strokeWidth={isActive ? "1.4" : "0.6"}
                        opacity={isActive ? "1" : activeDirection ? "0.35" : "0.95"}
                      >
                        <title>{item.direction} - {speedLabels[speedIndex]}: {Math.round(speedValue)}%</title>
                      </path>
                    );
                  })}
                </g>
              );
            })}
            <text x={center} y={center - maxRadius - 16} textAnchor="middle" fontSize="13" fill={dark ? "#f8fafc" : "#0f172a"} fontWeight="700">N</text>
            <text x={center} y={center + maxRadius + 24} textAnchor="middle" fontSize="13" fill={dark ? "#f8fafc" : "#0f172a"} fontWeight="700">S</text>
            <text x={center + maxRadius + 18} y={center + 4} textAnchor="start" fontSize="13" fill={dark ? "#f8fafc" : "#0f172a"} fontWeight="700">E</text>
            <text x={center - maxRadius - 18} y={center + 4} textAnchor="end" fontSize="13" fill={dark ? "#f8fafc" : "#0f172a"} fontWeight="700">W</text>
            <circle cx={center} cy={center} r={calmRadius} fill={dark ? "#0f172a" : "#ffffff"} stroke={dark ? "rgba(255,255,255,0.2)" : "#334155"} />
          </svg>
        </div>

        <div style={{ padding: "16px 24px", borderRadius: "16px", background: dark ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.7)", border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}` }}>
          <h4 style={{ margin: "0 0 12px 0", fontSize: "12px", fontWeight: 800, textTransform: "uppercase", opacity: 0.8 }}>Speed Bins</h4>
          {speedLabels.map((label, i) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px", fontSize: "11px", fontWeight: 700 }}>
              <span style={{ width: "20px", height: "14px", borderRadius: "4px", background: speedColors[i] }} />
              <span style={{ opacity: 0.9 }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
const findOptimalDirection = (dataArr) => {
  const total = dataArr.reduce((sum, d) => sum + (Number.isFinite(d.value) ? d.value : 0), 0);
  if (total === 0) return 4;
  let bestIdx = 4;
  let maxCov = -1;
  for (let i = 0; i < RUNWAY_DIRECTIONS.length; i++) {
    const head = RUNWAY_DIRECTIONS[i].angle;
    let valid = 0;
    dataArr.forEach((d, j) => {
      const angle = j * 22.5;
      const theta = Math.abs(angle - head) * (Math.PI / 180);
      if (ASSUMED_WIND_SPEED * Math.abs(Math.sin(theta)) <= GUIDELINES.FAA.crosswind_small) {
        valid += d.value;
      }
    });
    if (valid > maxCov) { maxCov = valid; bestIdx = i; }
  }
  return bestIdx;
};

export default function App() {
  const [dark, setDark] = useState(true);
  const [tab, setTab] = useState("dashboard");
  const [loading, setLoading] = useState(true);

  // New Wind state
  const [data, setData] = useState(() => normalizeDataOrder(initialDataRaw));
  const [dirIdx, setDirIdx] = useState(() => findOptimalDirection(normalizeDataOrder(initialDataRaw)));
  const [activeDirection, setActiveDirection] = useState(null);
  const [csvAggregationMode, setCsvAggregationMode] = useState("frequency");
  const [csvFeedback, setCsvFeedback] = useState(null);
  const [csvFileName, setCsvFileName] = useState("");
  const csvInputRef = useRef(null);
  const heading = RUNWAY_DIRECTIONS[dirIdx].angle;

  // Pavement state
  const [pavementType, setPavementType] = useState("Flexible");
  const [aircraft, setAircraft] = useState({
    model: "B-747", gear: "Dual Tandem",
    grossWeight: 450000, wheelLoad: 112500,
    departures: 15000, subgradeCBR: 6
  });
  const [layers, setLayers] = useState(DEFAULT_LAYERS);

  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 1200);
    return () => clearTimeout(t);
  }, []);

  const handleChange = (index, newValue) => {
    const updated = [...data];
    updated[index].value = parseFloat(newValue) || 0;
    setData(updated);
  };

  const handleCsvFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      const parsed = parseWindCsvText(content, { aggregationMode: csvAggregationMode });
      setData(parsed);
      setDirIdx(findOptimalDirection(parsed));
      setTab("wind");
      setActiveDirection(null);
      setCsvFileName(file.name);
      setCsvFeedback({
        type: "success",
        message: `Loaded ${file.name} successfully (${CSV_AGGREGATION_MODES[csvAggregationMode]}).`
      });
    } catch (err) {
      setCsvFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to parse CSV file."
      });
    } finally {
      // Reset input so selecting the same file again still triggers onChange.
      event.target.value = "";
    }
  };

  const total = useMemo(
    () => data.reduce((sum, d) => sum + (Number.isFinite(d.value) ? d.value : 0), 0),
    [data]
  );

  // ── Coverage Calculation ──
  const coverage = useMemo(() => {
    if (total === 0) return (0).toFixed(1);
    let valid = 0;
    data.forEach((d, i) => {
      const angle = i * 22.5;
      const theta = Math.abs(angle - heading) * (Math.PI / 180);
      if (ASSUMED_WIND_SPEED * Math.abs(Math.sin(theta)) <= GUIDELINES.FAA.crosswind_small) {
        valid += d.value;
      }
    });
    return ((valid / total) * 100).toFixed(1);
  }, [data, heading, total]);

  const compliant = parseFloat(coverage) >= 95.0;

  // ── Layer Controls ──
  const updateThick = (id, delta) =>
    setLayers(prev => prev.map(l =>
      l.id === id && l.name !== "Subgrade"
        ? { ...l, thickness: Math.max(1, l.thickness + delta) }
        : l
    ));

  const removeLayer = (id) =>
    setLayers(prev => prev.filter(l => l.id !== id || l.name === "Subgrade"));

  const addLayer = (type) => {
    const map = {
      Surface: { name: "P-401 HMA Surface", thickness: 4, modulus: 400000, color: "#334155" },
      Base: { name: "P-209 Base Course", thickness: 6, modulus: 75000, color: "#78716c" },
      Subbase: { name: "P-154 Subbase", thickness: 8, modulus: 35000, color: "#a8a29e" }
    };
    const newLayer = { id: Date.now(), ...map[type] };
    const idx = layers.findIndex(l => l.name === "Subgrade");
    const next = [...layers];
    next.splice(idx, 0, newLayer);
    setLayers(next);
  };

  // ── Loading Screen ──
  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#0f172a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "20px" }}>
        <div style={{ animation: "spin 1.5s linear infinite", display: "inline-block" }}>
          <Wind size={56} color="#f59e0b" />
        </div>
        <div style={{ color: "#fbbf24", fontSize: "14px", fontWeight: 700, letterSpacing: "0.3em", textTransform: "uppercase" }}>
          Loading AeroDesign Pro...
        </div>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const card = S.card(dark);

  // ════════════════════════════════════════════
  return (
    <div style={S.app(dark)}>
      {/* ── UNREAL ENGINE 5 HEADER ── */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: "1400px", margin: "0 auto 40px auto", padding: '24px', position: 'relative', zIndex: 100 }}>
        {/* Left: Glowing Amber Icon */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div className="anim-popIn" style={{ filter: 'drop-shadow(0 0 16px rgba(245,158,11,0.9))' }}>
            <Wind color="#f59e0b" size={38} strokeWidth={2.5} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 900, letterSpacing: "1px", color: dark ? "#f8fafc" : "#0f172a", textShadow: dark ? "0 4px 20px rgba(0,0,0,0.5)" : "none" }}>
              AERO<span style={{ color: "#f59e0b" }}>PRO</span>
            </h1>
          </div>
        </div>

        {/* Center: Floating Glassmorphism Nav */}
        <nav className="hover-card anim-slideUp" style={{
          position: 'absolute', left: '50%', transform: 'translateX(-50%)',
          background: dark ? 'rgba(15, 20, 35, 0.45)' : 'rgba(255,255,255,0.6)',
          backdropFilter: 'blur(32px) saturate(150%)',
          WebkitBackdropFilter: 'blur(32px) saturate(150%)',
          border: `1px solid ${dark ? 'rgba(245,158,11,0.15)' : 'rgba(0,0,0,0.1)'}`,
          borderRadius: '99px',
          padding: '6px',
          display: 'flex', gap: '4px',
          boxShadow: dark ? '0 25px 50px rgba(0,0,0,0.5), inset 0 0 10px rgba(245,158,11,0.05)' : '0 25px 50px rgba(0,0,0,0.1)'
        }}>
          {[
            { id: "dashboard", label: "Windrose Gen" },
            { id: "wind", label: "ANALYSIS" },
            { id: "pavement", label: "PAVEMENT SECTION" }
          ].map(t => (
            <button
              key={t.id}
              className="nav-btn-interactive"
              style={{
                padding: "12px 28px", borderRadius: "99px", border: "none",
                fontWeight: 800, fontSize: "11px", letterSpacing: "0.15em", cursor: "pointer",
                transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                background: tab === t.id ? (dark ? "rgba(245,158,11,0.15)" : "#f59e0b") : "transparent",
                color: tab === t.id ? (dark ? "#fbbf24" : "#fff") : (dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)"),
                boxShadow: tab === t.id && dark ? "inset 0 0 20px rgba(245,158,11,0.2)" : "none",
                textShadow: tab === t.id && dark ? "0 0 12px rgba(245,158,11,0.7)" : "none"
              }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Right: Minimalist Circular Dark Mode Toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            onClick={() => csvInputRef.current?.click()}
            className="hover-card"
            style={{
              padding: "10px 14px",
              borderRadius: "999px",
              border: `1px solid ${dark ? "rgba(125,211,252,0.35)" : "rgba(2,132,199,0.35)"}`,
              background: dark ? "rgba(14,116,144,0.2)" : "rgba(186,230,253,0.9)",
              color: dark ? "#7dd3fc" : "#075985",
              fontSize: "10px",
              fontWeight: 800,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: "pointer"
            }}
          >
            <Upload size={13} /> CSV Import
          </button>
          <button onClick={() => setDark(!dark)} className="hover-card" style={{
            width: "48px", height: "48px", borderRadius: "50%",
            background: dark ? "rgba(15, 20, 35, 0.5)" : "rgba(255,255,255,0.8)",
            backdropFilter: 'blur(16px)',
            border: `1px solid ${dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)'}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", transition: "all 0.3s ease",
            boxShadow: "0 10px 25px rgba(0,0,0,0.3)"
          }}>
            <Sun size={20} color={dark ? "#94a3b8" : "#f59e0b"} />
          </button>
        </div>
      </header>

      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleCsvFile}
        style={{ display: "none" }}
      />

      <div
        style={{
          position: "fixed",
          right: "16px",
          bottom: "16px",
          zIndex: 9999,
          background: dark ? "rgba(15,23,42,0.96)" : "rgba(255,255,255,0.98)",
          border: `2px solid ${dark ? "rgba(56,189,248,0.65)" : "rgba(2,132,199,0.55)"}`,
          borderRadius: "14px",
          boxShadow: "0 20px 40px rgba(0,0,0,0.35)",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          minWidth: "250px"
        }}
      >
        <div style={{ fontSize: "10px", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.12em", color: dark ? "#7dd3fc" : "#0369a1" }}>
          Upload CSV Here
        </div>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={handleCsvFile}
          style={{ fontSize: "11px" }}
        />
        <button
          onClick={() => csvInputRef.current?.click()}
          style={{
            ...S.btn("ghost"),
            justifyContent: "center",
            border: `1px solid ${dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"}`,
            padding: "8px 10px",
            fontSize: "10px"
          }}
        >
          <Upload size={12} /> Choose File
        </button>
      </div>

      <section className="hover-card anim-slideUp" style={{ ...card, maxWidth: "1280px", margin: "0 auto 20px auto", padding: "16px", borderRadius: "18px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ fontSize: "11px", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.14em", opacity: 0.8 }}>
              Upload CSV To Generate Wind Rose
            </div>
            <div style={{ fontSize: "11px", opacity: 0.7 }}>
              Supports: IEM ASOS (drct, sknt) | Date/Time (wind_direction, wind_speed in knots)
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
            <select
              value={csvAggregationMode}
              onChange={(e) => setCsvAggregationMode(e.target.value)}
              style={{ ...S.select(dark), width: "180px", padding: "8px 10px", borderRadius: "10px", fontSize: "11px", fontWeight: 800 }}
            >
              <option value="frequency">Frequency (count)</option>
              <option value="speedWeighted">Speed-weighted</option>
            </select>

            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleCsvFile}
              style={{ fontSize: "11px", maxWidth: "260px" }}
            />

            <button
              onClick={() => csvInputRef.current?.click()}
              style={{
                ...S.btn("ghost"),
                padding: "8px 12px",
                fontSize: "10px",
                borderRadius: "10px",
                border: `1px solid ${dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"}`,
                background: dark ? "rgba(56,189,248,0.15)" : "rgba(2,132,199,0.12)",
                color: dark ? "#7dd3fc" : "#0369a1"
              }}
            >
              <Upload size={12} /> Browse
            </button>
          </div>
        </div>

        {(csvFileName || csvFeedback) && (
          <div style={{ marginTop: "10px", display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            {csvFileName && (
              <div style={{ fontSize: "10px", fontWeight: 700, opacity: 0.75 }}>
                Selected: {csvFileName}
              </div>
            )}
            {csvFeedback && (
              <div
                style={{
                  fontSize: "10px",
                  padding: "7px 10px",
                  borderRadius: "8px",
                  border: `1px solid ${csvFeedback.type === "success" ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)"}`,
                  background: csvFeedback.type === "success" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
                  color: csvFeedback.type === "success" ? "#4ade80" : "#f87171",
                  fontWeight: 700
                }}
              >
                {csvFeedback.message}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ══════════════════════════════════
          DASHBOARD TAB
      ══════════════════════════════════ */}
      {tab === "dashboard" && (
        <div style={{ maxWidth: "1280px", margin: "0 auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "20px", marginBottom: "20px" }}>
            <div className="hover-card anim-slideUp" style={card}>
              <div style={{ fontSize: "10px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.6, marginBottom: "12px" }}>Wind Coverage</div>
              <div style={{ fontSize: "42px", fontWeight: 900, color: compliant ? "#4ade80" : "#f87171", lineHeight: 1 }}>{coverage}%</div>
              <div style={{ fontSize: "11px", opacity: 0.6, marginTop: "8px" }}>ICAO Threshold: 95%</div>
            </div>
            <div className="hover-card anim-slideUp" style={card}>
              <div style={{ fontSize: "10px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.6, marginBottom: "12px" }}>Runway Direction</div>
              <div style={{ fontSize: "36px", fontWeight: 900, color: "#fbbf24", lineHeight: 1 }}>{RUNWAY_DIRECTIONS[dirIdx].label}</div>
              <div style={{ fontSize: "11px", opacity: 0.6, marginTop: "8px" }}>Primary orientation</div>
            </div>
            <div className="hover-card anim-slideUp" style={card}>
              <div style={{ fontSize: "10px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.6, marginBottom: "12px" }}>Pavement Layers</div>
              <div style={{ fontSize: "42px", fontWeight: 900, color: "#a78bfa", lineHeight: 1 }}>{layers.length}</div>
              <div style={{ fontSize: "11px", opacity: 0.6, marginTop: "8px" }}>{pavementType} pavement type</div>
            </div>
          </div>

          <div className="hover-card anim-slideUp" style={card}>
            <div style={S.complianceBadge(compliant)}>
              {compliant
                ? <ShieldCheck size={48} color="#4ade80" />
                : <AlertTriangle size={48} color="#f87171" style={{ animation: "pulse 1s infinite" }} />}
              <div>
                <div style={{ fontWeight: 900, fontSize: "16px", color: compliant ? "#4ade80" : "#f87171" }}>
                  {compliant ? "✅ Design Compliant" : "❌ Compliance Failure"}
                </div>
                <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "4px" }}>
                  {compliant
                    ? "Wind coverage meets FAA & ICAO requirements. Design approved."
                    : `Wind coverage ${coverage}% is below the required 95% ICAO threshold. Adjust runway heading.`}
                </div>
              </div>
            </div>

            <div style={{ marginTop: "24px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}` }}>
                    {["Parameter", "Value", "Standard", "Status"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "10px 8px", fontWeight: 800, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.6 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { param: "Wind Coverage", value: `${coverage}%`, std: "≥ 95%", ok: compliant },
                    { param: "Runway Direction", value: RUNWAY_DIRECTIONS[dirIdx].label, std: "Compass Axes", ok: true },
                    { param: "Crosswind Limit (Small)", value: "10.5 kts", std: "FAA AC 150/5300", ok: true },
                    { param: "Pavement Type", value: pavementType, std: "FAA P-Series", ok: true },
                    { param: "Surface Layer", value: layers[0]?.name || "—", std: "P-401 Required", ok: layers[0]?.name?.includes("P-401") }
                  ].map((row, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)"}` }}>
                      <td style={{ padding: "10px 8px", fontWeight: 700 }}>{row.param}</td>
                      <td style={{ padding: "10px 8px", color: "#fbbf24", fontWeight: 800 }}>{row.value}</td>
                      <td style={{ padding: "10px 8px", opacity: 0.6 }}>{row.std}</td>
                      <td style={{ padding: "10px 8px" }}>
                        {row.ok
                          ? <span style={{ color: "#4ade80", fontWeight: 800, fontSize: "11px" }}>✓ Pass</span>
                          : <span style={{ color: "#f87171", fontWeight: 800, fontSize: "11px" }}>✗ Fail</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════
          WIND ANALYSIS TAB
      ══════════════════════════════════ */}
      {tab === "wind" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "1280px", margin: "0 auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "20px", alignItems: "start" }}>
            {/* LEFT COLUMN: Controls & Input Table */}
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              {/* Runway Orientation */}
              <div className="hover-card anim-slideUp" style={card}>
                <div style={{ fontSize: "11px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.6, marginBottom: "16px" }}>Runway Orientation</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
                  <span style={{ fontWeight: 700, opacity: 0.8 }}>Direction</span>
                  <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button
                      onClick={() => setDirIdx(findOptimalDirection(data))}
                      style={{ padding: "4px 8px", background: "rgba(245,158,11,0.2)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.4)", borderRadius: "6px", fontSize: "9px", fontWeight: "bold", cursor: "pointer", textTransform: "uppercase", display: "flex", alignItems: "center" }}
                    >
                      <Sparkles size={10} style={{ marginRight: "4px" }} /> Auto Optimize
                    </button>
                    <span style={{ fontWeight: 900, color: "#fbbf24", fontSize: "20px" }}>{RUNWAY_DIRECTIONS[dirIdx].label}</span>
                  </div>
                </div>
                <input type="range" min="0" max="7" step="1" value={dirIdx} onChange={(e) => setDirIdx(parseInt(e.target.value))} style={{ width: "100%", accentColor: "#f59e0b", cursor: "pointer" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", opacity: 0.5, marginTop: "6px" }}><span>N-S</span><span>E-W</span><span>SSE-NNW</span></div>
              </div>

              {/* Compliance Badge */}
              <div className="hover-card anim-slideUp" style={card}>
                <div style={{ fontSize: "11px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.6, marginBottom: "16px" }}>Safety Compliance</div>
                <div style={{ textAlign: "center", padding: "20px", borderRadius: "18px", background: compliant ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", border: `2px solid ${compliant ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}` }}>
                  <div style={{ fontSize: "52px", fontWeight: 900, color: compliant ? "#4ade80" : "#f87171", lineHeight: 1 }}>{coverage}%</div>
                  <div style={{ fontSize: "11px", marginTop: "8px", fontWeight: 700, color: compliant ? "#4ade80" : "#f87171" }}>{compliant ? "✅ THRESHOLD MET" : "❌ BELOW LIMIT"}</div>
                </div>
              </div>

              {/* Data Table */}
              <div className="hover-card anim-slideUp" style={{ ...card, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "20px 20px 10px 20px", fontSize: "11px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}><FileText size={14} /> Vector Data</div>
                  <span style={{ background: dark ? "rgba(245,158,11,0.15)" : "rgba(245,158,11,0.1)", color: "#f59e0b", padding: "4px 8px", borderRadius: "6px", fontSize: "9px" }}>TOTAL: {total.toFixed(1)}%</span>
                </div>
                <div style={{ padding: "0 20px 12px 20px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      value={csvAggregationMode}
                      onChange={(e) => setCsvAggregationMode(e.target.value)}
                      style={{
                        ...S.select(dark),
                        width: "170px",
                        padding: "8px 10px",
                        borderRadius: "10px",
                        fontSize: "10px",
                        fontWeight: 800
                      }}
                    >
                      <option value="frequency">Frequency (count)</option>
                      <option value="speedWeighted">Speed-weighted</option>
                    </select>
                    <button
                      onClick={() => csvInputRef.current?.click()}
                      style={{
                        ...S.btn("ghost"),
                        padding: "8px 12px",
                        fontSize: "10px",
                        borderRadius: "10px",
                        border: `1px solid ${dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"}`,
                        background: dark ? "rgba(56,189,248,0.15)" : "rgba(2,132,199,0.12)",
                        color: dark ? "#7dd3fc" : "#0369a1"
                      }}
                    >
                      <Upload size={12} /> Import CSV
                    </button>
                    <span style={{ fontSize: "10px", opacity: 0.65 }}>
                      Supports: wind_direction/drct + wind_speed/sknt (knots) for stack graphs
                    </span>
                  </div>
                  <div style={{ fontSize: "10px", opacity: 0.75, fontWeight: 700 }}>
                    Diagram Interaction: click any direction in table or chart to highlight it.
                  </div>
                  {csvFeedback && (
                    <div
                      style={{
                        fontSize: "10px",
                        padding: "8px 10px",
                        borderRadius: "8px",
                        border: `1px solid ${csvFeedback.type === "success" ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)"}`,
                        background: csvFeedback.type === "success" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
                        color: csvFeedback.type === "success" ? "#4ade80" : "#f87171",
                        fontWeight: 700
                      }}
                    >
                      {csvFeedback.message}
                    </div>
                  )}
                </div>
                <div style={{ maxHeight: "380px", overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", borderSpacing: 0 }}>
                    <thead style={{ position: "sticky", top: 0, zIndex: 10, background: dark ? "rgba(15,23,42,0.95)" : "rgba(255,255,255,0.95)", backdropFilter: "blur(10px)" }}>
                      <tr>
                        <th style={{ textAlign: "left", padding: "10px 20px", borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`, fontWeight: 800 }}>DIR</th>
                        <th style={{ textAlign: "right", padding: "10px 20px", borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`, fontWeight: 800 }}>VALUE (%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((item, index) => (
                        <tr
                          key={item.direction}
                          onClick={() => setActiveDirection((prev) => (prev === item.direction ? null : item.direction))}
                          style={{
                            borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)"}`,
                            background: activeDirection === item.direction
                              ? (dark ? "rgba(245,158,11,0.12)" : "rgba(245,158,11,0.1)")
                              : "transparent",
                            cursor: "pointer"
                          }}
                        >
                          <td style={{ padding: "8px 20px", fontWeight: 700 }}>{item.direction}</td>
                          <td style={{ padding: "6px 20px", display: "flex", justifyContent: "flex-end" }}>
                            <input
                              type="number" step="0.1" min="0" value={item.value} onChange={(e) => handleChange(index, e.target.value)}
                              style={{ ...S.input(dark), padding: "6px 10px", borderRadius: "8px", width: "80px", textAlign: "right" }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: the 3 SVG Charts */}
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                <WindRoseTypeI data={data} dark={dark} activeDirection={activeDirection} onPickDirection={setActiveDirection} />
                <WindRoseTypeII data={data} dark={dark} heading={heading} activeDirection={activeDirection} onPickDirection={setActiveDirection} />
              </div>
              <WindRoseStacked data={data} dark={dark} activeDirection={activeDirection} onPickDirection={setActiveDirection} />
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════
          PAVEMENT LAB TAB
      ══════════════════════════════════ */}
      {tab === "pavement" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", maxWidth: "1280px", margin: "0 auto" }}>
          <div className="hover-card anim-slideUp" style={card}>
            <h3 style={{ margin: "0 0 20px 0", fontSize: "16px", fontWeight: 900, display: "flex", alignItems: "center", gap: "8px" }}>
              <Layout size={18} color="#f59e0b" /> Design Parameters
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <label style={S.label(dark)}>Pavement Type</label>
                <select style={S.select(dark)} value={pavementType} onChange={(e) => setPavementType(e.target.value)}>
                  <option>Flexible</option>
                  <option>Rigid</option>
                </select>
              </div>
              <div>
                <label style={S.label(dark)}>Aircraft Model</label>
                <input style={S.input(dark)} value={aircraft.model} onChange={(e) => setAircraft({ ...aircraft, model: e.target.value })} />
              </div>
              <div>
                <label style={S.label(dark)}>Gear Configuration</label>
                <select style={S.select(dark)} value={aircraft.gear} onChange={(e) => setAircraft({ ...aircraft, gear: e.target.value })}>
                  <option>Single</option>
                  <option>Dual</option>
                  <option>Dual Tandem</option>
                  <option>Double Dual Tandem</option>
                </select>
              </div>
              <div>
                <label style={S.label(dark)}>Gross Weight (lbs)</label>
                <input style={S.input(dark)} type="number" value={aircraft.grossWeight} onChange={(e) => setAircraft({ ...aircraft, grossWeight: parseFloat(e.target.value) || 0 })} />
              </div>
              <div>
                <label style={S.label(dark)}>Annual Departures</label>
                <input style={S.input(dark)} type="number" value={aircraft.departures} onChange={(e) => setAircraft({ ...aircraft, departures: parseFloat(e.target.value) || 0 })} />
              </div>
              <div>
                <label style={S.label(dark)}>Subgrade CBR</label>
                <input style={S.input(dark)} type="number" value={aircraft.subgradeCBR} onChange={(e) => setAircraft({ ...aircraft, subgradeCBR: parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 900, display: "flex", alignItems: "center", gap: "8px" }}>
                <Layers size={18} color="#f59e0b" /> Structural Section
              </h3>
              <button onClick={() => setLayers(DEFAULT_LAYERS)} style={S.iconBtn(dark, "red")}>
                <RotateCcw size={16} />
              </button>
            </div>

            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
              {["Surface", "Base", "Subbase"].map(type => (
                <button key={type} onClick={() => addLayer(type)} style={{ ...S.btn("ghost"), fontSize: "10px", padding: "8px 12px", borderRadius: "10px", border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`, background: dark ? "rgba(245,158,11,0.1)" : "rgba(245,158,11,0.08)", color: "#fbbf24" }}>
                  <Plus size={12} /> {type}
                </button>
              ))}
            </div>

            <div>
              {layers.map(l => (
                <div key={l.id} style={S.layerRow(dark)}>
                  <div style={{ width: "14px", height: "40px", borderRadius: "6px", background: l.color, flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</div>
                    <div style={{ fontSize: "10px", opacity: 0.6, marginTop: "2px" }}>E = {l.modulus.toLocaleString()} psi</div>
                  </div>
                  {l.name !== "Subgrade" && (
                    <div style={S.thickCtrl(dark)}>
                      <button style={S.iconBtn(dark, "red")} onClick={() => updateThick(l.id, -1)}><Minus size={13} /></button>
                      <span style={{ minWidth: "36px", textAlign: "center", fontWeight: 900, fontSize: "13px" }}>{l.thickness}"</span>
                      <button style={S.iconBtn(dark, "green")} onClick={() => updateThick(l.id, 1)}><Plus size={13} /></button>
                    </div>
                  )}
                  {l.name !== "Subgrade" && (
                    <button style={S.iconBtn(dark, "red")} onClick={() => removeLayer(l.id)}><Trash2 size={14} /></button>
                  )}
                  {l.name === "Subgrade" && (
                    <div style={{ fontSize: "10px", opacity: 0.5, fontStyle: "italic" }}>CBR {aircraft.subgradeCBR}</div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: "20px" }}>
              <div style={{ fontSize: "10px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.6, marginBottom: "10px" }}>Cross Section Preview</div>
              <div style={{ borderRadius: "14px", overflow: "hidden", border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}` }}>
                {layers.map((l, i) => {
                  const total = layers.reduce((s, x) => s + (x.thickness || 12), 0);
                  const h = Math.max(28, ((l.thickness || 12) / total) * 160);
                  return (
                    <div key={l.id} style={{ height: `${h}px`, background: l.color, display: "flex", alignItems: "center", paddingLeft: "14px", gap: "10px" }}>
                      <span style={{ fontSize: "11px", fontWeight: 800, color: i > 1 ? "#1e293b" : "#f8fafc" }}>{l.name}</span>
                      <span style={{ fontSize: "10px", opacity: 0.8, color: i > 1 ? "#1e293b" : "#f8fafc" }}>{l.thickness || "∞"}"</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: "10px", fontSize: "11px", opacity: 0.7, textAlign: "right" }}>
                Total Section: {layers.filter(l => l.name !== "Subgrade").reduce((s, l) => s + (l.thickness || 0), 0)}" above subgrade
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        @keyframes popIn {
          0% { transform: scale(0.85); opacity: 0; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes slideUp {
          0% { transform: translateY(30px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes wedgeDraw {
          0% { transform: scale(0) rotate(-15deg); opacity: 0; }
          100% { transform: scale(1) rotate(0deg); opacity: 0.95; }
        }

        .anim-popIn { animation: popIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .anim-slideUp { animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .anim-wedge { animation: wedgeDraw 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) backwards; transform-origin: 215px 215px; }

        .wedge-interactive {
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          cursor: pointer;
        }
        .wedge-interactive:hover {
          transform: scale(1.06);
          opacity: 1 !important;
          stroke-width: 1.5px;
          filter: drop-shadow(0 4px 12px rgba(255,255,255,0.3));
        }

        .hover-card {
          transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .hover-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 30px 60px rgba(0,0,0,0.5) !important;
        }

        * { box-sizing: border-box; }
        input[type=range]::-webkit-slider-thumb { cursor: pointer; transition: transform 0.2s; }
        input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.25); }
      `}</style>
    </div>
  );
}
