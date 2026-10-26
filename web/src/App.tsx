import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeSpec,
  paramKey,
  validateSpec,
  type FamilyParameter,
  type FamilySpec,
  type Issue,
  type ParameterType,
} from "@family/spec-core";
import { ChatPanel, type ChatEntry } from "./components/ChatPanel";
import { ParameterPanel } from "./components/ParameterPanel";
import { TopBar } from "./components/TopBar";
import { Viewer } from "./components/Viewer";
import { buildFamily, fetchHealth, streamDesign, uploadDocument, type Health, type UploadedDocument } from "./lib/api";
import { formatDuration, type Units } from "./lib/format";
import exampleRaw from "../../spec/examples/fcu-080.json";

const EXAMPLE_SPEC: FamilySpec = validateSpec(exampleRaw).spec;
const EXAMPLE_ANALYSIS = analyzeSpec(EXAMPLE_SPEC);

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface StageState {
  stage: string;
  message: string;
  issues?: Issue[];
}

interface ToastState {
  text: string;
  sub?: string;
  tone: "ok" | "warn" | "error";
}

export function App() {
  const [spec, setSpec] = useState<FamilySpec | null>(EXAMPLE_SPEC);
  const [entries, setEntries] = useState<ChatEntry[]>([
    {
      id: "seed",
      role: "agent",
      text: `Loaded the reference family ${EXAMPLE_SPEC.name}.\nAsk for a change, or describe a different unit and I will model it from scratch.`,
      meta: `${EXAMPLE_ANALYSIS.model.parts.length} parts · ${EXAMPLE_SPEC.parameters.length} parameters · ${EXAMPLE_ANALYSIS.model.instances} solids`,
    },
  ]);
  const [stage, setStage] = useState<StageState | null>(null);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [building, setBuilding] = useState(false);
  const [native, setNative] = useState(false);
  const [units, setUnits] = useState<Units>("mm");
  const [revitVersion, setRevitVersion] = useState("2024");
  const [model, setModel] = useState("");
  const [attachments, setAttachments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showPlanes, setShowPlanes] = useState(true);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [hiddenPartIds, setHiddenPartIds] = useState<string[]>([]);
  const [transparentPartIds, setTransparentPartIds] = useState<string[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const analysis = useMemo(() => (spec ? analyzeSpec(spec) : null), [spec]);

  useEffect(() => {
    let alive = true;
    fetchHealth().then((result) => {
      if (alive) setHealth(result);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = runStartedAt ? Math.max(0, Math.floor((now - runStartedAt) / 1000)) : 0;
  const elapsedLabel = running && runStartedAt ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : null;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(timer);
  }, [toast]);

  const pushEntry = (entry: Omit<ChatEntry, "id">) => {
    setEntries((current) => [...current, { ...entry, id: newId() }]);
  };

  const handleAttach = async (files: File[]) => {
    setUploading(true);
    try {
      const uploaded: UploadedDocument[] = [];
      for (const file of files) {
        const document = await uploadDocument(file);
        uploaded.push(document);
      }
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      pushEntry({
        role: "agent",
        text: `Could not attach file: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, idx) => idx !== index));
  };

  const handleSend = async (text: string) => {
    if (running || uploading) return;
    const hadSpec = Boolean(spec);
    const docs = attachments;
    const names = docs.map((d) => d.name).join(", ");
    pushEntry({ role: "user", text: docs.length > 0 ? `${text}\n(${names})` : text });
    setRunning(true);
    setRunStartedAt(Date.now());
    setNow(Date.now());
    setStage({ stage: "thinking", message: docs.length > 0 ? "Reading attached documents" : "Reading the brief" });

    let failed = false;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamDesign(
        {
          prompt: text,
          spec,
          model: model || undefined,
          attachments: docs.length > 0 ? docs.map((d) => ({ path: d.path, name: d.name })) : undefined,
        },
        (event) => {
          if (event.type === "stage") {
            setStage({ stage: event.stage, message: event.message, issues: event.issues });
            return;
          }

          if (event.type === "error") {
            failed = true;
            setStage(null);
            pushEntry({ role: "agent", text: event.message, tone: "error" });
            return;
          }

          const { stats } = event;
          setSpec(event.spec);
          setNative(false);
          const dims = stats.bounds ? `${stats.bounds.x} × ${stats.bounds.y} × ${stats.bounds.z} mm` : "";

          pushEntry({
            role: "agent",
            text: `${hadSpec ? "Updated" : "Built"} ${event.spec.name}.\n${stats.parts} parts · ${stats.parameters} parameters${dims ? ` · ${dims}` : ""}`,
            notes: event.spec.notes,
            meta: `${formatDuration(stats.elapsedMs)}${stats.attempts > 1 ? ` · ${stats.attempts} passes` : ""}`,
            issues: [...event.errors, ...event.issues.filter((issue) => issue.severity === "warning")].slice(0, 12),
          });
        },
        controller.signal,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        pushEntry({ role: "agent", text: "Stopped." });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        pushEntry({ role: "agent", text: message, tone: "error" });
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setRunStartedAt(null);
      setAttachments([]);
      if (!failed) setStage(null);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleToggleHidePart = (partId: string) => {
    setHiddenPartIds((current) =>
      current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId],
    );
  };

  const handleUnhideAll = () => {
    setHiddenPartIds([]);
  };

  const handleToggleTransparentPart = (partId: string) => {
    setTransparentPartIds((current) =>
      current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId],
    );
  };

  const handleResetTransparent = () => {
    setTransparentPartIds([]);
  };

  const handleUpdateParameter = (name: string, value: number | string) => {
    setSpec((current) => {
      if (!current) return current;
      return {
        ...current,
        parameters: current.parameters.map((param) =>
          param.name === name ? { ...param, value, formula: undefined } : param,
        ),
      };
    });
    setNative(false);
  };

  const handleAddParameter = (draft: { name: string; type: ParameterType; value: number | string }) => {
    setSpec((current) => {
      if (!current) return current;
      const taken = new Set(current.parameters.map((param) => paramKey(param.name)));
      let name = draft.name;
      let suffix = 2;
      while (taken.has(paramKey(name))) {
        name = `${draft.name} ${suffix}`;
        suffix += 1;
      }
      const parameter: FamilyParameter = {
        name,
        type: draft.type,
        group: draft.type === "Length" || draft.type === "Angle" ? "Dimensions" : "Data",
        value: draft.value,
      };
      return { ...current, parameters: [...current.parameters, parameter] };
    });
    setNative(false);
  };

  const handleBuild = async () => {
    if (!spec || !analysis?.ok || building) return;
    setBuilding(true);
    try {
      const result = await buildFamily({ ...spec, revitVersion });
      if (result.ok && result.path) {
        setNative(true);
        setToast({
          text: "Revit family built successfully!",
          sub: result.path,
          tone: "ok",
        });
        // Automatically trigger download of the .rfa file
        const link = document.createElement("a");
        link.href = `/api/download-rfa?path=${encodeURIComponent(result.path)}`;
        link.download = `${spec.name || "Family"}.rfa`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else if (result.mode === "queue") {
        setToast({
          text: "Chưa bật Studio Bridge trong Revit",
          sub: "Vào tab 'Family Agent' trên Revit và bấm nút 'Studio bridge' (hoặc 'Build pending')",
          tone: "warn",
        });
        // Provide direct download of JSON spec
        if (result.file) {
          const link = document.createElement("a");
          link.href = `/api/download-spec?file=${encodeURIComponent(result.file)}`;
          link.download = `${spec.name || "Family"}-spec.json`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      } else {
        setToast({ text: result.error ?? "The build failed", tone: "error" });
      }
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : String(error), tone: "error" });
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="app">
      <TopBar
        name={spec?.name ?? "New family"}
        category={spec?.category ?? "Describe a unit to begin"}
        hasSpec={Boolean(spec)}
        reviewed={Boolean(analysis?.ok)}
        native={native}
        running={running}
        agentStage={stage?.stage ?? null}
        units={units}
        onUnits={setUnits}
        revitVersion={revitVersion}
        onRevitVersion={setRevitVersion}
        onBuild={handleBuild}
        canBuild={Boolean(analysis?.ok)}
        building={building}
      />

      <div className="workspace">
        <ChatPanel
          entries={entries}
          running={running}
          stageMessage={stage ? `${stage.message}${elapsedLabel ? ` · ${elapsedLabel}` : ""}` : null}
          stageIssues={stage?.issues}
          onSend={handleSend}
          onStop={handleStop}
          disabled={running || uploading}
          agentReady={health ? health.agent.ready : null}
          agentLabel={
            health
              ? health.agent.provider === "commandcode"
                ? "cmdc"
                : health.agent.model
              : null
          }
          agentDetail={health?.agent.detail ?? null}
          provider={health?.agent.provider ?? null}
          model={model}
          onModel={setModel}
          availableModels={health?.models}
          attachments={attachments}
          uploading={uploading}
          onAttach={handleAttach}
          onRemoveAttachment={handleRemoveAttachment}
        />

        <Viewer
          model={analysis?.model ?? null}
          parameters={spec?.parameters}
          materials={spec?.materials ?? []}
          units={units}
          showGrid={showGrid}
          onToggleGrid={() => setShowGrid((current) => !current)}
          showPlanes={showPlanes}
          onTogglePlanes={() => setShowPlanes((current) => !current)}
          selectedPartId={selectedPartId}
          onSelectPart={setSelectedPartId}
          hiddenPartIds={hiddenPartIds}
          onToggleHidePart={handleToggleHidePart}
          onUnhideAll={handleUnhideAll}
          transparentPartIds={transparentPartIds}
          onToggleTransparentPart={handleToggleTransparentPart}
          onResetTransparent={handleResetTransparent}
          onUpdateParameter={handleUpdateParameter}
          status={
            running && stage
              ? { stage: stage.stage, message: stage.message, elapsed: elapsedLabel }
              : null
          }
        />

        {spec && analysis ? (
          <ParameterPanel
            spec={spec}
            analysis={analysis}
            units={units}
            selectedPartId={selectedPartId}
            onSelectPart={setSelectedPartId}
            hiddenPartIds={hiddenPartIds}
            onToggleHidePart={handleToggleHidePart}
            transparentPartIds={transparentPartIds}
            onToggleTransparentPart={handleToggleTransparentPart}
            onUpdateParameter={handleUpdateParameter}
            onAddParameter={handleAddParameter}
          />
        ) : (
          <section className="pane right">
            <div className="pane-header">Parameters</div>
            <div style={{ padding: 16, color: "#8c8e91", lineHeight: 1.6 }}>
              Parameters appear here once a family exists.
            </div>
          </section>
        )}
      </div>

      {toast && (
        <div className={`toast ${toast.tone === "error" ? "error" : ""}`}>
          {toast.text}
          {toast.sub && <span className="sub">{toast.sub}</span>}
        </div>
      )}
    </div>
  );
}
