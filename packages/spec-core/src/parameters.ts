import { ExpressionError, compileExpression, evaluateNode } from "./expr.js";
import type { FamilyParameter, Issue, ParameterType } from "./types.js";

export type ParamValue = number | string | boolean;

export interface ResolvedParameter {
  name: string;
  key: string;
  type: ParameterType;
  value: ParamValue;
  formula?: string;
  source: "value" | "formula" | "override" | "default";
  instance: boolean;
  group: string;
  description?: string;
  error?: string;
}

export interface ParameterResolution {
  parameters: ResolvedParameter[];
  byKey: Map<string, ResolvedParameter>;
  issues: Issue[];
  lookup: (name: string) => number;
}

export function paramKey(name: string): string {
  return name.trim().toLowerCase();
}

const NUMERIC_TYPES = new Set<ParameterType>(["Length", "Angle", "Number", "Integer"]);

export function isNumericParameter(param: { type: ParameterType }): boolean {
  return NUMERIC_TYPES.has(param.type);
}

function normalizeNumeric(type: ParameterType, value: number): number {
  return type === "Integer" ? Math.round(value) : value;
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "yes" || text === "1";
}

function defaultGroup(type: ParameterType): string {
  return type === "Length" || type === "Angle" ? "Dimensions" : "Data";
}

export function resolveParameters(
  params: FamilyParameter[],
  overrides: Record<string, number | string> = {},
): ParameterResolution {
  const issues: Issue[] = [];
  const byKey = new Map<string, FamilyParameter>();
  const resolved = new Map<string, ResolvedParameter>();
  const resolving = new Set<string>();

  for (const param of params) {
    const key = paramKey(param.name);
    if (byKey.has(key)) {
      issues.push({
        severity: "warning",
        path: `parameters.${param.name}`,
        message: `Duplicate parameter name "${param.name}" ignored`,
      });
      continue;
    }
    byKey.set(key, param);
  }

  const lookup = (name: string): number => {
    const key = paramKey(name);
    const target = byKey.get(key);
    if (!target) throw new ExpressionError(`Unknown parameter "${name}"`);
    if (!isNumericParameter(target)) {
      throw new ExpressionError(`Parameter "${target.name}" is not a number (type ${target.type})`);
    }
    const value = resolve(target).value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ExpressionError(`Parameter "${target.name}" has no numeric value`);
    }
    return value;
  };

  function resolve(param: FamilyParameter): ResolvedParameter {
    const key = paramKey(param.name);

    const done = resolved.get(key);
    if (done) return done;

    if (resolving.has(key)) {
      throw new ExpressionError(`Circular reference in formulas involving "${param.name}"`);
    }

    resolving.add(key);
    try {
      const result = resolveOne(param, key);
      resolved.set(key, result);
      return result;
    } finally {
      resolving.delete(key);
    }
  }

  function resolveOne(param: FamilyParameter, key: string): ResolvedParameter {
    const base: ResolvedParameter = {
      name: param.name,
      key,
      type: param.type,
      value: 0,
      formula: param.formula?.trim() || undefined,
      source: "value",
      instance: Boolean(param.instance),
      group: param.group || defaultGroup(param.type),
      description: param.description,
    };

    const override = overrides[key];

    if (param.type === "Text") {
      if (override !== undefined) {
        return { ...base, value: String(override), source: "override" };
      }
      return { ...base, value: param.value === undefined || param.value === null ? "" : String(param.value) };
    }

    if (param.type === "YesNo") {
      if (override !== undefined) {
        return { ...base, value: coerceBoolean(override), source: "override" };
      }
      return { ...base, value: coerceBoolean(param.value) };
    }

    if (override !== undefined && override !== "") {
      const numeric = Number(override);
      if (!Number.isFinite(numeric)) {
        return {
          ...base,
          value: Number.NaN,
          source: "override",
          error: `"${override}" is not a number`,
        };
      }
      return { ...base, value: normalizeNumeric(param.type, numeric), source: "override" };
    }

    if (base.formula) {
      try {
        const node = compileExpression(base.formula);
        const numeric = evaluateNode(node, lookup);
        return { ...base, value: normalizeNumeric(param.type, numeric), source: "formula" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...base, value: 0, source: "formula", error: message };
      }
    }

    const raw = param.value;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return { ...base, value: normalizeNumeric(param.type, raw) };
    }
    if (typeof raw === "string" && raw.trim()) {
      try {
        const numeric = evaluateNode(compileExpression(raw), lookup);
        return { ...base, value: normalizeNumeric(param.type, numeric), source: "formula" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...base, value: 0, error: message };
      }
    }
    return { ...base, value: 0, source: "default" };
  }

  for (const param of byKey.values()) {
    try {
      const result = resolve(param);
      if (result.error) {
        issues.push({
          severity: "error",
          path: `parameters.${param.name}`,
          message: result.error,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({ severity: "error", path: `parameters.${param.name}`, message });
      resolved.set(paramKey(param.name), {
        name: param.name,
        key: paramKey(param.name),
        type: param.type,
        value: param.type === "Text" || param.type === "YesNo" ? "" : 0,
        formula: param.formula || undefined,
        source: "default",
        instance: Boolean(param.instance),
        group: param.group || defaultGroup(param.type),
        description: param.description,
        error: message,
      });
    }
  }

  const parameters = [...resolved.values()];

  return {
    parameters,
    byKey: resolved,
    issues,
    lookup: (name: string) => lookup(name),
  };
}
