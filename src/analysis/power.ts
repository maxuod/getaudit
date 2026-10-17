import { createHash } from "node:crypto";
import { fisherRandomizationInference, type PromptDelta } from "./did.ts";

export interface PowerSimulationInput {
  effect: number;
  promptDeltaSd: number;
  alpha?: number;
  targetPower?: number;
  minPromptsPerArm?: number;
  maxPromptsPerArm?: number;
  step?: number;
  simulations?: number;
  randomizationIterations?: number;
  seed: string;
}
export interface PowerPoint {
  promptsPerArm: number;
  estimatedPower: number;
  detections: number;
  simulations: number;
}

export interface PowerSimulationResult {
  input: Required<PowerSimulationInput>;
  points: PowerPoint[];
  recommendedPromptsPerArm: number | null;
}

function makeRng(seed: string): () => number {
  const digest = createHash("sha256").update(seed).digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  return () => {
    const t = a ^ (a << 11);
    a = b;
    b = c;
    c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return d / 0x100000000;
  };
}

function normal(rng: () => number): number {
  const u1 = Math.max(Number.EPSILON, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function simulatePromptLevelPower(input: PowerSimulationInput): PowerSimulationResult {
  if (!(input.effect > 0)) throw new Error("effect 必须大于 0");
  if (!(input.promptDeltaSd > 0)) throw new Error("promptDeltaSd 必须大于 0");
  const resolved: Required<PowerSimulationInput> = {
    effect: input.effect,
    promptDeltaSd: input.promptDeltaSd,
    alpha: input.alpha ?? 0.05,
    targetPower: input.targetPower ?? 0.8,
    minPromptsPerArm: Math.max(8, input.minPromptsPerArm ?? 8),
    maxPromptsPerArm: Math.max(input.minPromptsPerArm ?? 8, input.maxPromptsPerArm ?? 50),
    step: Math.max(1, input.step ?? 2),
    simulations: Math.max(100, input.simulations ?? 500),
    randomizationIterations: Math.max(500, input.randomizationIterations ?? 1000),
    seed: input.seed,
  };
  const rng = makeRng(resolved.seed);
  const points: PowerPoint[] = [];

  for (
    let promptsPerArm = resolved.minPromptsPerArm;
    promptsPerArm <= resolved.maxPromptsPerArm;
    promptsPerArm += resolved.step
  ) {
    let detections = 0;
    for (let simulation = 0; simulation < resolved.simulations; simulation += 1) {
      const rows: PromptDelta[] = [];
      for (const arm of ["treatment", "control"] as const) {
        for (let index = 0; index < promptsPerArm; index += 1) {
          const delta = normal(rng) * resolved.promptDeltaSd + (arm === "treatment" ? resolved.effect : 0);
          rows.push({
            promptId: `${arm}-${index}`,
            text: `${arm}-${index}`,
            arm,
            stratum: ["low", "mid", "high"][index % 3]!,
            preRate: 0,
            postRate: delta,
            delta,
            preUsable: 10,
            postUsable: 10,
          });
        }
      }
      const inference = fisherRandomizationInference(rows, {
        seed: `${resolved.seed}|n=${promptsPerArm}|simulation=${simulation}`,
        iterations: resolved.randomizationIterations,
        exactLimit: 1,
      });
      if (inference.pValue !== null && inference.pValue < resolved.alpha) detections += 1;
    }
    points.push({
      promptsPerArm,
      estimatedPower: detections / resolved.simulations,
      detections,
      simulations: resolved.simulations,
    });
  }

  return {
    input: resolved,
    points,
    recommendedPromptsPerArm:
      points.find((point) => point.estimatedPower >= resolved.targetPower)?.promptsPerArm ?? null,
  };
}

export function renderPowerSimulation(result: PowerSimulationResult): string {
  const lines = [
    "Prompt-level Monte Carlo 功效模拟",
    "=".repeat(68),
    `假设效应 ${(result.input.effect * 100).toFixed(1)}pp；prompt delta SD ${(result.input.promptDeltaSd * 100).toFixed(1)}pp`,
    `alpha ${result.input.alpha}；目标功效 ${(result.input.targetPower * 100).toFixed(0)}%；seed ${result.input.seed}`,
    "",
    "每组 prompt    估计功效",
    "-".repeat(28),
    ...result.points.map(
      (point) => `${String(point.promptsPerArm).padStart(10)}    ${(point.estimatedPower * 100).toFixed(1).padStart(7)}%`,
    ),
    "",
    result.recommendedPromptsPerArm === null
      ? "在测试范围内未达到目标功效；扩大 max 或重新评估可接受效应/噪音假设。"
      : `建议至少每组 ${result.recommendedPromptsPerArm} 条 prompt（基于上述假设，不是保证）。`,
  ];
  return lines.join("\n");
}
