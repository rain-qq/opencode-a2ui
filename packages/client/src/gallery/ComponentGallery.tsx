/**
 * A2UI 组件示例页面。
 *
 * 左侧：示例列表（每个示例是一段 A2UI 信封脚本）。
 * 右侧：DemoStage —— 工具条 + 预览画布 + JSON 放映带。
 *
 * 预览复用 renderNode 动态渲染当前 surface；回放由 usePlayback 驱动，
 * 逐条 applyEnvelope 到全局 store，把渐进式渲染"放映"出来。
 *
 * 切换示例时 DemoStage 以 key=demo.id 重新挂载，回放状态天然归零，
 * 避免"重置 effect 与循环 effect 同一帧竞争"的闭包陷阱。
 */

import React, { useState } from "react";
import type { A2UIEnvelope } from "@a2ui/protocol";
import { useA2UI } from "../a2ui/store.js";
import { renderNode } from "../a2ui/renderer.js";
import { DEMOS, type GalleryDemo } from "./demos.js";
import { usePlayback } from "./usePlayback.js";

const SPEEDS = [0.5, 1, 2, 4];

export function ComponentGallery({ onExit }: { onExit: () => void }) {
  const [demoId, setDemoId] = useState(DEMOS[0].id);
  const demo = React.useMemo(
    () => DEMOS.find((d) => d.id === demoId) ?? DEMOS[0],
    [demoId]
  );

  return (
    <div className="gallery">
      <header className="gallery-header">
        <div className="gallery-title">
          A2UI 组件示例 <small>· 动态 JSON 放映</small>
        </div>
        <button className="g-btn borderless" onClick={onExit}>
          ← 返回对话
        </button>
      </header>

      <div className="gallery-body">
        <aside className="gallery-sidebar">
          <div className="gallery-side-title">示例列表</div>
          {DEMOS.map((d) => (
            <button
              key={d.id}
              className={`demo-item ${d.id === demoId ? "active" : ""}`}
              onClick={() => setDemoId(d.id)}
            >
              <div className="demo-name">{d.name}</div>
              <div className="demo-desc">{d.description}</div>
              <div className="demo-cat">{d.category}</div>
            </button>
          ))}
        </aside>

        <main className="gallery-main">
          <DemoStage key={demo.id} demo={demo} />
        </main>
      </div>
    </div>
  );
}

function DemoStage({ demo }: { demo: GalleryDemo }) {
  const pb = usePlayback(demo.envelopes);

  return (
    <>
      <div className="gallery-toolbar">
        <span className="gallery-progress">
          {Math.min(pb.index, pb.total)} / {pb.total}
        </span>
        {pb.playing ? (
          <button className="g-btn" onClick={pb.pause} title="暂停">
            ⏸
          </button>
        ) : (
          <button
            className="g-btn primary"
            onClick={pb.play}
            title="播放"
            disabled={pb.atEnd && pb.total === 0}
          >
            ▶
          </button>
        )}
        <button
          className="g-btn"
          onClick={pb.step}
          disabled={pb.playing || pb.atEnd}
          title="单步"
        >
          ⏭
        </button>
        <button className="g-btn" onClick={pb.restart} title="重置并播放">
          ⟲
        </button>
        <div className="g-speed">
          <span>速度</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`g-btn sm ${pb.speed === s ? "active" : ""}`}
              onClick={() => pb.setSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
        <span className="gallery-demo-name">{demo.name}</span>
      </div>

      <section className="gallery-stage">
        <SurfacePreview surfaceId={demo.surfaceId} />
      </section>

      <section className="gallery-filmstrip">
        <div className="filmstrip-head">
          <span className="filmstrip-title">JSON 放映带</span>
          <span className="filmstrip-hint">点击任意条可跳转到该帧</span>
        </div>
        <div className="filmstrip-list">
          {demo.envelopes.map((env, i) => {
            const state = filmState(i, pb.index, pb.playing);
            return (
              <button
                key={i}
                className={`film-item ${state}`}
                onClick={() => pb.seek(i)}
                title={envTag(env)}
              >
                <span className="film-idx">{String(i + 1).padStart(2, "0")}</span>
                <span className="film-tag">{envTag(env)}</span>
                <span className="film-json">{compactJson(env)}</span>
              </button>
            );
          })}
        </div>
        <pre className="film-detail">
          {pb.index > 0
            ? formatJson(demo.envelopes[pb.index - 1])
            : "// 按 ▶ 播放，第一帧信封将在此渲染\n// 预览画布会随每条信封渐进式变化"}
        </pre>
      </section>
    </>
  );
}

/* -------------------- 预览画布 -------------------- */

function SurfacePreview({ surfaceId }: { surfaceId: string }) {
  const surface = useA2UI((s) => s.surfaces[surfaceId]);

  if (!surface) {
    return (
      <div className="gallery-empty">
        <div className="gallery-empty-title">尚未创建 surface</div>
        <div className="gallery-empty-hint">
          按 ▶ 播放，第一条 <code>createSurface</code> 信封到达后画布会出现。
        </div>
      </div>
    );
  }

  const theme = surface.theme?.primaryColor
    ? ({
        ["--a2ui-primary" as never]: surface.theme.primaryColor,
      } as React.CSSProperties)
    : undefined;

  return (
    <section className="surface-card gallery-surface" style={theme}>
      <div className="surface-header">
        <span>
          {surface.theme?.agentDisplayName ?? "surface"} · {surface.surfaceId}
        </span>
        <span>{Object.keys(surface.components).length} components</span>
      </div>
      {renderNode("root", { surface, trail: new Set<string>() })}
    </section>
  );
}

/* -------------------- 工具函数 -------------------- */

function envTag(env: A2UIEnvelope): string {
  if (env.createSurface) return "createSurface";
  if (env.updateComponents) return "updateComponents";
  if (env.updateDataModel) return "updateDataModel";
  if (env.deleteSurface) return "deleteSurface";
  return "envelope";
}

/** 单行精简 JSON，用于放映带列表展示。 */
function compactJson(env: A2UIEnvelope): string {
  const tag = envTag(env);
  const body = (env as unknown as Record<string, unknown>)[tag];
  return JSON.stringify(body);
}

function formatJson(env: A2UIEnvelope): string {
  return JSON.stringify(env, null, 2);
}

function filmState(i: number, index: number, playing: boolean): string {
  if (i < index) return "done";
  if (i === index) return playing ? "current" : "next";
  return "pending";
}
