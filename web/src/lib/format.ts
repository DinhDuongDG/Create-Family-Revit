import type { Bounds, ResolvedParameter } from "@family/spec-core";

export type Units = "mm" | "ft-in";

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function mmToFeetInches(mm: number): string {
  if (!Number.isFinite(mm)) return "—";
  const sign = mm < 0 ? "-" : "";
  const inches = Math.abs(mm) / 25.4;
  let feet = Math.floor(inches / 12);
  let sixteenths = Math.round((inches - feet * 12) * 16);
  if (sixteenths >= 192) {
    feet += 1;
    sixteenths = 0;
  }
  const whole = Math.floor(sixteenths / 16);
  const fraction = sixteenths % 16;
  let fractionText = "";
  if (fraction > 0) {
    const divisor = gcd(fraction, 16);
    fractionText = ` ${fraction / divisor}/${16 / divisor}`;
  }
  return `${sign}${feet}'-${whole}${fractionText}"`;
}

export function formatLength(mm: number, units: Units): string {
  if (!Number.isFinite(mm)) return "—";
  if (units === "ft-in") return mmToFeetInches(mm);
  return `${trimNumber(mm)} mm`;
}

export function trimNumber(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(digits));
  return String(rounded);
}

export function formatDimensions(bounds: Bounds | null, units: Units): string {
  if (!bounds) return "—";
  const { x, y, z } = bounds.size;
  if (units === "ft-in") {
    return `${mmToFeetInches(x)} × ${mmToFeetInches(y)} × ${mmToFeetInches(z)}`;
  }
  return `${Math.round(x)} × ${Math.round(y)} × ${Math.round(z)} mm`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${seconds.toString().padStart(2, "0")} s`;
}

export function parameterDisplay(param: ResolvedParameter, units: Units): string {
  if (param.type === "Text") return String(param.value ?? "");
  if (param.type === "YesNo") return param.value ? "Yes" : "No";
  if (typeof param.value !== "number") return String(param.value ?? "");
  if (param.type === "Length") {
    return units === "ft-in" ? mmToFeetInches(param.value) : trimNumber(param.value);
  }
  if (param.type === "Angle") return `${trimNumber(param.value)}°`;
  return trimNumber(param.value);
}

export function parameterUnit(param: ResolvedParameter, units: Units): string {
  if (param.type === "Length") return units === "ft-in" ? "" : "mm";
  if (param.type === "Angle") return "";
  return "";
}
