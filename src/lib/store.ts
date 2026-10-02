'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AreaStatus,
  AssetStatus,
  EventLog,
  MergeConflict,
  MergeSummary,
  Mission,
  MissionStatus,
  PendingReport,
  RescueAsset,
  SearchArea
} from './types';
import { aggregateCoverage, mergePendingReports } from './merge';

const now = Date.now();
const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

const initialAreas: SearchArea[] = [
  {
    id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverage: 68,
    coverageSources: [
      { id: 'seed-src-1', reportId: 'seed-1', areaId: 'area-a', assetId: 'ship-01', coverage: 68, observedAt: iso(12 * 60_000), mergedAt: iso(11 * 60_000) }
    ]
  },
  {
    id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverage: 32,
    coverageSources: [
      { id: 'seed-src-2', reportId: 'seed-2', areaId: 'area-b', assetId: 'heli-02', coverage: 32, observedAt: iso(9 * 60_000), mergedAt: iso(8 * 60_000) }
    ]
  }
];
const initialAssets: RescueAsset[] = [
  { id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned', lat: 30.75, lng: 121.55, lastSeen: iso(35_000) },
  { id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready', lat: 30.82, lng: 121.73, lastSeen: iso(7 * 60_000) },
  { id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline', lat: 30.69, lng: 121.61, lastSeen: iso(18 * 60_000) },
  { id: 'shore-04', name: '岸上观察点·东矶', type: 'shore', status: 'offline', lat: 30.91, lng: 121.83, lastSeen: iso(40 * 60_000) }
];
const initialMissions: Mission[] = [
  { id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'], status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物', updatedAt: iso(6 * 60_000) }
];
const initialEvents: EventLog[] = [
  { id: 'event-1', time: iso(15 * 60_000), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: 'event-2', time: iso(6 * 60_000), actor: '无人机D-9', message: '链路中断，最后位置已标记为过期' }
];

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  /** 失联单位离线积累、待网络恢复合并的记录 */
  pendingReports: PendingReport[];
  /** 合并中发现、待指挥员定夺的冲突 */
  conflicts: MergeConflict[];
  /** 历次合并摘要（低带宽模式也保留） */
  mergeSummaries: MergeSummary[];
  offline: boolean;
  lowBandwidth: boolean;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  setMissionStatus: (id: string, status: MissionStatus) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string }) => void;
  /** 失联单位在本地登记一条积累记录（坐标/覆盖），观测时间由记录自带 */
  enqueueReport: (input: {
    assetId: string;
    type: 'coverage' | 'position';
    areaId?: string;
    coverage?: number;
    lat?: number;
    lng?: number;
    observedAgoMs: number;
    note?: string;
  }) => void;
  /** 一键灌入演示用失联积累（含过期位置、任务改投、矛盾与双派） */
  seedOfflineBacklog: () => void;
  /** 网络恢复：合并归队单位的全部积累记录 */
  reconnectAndMerge: (assetIds?: string[]) => void;
  /** 指挥员对冲突定夺：采用某一笔（coverage/assignment 通用） */
  resolveConflict: (conflictId: string, reportId: string) => void;
  /** 指挥员对冲突定夺：全部不采用，保留原覆盖值 */
  keepOriginalConflict: (conflictId: string) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
}

const log = (actor: string, message: string): EventLog =>
  ({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, message });

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => ({
      areas: initialAreas,
      assets: initialAssets,
      missions: initialMissions,
      events: initialEvents,
      pendingReports: [],
      conflicts: [],
      mergeSummaries: [],
      offline: false,
      lowBandwidth: false,

      setAreaStatus: (id, status) => set((state) => ({
        areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
        events: [log('指挥员', `搜索区 ${id} 状态改为 ${status}`), ...state.events]
      })),

      setAssetStatus: (id, status) => set((state) => ({
        assets: state.assets.map((asset) => asset.id === id ? { ...asset, status } : asset),
        events: [log('值班员', `${assetName(state, id)} 状态改为 ${status}`), ...state.events]
      })),

      setMissionStatus: (id, status) => set((state) => ({
        missions: state.missions.map((mission) => mission.id === id ? { ...mission, status, updatedAt: new Date().toISOString() } : mission),
        events: [log('指挥员', `任务 ${id} 状态改为 ${status}`), ...state.events]
      })),

      dispatchMission: (input) => set((state) => {
        const mission: Mission = { id: crypto.randomUUID(), ...input, status: 'dispatched', updatedAt: new Date().toISOString() };
        return {
          missions: [mission, ...state.missions],
          assets: state.assets.map((asset) => input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset),
          events: [log('指挥员', `任务“${input.title}”已派发，调派 ${input.assetIds.map((id) => assetName(state, id)).join('、')} 至 ${input.areaId}`), ...state.events]
        };
      }),

      enqueueReport: (input) => set((state) => {
        const nowMs = Date.now();
        const report: PendingReport = {
          id: crypto.randomUUID(),
          assetId: input.assetId,
          type: input.type,
          areaId: input.areaId,
          coverage: input.coverage,
          lat: input.lat,
          lng: input.lng,
          observedAt: new Date(nowMs - input.observedAgoMs).toISOString(),
          queuedAt: new Date(nowMs).toISOString(),
          status: 'queued',
          note: input.note
        };
        return {
          pendingReports: [report, ...state.pendingReports],
          events: [log(assetName(state, input.assetId), `失联期间积累${input.type === 'coverage' ? `覆盖记录（${input.areaId} ${input.coverage}%）` : '位置记录'}，观测于 ${new Date(report.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}，待网络恢复合并`), ...state.events]
        };
      }),

      seedOfflineBacklog: () => set((state) => {
        const nowMs = Date.now();
        const mk = (partial: Omit<PendingReport, 'id' | 'queuedAt' | 'status'>): PendingReport => ({
          id: crypto.randomUUID(), queuedAt: new Date(nowMs).toISOString(), status: 'queued', ...partial
        });
        const reports: PendingReport[] = [
          // 海巡071 已在失联前被改派至 B 区任务，却回报旧 A 区覆盖：任务记录说了算
          mk({ assetId: 'ship-01', type: 'position', lat: 30.95, lng: 121.8, observedAt: new Date(nowMs - 3 * 60_000).toISOString() }),
          mk({ assetId: 'ship-01', type: 'coverage', areaId: 'area-a', coverage: 78, observedAt: new Date(nowMs - 20 * 60_000).toISOString(), note: '改派前在 A 区的扫测' }),
          // 无人机：位置观测已过期（25 分钟前），不能用恢复时刻顶替
          mk({ assetId: 'drone-03', type: 'position', lat: 30.71, lng: 121.63, observedAt: new Date(nowMs - 25 * 60_000).toISOString(), note: '失联前最后定位' }),
          // 无人机对 A 区报 91%，与海巡071 在位的 68% 矛盾 → 覆盖冲突
          mk({ assetId: 'drone-03', type: 'coverage', areaId: 'area-a', coverage: 91, observedAt: new Date(nowMs - 24 * 60_000).toISOString() }),
          // 岸上观察点：5 分钟前新位置有效
          mk({ assetId: 'shore-04', type: 'position', lat: 30.912, lng: 121.833, observedAt: new Date(nowMs - 5 * 60_000).toISOString() }),
          // 岸点报 A 区 41%，与 68%/91% 矛盾
          mk({ assetId: 'shore-04', type: 'coverage', areaId: 'area-a', coverage: 41, observedAt: new Date(nowMs - 6 * 60_000).toISOString() }),
          // 直升机同一批对两个区都有覆盖 → 一区双派冲突
          mk({ assetId: 'heli-02', type: 'coverage', areaId: 'area-a', coverage: 55, observedAt: new Date(nowMs - 4 * 60_000).toISOString() }),
          mk({ assetId: 'heli-02', type: 'coverage', areaId: 'area-b', coverage: 47, observedAt: new Date(nowMs - 3 * 60_000).toISOString() })
        ];
        const reassignment: Mission = {
          id: crypto.randomUUID(),
          title: 'B区漂流复核',
          areaId: 'area-b',
          assetIds: ['ship-01'],
          status: 'dispatched',
          priority: 'normal',
          note: 'A区交无人机扫尾，海巡071改查北向漂流',
          updatedAt: new Date(nowMs - 2 * 60_000).toISOString()
        };
        return {
          pendingReports: [...reports, ...state.pendingReports],
          missions: state.missions.some((m) => m.title === reassignment.title) ? state.missions : [reassignment, ...state.missions],
          assets: state.assets.map((a) => ['drone-03', 'shore-04', 'heli-02', 'ship-01'].includes(a.id) ? { ...a, status: 'offline' as AssetStatus } : a),
          events: [log('系统', '已灌入演示失联积累：含过期位置、任务改投、矛盾覆盖与一区双派，等待网络恢复合并'), ...state.events]
        };
      }),

      reconnectAndMerge: (assetIds) => {
        const state = get();
        const scope = assetIds ?? [...new Set(state.pendingReports.filter((r) => r.status === 'queued').map((r) => r.assetId))];
        if (scope.length === 0) {
          set((s) => ({ events: [log('系统', '没有待合并的失联积累记录'), ...s.events] }));
          return;
        }
        const result = mergePendingReports({
          areas: state.areas,
          assets: state.assets,
          missions: state.missions,
          pending: state.pendingReports,
          existingConflicts: state.conflicts,
          assetIds: scope,
          nowMs: Date.now()
        });

        // 在岗情况：过期位置 → 归队待重算；有现行任务 → assigned；否则 ready。绝不刷 lastSeen
        const activeMissionByAsset = (assetId: string) =>
          state.missions.find((m) => m.assetIds.includes(assetId) && m.status !== 'closed' && m.status !== 'draft');
        const latestPositionStale = (assetId: string) => {
          const report = result.pending
            .filter((r) => r.assetId === assetId && r.type === 'position')
            .sort((a, b) => +new Date(b.observedAt) - +new Date(a.observedAt))[0];
          return report?.status === 'held';
        };
        const assets = result.assets.map((asset) => {
          if (!scope.includes(asset.id) || asset.status !== 'offline') return asset;
          if (latestPositionStale(asset.id)) return { ...asset, status: 'returning' as AssetStatus };
          return { ...asset, status: activeMissionByAsset(asset.id) ? 'assigned' as AssetStatus : 'ready' as AssetStatus };
        });

        set({
          areas: result.areas,
          assets,
          pendingReports: result.pending,
          conflicts: result.conflicts,
          mergeSummaries: [result.summary, ...state.mergeSummaries].slice(0, 30),
          events: [
            log('系统', `网络恢复，${scope.map((id) => assetName(state, id)).join('、')} 归队合并完成：位置更新 ${result.summary.positionUpdated}、过期 ${result.summary.positionStale}、覆盖并入 ${result.summary.coverageApplied}、任务改投 ${result.summary.redirected}、新增冲突 ${result.summary.conflictsOpened}`),
            ...result.summary.details.map((message) => log('合并引擎', message)),
            ...state.events
          ]
        });
      },

      resolveConflict: (conflictId, reportId) => set((state) => {
        const conflict = state.conflicts.find((c) => c.id === conflictId);
        if (!conflict || conflict.status === 'resolved') return {};
        const option = conflict.options.find((o) => o.reportId === reportId);
        if (!option) return {};
        const mergedAt = new Date().toISOString();

        let areas = state.areas;
        if (conflict.kind === 'coverage' && conflict.areaId) {
          areas = state.areas.map((area) => {
            if (area.id !== conflict.areaId) return area;
            const sources = [...area.coverageSources, {
              id: crypto.randomUUID(),
              reportId: option.reportId,
              areaId: area.id,
              assetId: option.assetId,
              coverage: option.coverage,
              observedAt: option.observedAt,
              mergedAt,
              redirectedFromAreaId: option.redirectedFromAreaId,
              note: '指挥员裁决采用'
            }];
            return { ...area, coverage: aggregateCoverage(sources), coverageSources: sources };
          });
        }
        if (conflict.kind === 'assignment') {
          areas = state.areas.map((area) => {
            if (area.id !== option.areaId) return area;
            const sources = [...area.coverageSources, {
              id: crypto.randomUUID(),
              reportId: option.reportId,
              areaId: option.areaId,
              assetId: option.assetId,
              coverage: option.coverage,
              observedAt: option.observedAt,
              mergedAt,
              redirectedFromAreaId: option.redirectedFromAreaId,
              note: '指挥员确认执行区'
            }];
            return { ...area, coverage: aggregateCoverage(sources), coverageSources: sources };
          });
        }

        const conflicts = state.conflicts.map((c) => c.id === conflictId
          ? { ...c, status: 'resolved' as const, resolvedAt: mergedAt, resolution: `采用 ${assetName(state, option.assetId)} 的 ${option.coverage}%（${option.areaId}）` }
          : c);
        // 采用一笔，其余挂起记录作废（不覆盖落库值）
        const pendingReports = state.pendingReports.map((r) => {
          if (!conflict.heldReportIds.includes(r.id)) return r;
          if (r.id === option.reportId) {
            return { ...r, status: 'merged' as const, areaId: option.areaId, note: option.redirectedFromAreaId ? `指挥员裁决采用，覆盖落到执行区 ${option.areaId}（原回报 ${option.redirectedFromAreaId}）` : '指挥员裁决采用' };
          }
          return { ...r, status: 'rejected' as const, note: '指挥员裁决未采用，保留原覆盖值' };
        });
        return {
          areas,
          conflicts,
          pendingReports,
          events: [log('指挥员', `冲突定夺：${conflict.message} → 采用 ${assetName(state, option.assetId)} 报 ${option.coverage}%（落 ${option.areaId}）`), ...state.events]
        };
      }),

      keepOriginalConflict: (conflictId) => set((state) => {
        const conflict = state.conflicts.find((c) => c.id === conflictId);
        if (!conflict || conflict.status === 'resolved') return {};
        const resolvedAt = new Date().toISOString();
        return {
          conflicts: state.conflicts.map((c) => c.id === conflictId ? { ...c, status: 'resolved' as const, resolvedAt, resolution: '保留原覆盖值，挂起记录均不采用' } : c),
          pendingReports: state.pendingReports.map((r) =>
            conflict.heldReportIds.includes(r.id) ? { ...r, status: 'rejected' as const, note: '指挥员决定保留原覆盖值' } : r
          ),
          events: [log('指挥员', `冲突定夺：${conflict.message} → 保留原值，不采用任何挂起记录`), ...state.events]
        };
      }),

      toggleOffline: () => set((state) => ({ offline: !state.offline })),
      toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth }))
    }),
    {
      name: 'maritime-command-v2',
      version: 2,
      partialize: (state) => ({
        areas: state.areas,
        assets: state.assets,
        missions: state.missions,
        events: state.events,
        pendingReports: state.pendingReports,
        conflicts: state.conflicts,
        mergeSummaries: state.mergeSummaries,
        offline: state.offline,
        lowBandwidth: state.lowBandwidth
      })
    }
  )
);

function assetName(state: { assets: RescueAsset[] }, id: string): string {
  return state.assets.find((a) => a.id === id)?.name ?? id;
}
