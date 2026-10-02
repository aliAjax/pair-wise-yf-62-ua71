export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  coverage: number;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
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

/** 单位离线期间积累的位置观测（观测时间早于恢复时刻） */
export interface ObservationRecord {
  id: string;
  assetId: string;
  assetName: string;
  observedAt: string;
  lat: number;
  lng: number;
  merged: boolean;
}

/** 单位离线期间积累的覆盖回报 */
export interface CoverageReport {
  id: string;
  assetId: string;
  assetName: string;
  areaId: string;
  observedAt: string;
  coverage: number;
  merged: boolean;
  status: 'pending' | 'applied' | 'rejected';
  reason?: string;
}

/** 合并后落地的覆盖来源，用于回溯各覆盖是谁、何时报的 */
export interface CoverageSource {
  id: string;
  areaId: string;
  assetId: string;
  assetName: string;
  coverage: number;
  observedAt: string;
  mergedAt: string;
  decision: 'applied' | 'rejected' | 'superseded';
}

export interface MergeConflictCandidate {
  key: string;
  label: string;
  value: number | string;
  meta?: string;
}

/** 合并冲突：覆盖率矛盾 或 单位同时被分到两个区 */
export interface MergeConflict {
  id: string;
  kind: 'coverage' | 'assignment';
  areaId?: string;
  assetId?: string;
  title: string;
  candidates: MergeConflictCandidate[];
  status: 'pending' | 'decided';
  decidedKey?: string;
  createdAt: string;
}

export interface MergeSnapshot {
  observations: ObservationRecord[];
  coverageReports: CoverageReport[];
  coverageSources: CoverageSource[];
  conflicts: MergeConflict[];
  lastMergedAt: string | null;
}
