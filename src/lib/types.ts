export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  coverage: number;
  /** 每一笔已并入覆盖的来源，保证“各覆盖来源”可追溯 */
  coverageSources: CoverageSource[];
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
  /** 最近一次有效观测时间（不是恢复/合并时刻） */
  lastSeen: string;
}

export interface Mission {
  id: string;
  title: string;
  areaId: string;
  assetIds: string[];
  status: MissionStatus;
  priority: 'normal' | 'urgent';
  note: string;
  updatedAt: string;
}

export interface EventLog {
  id: string;
  time: string;
  actor: string;
  message: string;
}

/** 失联单位在本地积累、链路恢复后带回的记录 */
export interface PendingReport {
  id: string;
  assetId: string;
  type: 'coverage' | 'position';
  /** 覆盖记录指向的搜索区（单位自报，可能与任务安排不符） */
  areaId?: string;
  coverage?: number;
  lat?: number;
  lng?: number;
  /** 观测时间：过期判定一律以它为准 */
  observedAt: string;
  queuedAt: string;
  status: 'queued' | 'merged' | 'held' | 'rejected';
  note?: string;
}

/** 已落库的覆盖来源 */
export interface CoverageSource {
  id: string;
  reportId: string;
  areaId: string;
  assetId: string;
  coverage: number;
  observedAt: string;
  mergedAt: string;
  note?: string;
  /** 单位回报的是旧搜索区、按任务记录改投到执行区时，记录原区 */
  redirectedFromAreaId?: string;
}

export type ConflictKind = 'coverage' | 'assignment';

export interface ConflictOption {
  reportId: string;
  assetId: string;
  areaId: string;
  coverage: number;
  observedAt: string;
  redirectedFromAreaId?: string;
}

/** 必须由指挥员定夺的冲突；未定夺前原值保留 */
export interface MergeConflict {
  id: string;
  kind: ConflictKind;
  status: 'open' | 'resolved';
  detectedAt: string;
  resolvedAt?: string;
  resolution?: string;
  /** coverage：矛盾覆盖所在区；assignment：留空 */
  areaId?: string;
  assetIds: string[];
  message: string;
  heldReportIds: string[];
  options: ConflictOption[];
  /** assignment 冲突涉及的任务，供指挥员选择保留哪一个 */
  missions?: { missionId: string; title: string; areaId: string }[];
}

/** 一次归队合并的摘要，低带宽下只展示它 */
export interface MergeSummary {
  id: string;
  mergedAt: string;
  assetIds: string[];
  positionUpdated: number;
  positionStale: number;
  coverageApplied: number;
  redirected: number;
  conflictsOpened: number;
  reportsRejected: number;
  details: string[];
}
