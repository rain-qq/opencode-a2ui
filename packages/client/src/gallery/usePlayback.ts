/**
 * 回放引擎：把一段 A2UI 信封脚本按时间逐条 applyEnvelope 到全局 store，
 * 像放电影一样把渐进式渲染"放映"出来。支持 播放/暂停/单步/重置/跳转/调速。
 *
 * 复用全局 useA2UI store：渲染走 renderNode，输入控件的双向绑定
 * （writeBack）也因此直接可用 —— 表单校验、slider 等在预览里都能真实交互。
 *
 * 调用方应以 key=demo.id 挂载本 hook 所在组件，使切换示例时状态天然归零；
 * 本 hook 仅在挂载时 reset store 并自动播放。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { A2UIEnvelope } from "@a2ui/protocol";
import { useA2UI } from "../a2ui/store.js";

/** 1x 速度下两条信封之间的间隔（毫秒）。 */
const BASE_INTERVAL = 750;

export interface Playback {
  /** 已应用的信封条数（0..total）。 */
  index: number;
  total: number;
  playing: boolean;
  atEnd: boolean;
  speed: number;
  setSpeed: (n: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  step: () => void;
  restart: () => void;
  /** 跳转到第 k 条：reset 后应用 0..k（含），停在该帧画面。 */
  seek: (k: number) => void;
}

export function usePlayback(envelopes: A2UIEnvelope[]): Playback {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const applyEnvelope = useA2UI((s) => s.applyEnvelope);
  const reset = useA2UI((s) => s.reset);

  const speedRef = useRef(speed);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 挂载即清空 store 并自动播放（组件以 key=demo.id 挂载，切示例即重挂载）。
  useEffect(() => {
    reset();
    setPlaying(true);
    return clearTimer;
  }, [reset, clearTimer]);

  // 播放循环：每拍应用当前 index 指向的那条信封。
  useEffect(() => {
    if (!playing) return;
    if (index >= envelopes.length) {
      setPlaying(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      applyEnvelope(envelopes[index]);
      setIndex((i) => i + 1);
    }, BASE_INTERVAL / speedRef.current);
    return () => clearTimer();
  }, [playing, index, envelopes, applyEnvelope, clearTimer]);

  const pause = useCallback(() => {
    clearTimer();
    setPlaying(false);
  }, [clearTimer]);

  const play = useCallback(() => {
    if (index >= envelopes.length) {
      clearTimer();
      reset();
      setIndex(0);
    }
    setPlaying(true);
  }, [index, envelopes.length, reset, clearTimer]);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, pause, play]);

  const step = useCallback(() => {
    clearTimer();
    setPlaying(false);
    setIndex((i) => {
      if (i < envelopes.length) {
        applyEnvelope(envelopes[i]);
        return i + 1;
      }
      return i;
    });
  }, [envelopes, applyEnvelope, clearTimer]);

  const restart = useCallback(() => {
    clearTimer();
    reset();
    setIndex(0);
    setPlaying(true);
  }, [reset, clearTimer]);

  const seek = useCallback(
    (k: number) => {
      clearTimer();
      setPlaying(false);
      reset();
      // 应用 0..k（含），使第 k 帧画面呈现在画布上。
      const target = Math.max(0, Math.min(k + 1, envelopes.length));
      for (let i = 0; i < target; i++) applyEnvelope(envelopes[i]);
      setIndex(target);
    },
    [envelopes, applyEnvelope, reset, clearTimer]
  );

  return {
    index,
    total: envelopes.length,
    playing,
    atEnd: index >= envelopes.length,
    speed,
    setSpeed,
    play,
    pause,
    toggle,
    step,
    restart,
    seek,
  };
}
