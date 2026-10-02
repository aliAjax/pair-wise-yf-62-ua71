'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AreaStatus,
  AssetStatus,
  CoverageReport,
  CoverageSource,
  EventLog,
  MergeConflict,
  Mission,
  MissionStatus,
  ObservationRecord,
  RescueAsset,
  SearchArea
} from './types';

/** 位置过期阈值：观测时间早于该值即判过期，不按恢复时刻刷新 */
export const STALE_MS = 10 * 60_000;
/** 覆盖率矛盾容差：相差超过该百分点视为冲突 */
const COVERAGE_TOLERANCE = 5;

const now = Date.now();
const initialAreas: SearchArea[] = [
  { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverage: 68 },
  { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverage: 32 }
];
const initialAssets: RescueAsset[] = [
  { id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned', lat: 30.75, lng: 121.55, lastSeen: new Date(now - 35_000).toISOString() },
  { id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready', lat: 30.82, lng: 121.73, lastSeen: new Date(now - 7 * 60_000).toISOString() },
  { id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline', lat: 30.69, lng: 121.61, lastSeen: new Date(now - 18 * 60_000).toISOString() },
  { id: 'shore-04', name: '岸观哨·东咀', type: 'shore', status: 'ready', lat: 30.61, lng: 121.48, lastSeen: new Date(now - 2 * 60_000).toISOString() }
];
const initialMissions: Mission[] = [
  { id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'], status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物', updatedAt: new Date(now - 6 * 60_000).toISOString() }
];
const initialEvents: EventLog[] = [
  { id: 'event-1', time: new Date(now - 15 * 60_000).toISOString(), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: 'event-2', time: new Date(now - 6 * 60_000).toISOString(), actor: '无人机D-9', message: '链路中断，最后位置已标记为过期' }
];

const uuid = () => crypto.randomUUID();
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const fmt = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  offline: boolean;
  lowBandwidth: boolean;
  observations: ObservationRecord[];
  coverageReports: CoverageReport[];
  coverageSources: CoverageSource[];
  conflicts: MergeConflict[];
  lastMergedAt: string | null;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  setMissionStatus: (id: string, status: MissionStatus) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string }) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
  accumulateOfflineRecords: () => void;
  mergeOfflineRecords: () => void;
  resolveConflict: (conflictId: string, decidedKey: string) => void;
}

/**
 * 合并离线积累的位置观测与覆盖回报。
 * 关键原则：
 * 1. 位置按观测时间判过期，过期则重算（不拿恢复时刻当新位置）；
 * 2. 任务记录说了算：新任务调派他区时，旧搜索区覆盖不采用；覆盖只落到执行过的区；
 * 3. 覆盖率矛盾 / 单位同时被分到两个区 → 列冲突由指挥员定夺，未定夺保留原覆盖值。
 */
function computeMerge(state: CommandState): Partial<CommandState> {
  const events: EventLog[] = [];
  let assets = state.assets.slice();
  let areas = state.areas.slice();
  let observations = state.observations.slice();
  let coverageReports = state.coverageReports.slice();
  let coverageSources = state.coverageSources.slice();
  let conflicts = state.conflicts.slice();

  const pendingObs = observations.filter((o) => !o.merged);
  const pendingReports = coverageReports.filter((r) => !r.merged);

  // ---- 1. 位置合并：按观测时间判过期，过期重算 ----
  const obsByAsset = new Map<string, ObservationRecord[]>();
  for (const obs of pendingObs) {
    const list = obsByAsset.get(obs.assetId) ?? [];
    list.push(obs);
    obsByAsset.set(obs.assetId, list);
  }
  for (const [assetId, list] of obsByAsset) {
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) continue;
    const latest = list.sort((a, b) => +new Date(b.observedAt) - +new Date(a.observedAt))[0];
    const age = Date.now() - +new Date(latest.observedAt);
    if (age > STALE_MS) {
      // 观测时间已过期：不刷新位置、不把恢复时刻当新位置，lastSeen 落回观测时间
      assets = assets.map((a) => a.id === assetId ? { ...a, lastSeen: latest.observedAt } : a);
      events.push({ id: uuid(), time: new Date().toISOString(), actor: '合并归队', message: `${asset.name} 带回的观测时间 ${fmt(latest.observedAt)} 已过期，位置重算为过期，未按恢复时刻刷新` });
    } else {
      assets = assets.map((a) => a.id === assetId ? { ...a, lat: latest.lat, lng: latest.lng, lastSeen: latest.observedAt } : a);
      events.push({ id: uuid(), time: new Date().toISOString(), actor: '合并归队', message: `${asset.name} 按观测时间 ${fmt(latest.observedAt)} 归位，已更新位置` });
    }
  }
  observations = observations.map((o) => pendingObs.includes(o) ? { ...o, merged: true } : o);

  // ---- 2. 覆盖合并：任务记录说了算，覆盖只落到执行过的区 ----
  const reportsByArea = new Map<string, CoverageReport[]>();
  for (const report of pendingReports) {
    const list = reportsByArea.get(report.areaId) ?? [];
    list.push(report);
    reportsByArea.set(report.areaId, list);
  }

  for (const [areaId, reports] of reportsByArea) {
    const area = areas.find((a) => a.id === areaId);
    const accepted: CoverageReport[] = [];

    for (const report of reports) {
      const assetMissions = state.missions
        .filter((m) => m.assetIds.includes(report.assetId))
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
      const executedAreaIds = state.missions
        .filter((m) => m.assetIds.includes(report.assetId) && m.status !== 'draft')
        .map((m) => m.areaId);
      const latestMission = assetMissions[0];
      // 任务记录说了算：观测后单位已被调新任务到他区 → 旧搜索区不覆盖任务安排
      const superseded = !!latestMission
        && +new Date(latestMission.updatedAt) > +new Date(report.observedAt)
        && latestMission.areaId !== areaId;
      if (superseded) {
        coverageReports = coverageReports.map((r) => r.id === report.id ? { ...r, merged: true, status: 'rejected', reason: `新任务已调派至 ${latestMission.areaId}，旧搜索区覆盖不采用` } : r);
        coverageSources.push({ id: uuid(), areaId, assetId: report.assetId, assetName: report.assetName, coverage: report.coverage, observedAt: report.observedAt, mergedAt: new Date().toISOString(), decision: 'superseded' });
        events.push({ id: uuid(), time: new Date().toISOString(), actor: '合并归队', message: `${report.assetName} 对 ${area?.name ?? areaId} 的覆盖被新任务安排替代，未落地` });
        continue;
      }
      // 新增覆盖要落到执行过的区：任务记录里没去过的区，覆盖不落地
      if (!executedAreaIds.includes(areaId)) {
        coverageReports = coverageReports.map((r) => r.id === report.id ? { ...r, merged: true, status: 'rejected', reason: '任务记录中未执行过该搜索区，覆盖不落地' } : r);
        events.push({ id: uuid(), time: new Date().toISOString(), actor: '合并归队', message: `${report.assetName} 未执行过 ${area?.name ?? areaId}，其覆盖回报不落地` });
        continue;
      }
      accepted.push(report);
    }

    if (accepted.length === 0) continue;

    // 矛盾检测：多单位覆盖率不一致，或与已落地来源不一致 → 列冲突，未定夺保留原覆盖值
    const distinctValues = Array.from(new Set(accepted.map((r) => r.coverage)));
    const existingApplied = coverageSources.find((s) => s.areaId === areaId && s.decision === 'applied');
    const withExisting = existingApplied ? distinctValues.concat(existingApplied.coverage) : distinctValues;
    const hasConflict = withExisting.some((v) => Math.abs(v - withExisting[0]) > COVERAGE_TOLERANCE);

    if (hasConflict) {
      const candidates = accepted.map((r) => ({ key: r.id, label: `${r.assetName} 报告`, value: r.coverage, meta: `观测于 ${fmt(r.observedAt)}` }));
      if (existingApplied) {
        candidates.unshift({ key: existingApplied.id, label: `已存 · ${existingApplied.assetName}`, value: existingApplied.coverage, meta: `观测于 ${fmt(existingApplied.observedAt)}` });
      }
      conflicts.push({
        id: uuid(),
        kind: 'coverage',
        areaId,
        title: `${area?.name ?? areaId} 覆盖率矛盾`,
        candidates,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      // 未定夺前保留原覆盖值，相关报告挂起
      coverageReports = coverageReports.map((r) => accepted.some((a) => a.id === r.id) ? { ...r, merged: true, status: 'pending' } : r);
      events.push({ id: uuid(), time: new Date().toISOString(), actor: '合并归队', message: `${area?.name ?? areaId} 覆盖率存在矛盾，已列冲突待指挥员定夺，原定覆盖值保留` });
    } else {
      const chosen = accepted[0];
      areas = areas.map((a) => a.id === areaId ? { ...a, coverage: chosen.coverage } : a);
      for (const r of accepted) {
        coverageReports = coverageReports.map((rep) => rep.id === r.id ? { ...rep, merged: true, status: 'applied' } : rep);
        coverageSources.push({ id: uuid(), areaId, assetId: r.assetId, assetName: r.assetName, coverage: r.coverage, observedAt: r.observedAt, mergedAt: new Date().toISOString(), decision: 'applied' });
      }
      events.push({ id: uuid(), time: new Date().toISOString(), actor: '合并归队', message: `${area?.name ?? areaId} 覆盖合并为 ${chosen.coverage}%（来源 ${chosen.assetName}，观测于 ${fmt(chosen.observedAt)}）` });
    }
  }

  // ---- 3. 任务分配冲突：一个单位同时被分到两个区 ----
  const activeMissions = state.missions.filter((m) => m.status === 'dispatched' || m.status === 'in_progress');
  const missionsByAsset = new Map<string, Mission[]>();
  for (const mission of activeMissions) {
    for (const assetId of mission.assetIds) {
      const list = missionsByAsset.get(assetId) ?? [];
      list.push(mission);
      missionsByAsset.set(assetId, list);
    }
  }
  for (const [assetId, missions] of missionsByAsset) {
    const areaIds = Array.from(new Set(missions.map((m) => m.areaId)));
    if (areaIds.length > 1) {
      const asset = assets.find((a) => a.id === assetId);
      conflicts.push({
        id: uuid(),
        kind: 'assignment',
        assetId,
        title: `${asset?.name ?? assetId} 同时被分到两个区`,
        candidates: missions.map((m) => ({ key: m.id, label: m.title, value: m.areaId, meta: m.status })),
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      events.push({ id: uuid(), time: new Date().toISOString(), actor: '合并归队', message: `${asset?.name ?? assetId} 同时被分到两个区，已列冲突待指挥员定夺` });
    }
  }

  return {
    assets,
    areas,
    observations,
    coverageReports,
    coverageSources,
    conflicts,
    lastMergedAt: new Date().toISOString(),
    events: events.concat(state.events).slice(0, 50)
  };
}

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => ({
      areas: initialAreas,
      assets: initialAssets,
      missions: initialMissions,
      events: initialEvents,
      offline: false,
      lowBandwidth: false,
      observations: [],
      coverageReports: [],
      coverageSources: [],
      conflicts: [],
      lastMergedAt: null,
      setAreaStatus: (id, status) => set((state) => ({
        areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
        events: [{ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `搜索区 ${id} 状态改为 ${status}` }, ...state.events]
      })),
      setAssetStatus: (id, status) => set((state) => ({
        assets: state.assets.map((asset) => asset.id === id ? { ...asset, status, lastSeen: new Date().toISOString() } : asset),
        events: [{ id: uuid(), time: new Date().toISOString(), actor: '值班员', message: `${id} 状态改为 ${status}，已生成恢复记录` }, ...state.events]
      })),
      setMissionStatus: (id, status) => set((state) => ({
        missions: state.missions.map((mission) => mission.id === id ? { ...mission, status, updatedAt: new Date().toISOString() } : mission),
        events: [{ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `任务 ${id} 状态改为 ${status}` }, ...state.events]
      })),
      dispatchMission: (input) => set((state) => {
        const mission: Mission = { id: uuid(), ...input, status: 'dispatched', updatedAt: new Date().toISOString() };
        return {
          missions: [mission, ...state.missions],
          assets: state.assets.map((asset) => input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset),
          events: [{ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `任务“${input.title}”已派发` }, ...state.events]
        };
      }),
      toggleOffline: () => set((state) => {
        const goingOnline = state.offline;
        if (goingOnline) {
          // 网络恢复：合并归队，再接进指挥台
          return { offline: false, ...computeMerge(state) };
        }
        return { offline: true };
      }),
      toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),
      accumulateOfflineRecords: () => set((state) => {
        const offlineAssets = state.assets.filter((a) => a.status === 'offline');
        if (offlineAssets.length === 0) return state;
        const observations: ObservationRecord[] = [];
        const coverageReports: CoverageReport[] = [];
        for (const asset of offlineAssets) {
          const observedAt = new Date().toISOString();
          observations.push({
            id: uuid(),
            assetId: asset.id,
            assetName: asset.name,
            observedAt,
            lat: clamp(asset.lat + (Math.random() - 0.5) * 0.02, 30.5, 31.1),
            lng: clamp(asset.lng + (Math.random() - 0.5) * 0.02, 121.3, 122.0),
            merged: false
          });
          // 只对任务记录中执行过的区积累覆盖
          const missionAreaIds = state.missions
            .filter((m) => m.assetIds.includes(asset.id) && m.status !== 'draft')
            .map((m) => m.areaId);
          for (const areaId of missionAreaIds) {
            const area = state.areas.find((a) => a.id === areaId);
            const base = area?.coverage ?? 50;
            coverageReports.push({
              id: uuid(),
              assetId: asset.id,
              assetName: asset.name,
              areaId,
              observedAt,
              coverage: Math.round(clamp(base + (Math.random() * 8 - 3), 0, 100)),
              merged: false,
              status: 'pending'
            });
          }
        }
        return {
          observations: state.observations.concat(observations),
          coverageReports: state.coverageReports.concat(coverageReports),
          events: [{ id: uuid(), time: new Date().toISOString(), actor: '离线缓存', message: `${offlineAssets.length} 个失联单位积累了位置观测与覆盖记录，待网络恢复后合并` }, ...state.events]
        };
      }),
      mergeOfflineRecords: () => set((state) => computeMerge(state)),
      resolveConflict: (conflictId, decidedKey) => set((state) => {
        const conflict = state.conflicts.find((c) => c.id === conflictId);
        if (!conflict || conflict.status === 'decided') return state;
        let areas = state.areas.slice();
        let coverageReports = state.coverageReports.slice();
        let coverageSources = state.coverageSources.slice();
        const events: EventLog[] = [];

        if (conflict.kind === 'coverage' && conflict.areaId) {
          const chosen = conflict.candidates.find((c) => c.key === decidedKey);
          const chosenReport = state.coverageReports.find((r) => r.id === decidedKey);
          if (chosenReport) {
            // 按指挥员定夺的值落地
            areas = areas.map((a) => a.id === conflict.areaId ? { ...a, coverage: Number(chosenReport.coverage) } : a);
            coverageReports = coverageReports.map((r) => r.areaId === conflict.areaId && r.status === 'pending'
              ? { ...r, status: r.id === decidedKey ? 'applied' : 'rejected', merged: true }
              : r);
            for (const r of state.coverageReports.filter((r) => r.areaId === conflict.areaId && r.status === 'pending')) {
              coverageSources.push({
                id: uuid(), areaId: conflict.areaId, assetId: r.assetId, assetName: r.assetName,
                coverage: r.coverage, observedAt: r.observedAt, mergedAt: new Date().toISOString(),
                decision: r.id === decidedKey ? 'applied' : 'rejected'
              });
            }
            events.push({ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `${conflict.title}，已定夺采用 ${chosen?.label}（${chosenReport.coverage}%）` });
          } else {
            // 选择保留已存来源
            coverageReports = coverageReports.map((r) => r.areaId === conflict.areaId && r.status === 'pending' ? { ...r, status: 'rejected', merged: true } : r);
            events.push({ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `${conflict.title}，已定夺保留原覆盖值（${chosen?.label}）` });
          }
        } else {
          events.push({ id: uuid(), time: new Date().toISOString(), actor: '指挥员', message: `${conflict.title}，已定夺按 ${conflict.candidates.find((c) => c.key === decidedKey)?.label ?? decidedKey} 执行` });
        }

        return {
          areas,
          coverageReports,
          coverageSources,
          conflicts: state.conflicts.map((c) => c.id === conflictId ? { ...c, status: 'decided', decidedKey } : c),
          events: events.concat(state.events).slice(0, 50)
        };
      })
    }),
    { name: 'maritime-command-v2' }
  )
);
