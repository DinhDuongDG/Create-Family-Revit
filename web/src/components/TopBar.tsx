import type { Units } from "../lib/format";

interface Props {
  name: string;
  category: string;
  hasSpec: boolean;
  reviewed: boolean;
  native: boolean;
  running?: boolean;
  agentStage?: string | null;
  units: Units;
  onUnits: (units: Units) => void;
  revitVersion: string;
  onRevitVersion: (version: string) => void;
  onBuild: () => void;
  canBuild: boolean;
  building: boolean;
}

const AGENT_STEPS = ["Read brief", "Design family", "Check model"];

function getAgentStepIndex(stage: string | null | undefined): number {
  if (!stage) return 0;
  if (stage === "thinking" || stage === "reading") return 0;
  if (stage === "checking") return 2;
  if (stage === "generating" || stage === "working" || stage === "repairing") return 1;
  return 0;
}

function Check() {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M1.5 5.2 4 7.5 8.5 2.5" />
    </svg>
  );
}

export function TopBar({
  name,
  category,
  hasSpec,
  reviewed,
  native,
  running,
  agentStage,
  units,
  onUnits,
  revitVersion,
  onRevitVersion,
  onBuild,
  canBuild,
  building,
}: Props) {
  const currentStep = getAgentStepIndex(agentStage);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">FA</div>
        <div style={{ minWidth: 0 }}>
          <div className="project-name">{hasSpec ? name : "New family"}</div>
          <div className="project-sub">{category}</div>
        </div>
      </div>

      <div className="stages">
        {running ? (
          AGENT_STEPS.map((label, index) => {
            const isDone = index < currentStep;
            const isActive = index === currentStep;
            return (
              <span
                key={label}
                className={`stage ${isDone ? "done" : ""} ${isActive ? "active" : ""}`}
              >
                <span className="dot">{isDone ? <Check /> : null}</span>
                {label}
              </span>
            );
          })
        ) : (
          <>
            <span className={`stage ${hasSpec ? "done" : ""} ${hasSpec && !reviewed ? "active" : ""}`}>
              <span className="dot">{hasSpec ? <Check /> : null}</span>
              Draft
            </span>
            <span className={`stage ${reviewed ? "done" : ""} ${hasSpec && !reviewed ? "" : reviewed && !native ? "active" : ""}`}>
              <span className="dot">{reviewed ? <Check /> : null}</span>
              Reviewed
            </span>
            <span className={`stage ${native ? "done" : ""} ${reviewed && !native ? "active" : ""}`}>
              <span className="dot">{native ? <Check /> : null}</span>
              Native family
            </span>
          </>
        )}
      </div>

      <div className="top-actions">
        <div className="segmented" role="group" aria-label="Units">
          <button type="button" className={units === "mm" ? "active" : ""} onClick={() => onUnits("mm")}>
            mm
          </button>
          <button
            type="button"
            className={units === "ft-in" ? "active" : ""}
            onClick={() => onUnits("ft-in")}
          >
            ft-in
          </button>
        </div>

        <select
          className="select"
          value={revitVersion}
          onChange={(event) => onRevitVersion(event.target.value)}
          aria-label="Revit version"
        >
          <option value="2024">Revit 2024</option>
          <option value="2025">Revit 2025</option>
          <option value="2026">Revit 2026</option>
        </select>

        <button type="button" className="btn-primary" onClick={onBuild} disabled={!canBuild || building}>
          {building ? (
            <>
              <span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} />
              Building
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2 13h12" />
              </svg>
              Build Revit family
            </>
          )}
        </button>
      </div>
    </header>
  );
}
