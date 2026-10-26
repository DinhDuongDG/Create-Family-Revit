import * as THREE from "three";
import { Brush, Evaluator, SUBTRACTION } from "three-bvh-csg";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ResolvedPart, ResolvedSolid } from "@family/spec-core";

const evaluator = new Evaluator();
evaluator.useGroups = false;
evaluator.attributes = ["position", "normal"];

const UP = new THREE.Vector3(0, 1, 0);

function prepare(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  let result = geometry;
  if (!result.index) result = mergeVertices(result, 1e-4);
  if (!result.getAttribute("normal")) result.computeVertexNormals();
  result.deleteAttribute("uv");
  result.deleteAttribute("uv1");
  return result;
}

function axisDirection(axis: "x" | "y" | "z", sign: number): THREE.Vector3 {
  const direction = new THREE.Vector3();
  direction[axis] = sign >= 0 ? 1 : -1;
  return direction;
}

export function solidGeometry(solid: ResolvedSolid): THREE.BufferGeometry {
  if (solid.kind === "box") {
    const { origin, size } = solid;
    const geometry = new THREE.BoxGeometry(
      Math.abs(size.x) || 0.01,
      Math.abs(size.y) || 0.01,
      Math.abs(size.z) || 0.01,
    );
    geometry.translate(0, 0, size.z / 2);
    if (solid.rotationZ) geometry.rotateZ((solid.rotationZ * Math.PI) / 180);
    geometry.translate(origin.x, origin.y, origin.z);
    return geometry;
  }

  if (solid.kind === "cylinder") {
    const height = Math.abs(solid.height);
    let geometry: THREE.BufferGeometry;

    if (solid.innerRadius > 0) {
      const profile = [
        new THREE.Vector2(solid.innerRadius, 0),
        new THREE.Vector2(solid.radius, 0),
        new THREE.Vector2(solid.radius, height),
        new THREE.Vector2(solid.innerRadius, height),
        new THREE.Vector2(solid.innerRadius, 0),
      ];
      geometry = new THREE.LatheGeometry(profile, solid.segments);
    } else {
      geometry = new THREE.CylinderGeometry(solid.radius, solid.radius, height, solid.segments, 1, false);
      geometry.translate(0, height / 2, 0);
    }

    const direction = axisDirection(solid.axis, solid.height);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, direction);
    geometry.applyQuaternion(quaternion);
    geometry.translate(solid.base.x, solid.base.y, solid.base.z);
    return geometry;
  }

  const shape = new THREE.Shape(solid.points.map(([a, b]) => new THREE.Vector2(a, b)));
  const depth = Math.max(Math.abs(solid.to - solid.from), 0.01);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });

  const low = Math.min(solid.from, solid.to);
  const high = Math.max(solid.from, solid.to);

  if (solid.plane === "xy") {
    geometry.translate(0, 0, low);
  } else if (solid.plane === "xz") {
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, high, 0);
  } else {
    const basis = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    geometry.applyMatrix4(basis);
    geometry.translate(low, 0, 0);
  }

  return geometry;
}

export interface PartGeometry {
  geometry: THREE.BufferGeometry;
  hasCuts: boolean;
  cutFailed: boolean;
}

export function buildPartGeometry(part: ResolvedPart): PartGeometry {
  let geometry = prepare(solidGeometry(part.solid));
  let cutFailed = false;

  for (const cut of part.cuts) {
    try {
      const cutter = prepare(solidGeometry(cut));
      const left = new Brush(geometry);
      const right = new Brush(cutter);
      left.updateMatrixWorld();
      right.updateMatrixWorld();
      const result = evaluator.evaluate(left, right, SUBTRACTION);
      result.geometry.deleteAttribute("uv");
      geometry = result.geometry;
    } catch {
      cutFailed = true;
    }
  }

  return { geometry, hasCuts: part.cuts.length > 0, cutFailed };
}

export function partColor(part: ResolvedPart, materials: { name: string; color?: string }[]): string {
  if (part.color) return part.color;
  const material = materials.find((entry) => entry.name === part.material);
  return material?.color ?? "#a9aeb2";
}

export function partMaterialProps(
  part: ResolvedPart,
  materials: { name: string; color?: string; metalness?: number; roughness?: number }[],
): { metalness: number; roughness: number } {
  const material = materials.find((entry) => entry.name === part.material);
  return {
    metalness: material?.metalness ?? 0.2,
    roughness: material?.roughness ?? 0.6,
  };
}
