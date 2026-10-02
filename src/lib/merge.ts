import type {
  CoverageSource,
  MergeConflict,
  MergeSummary,
  Mission,
  PendingReport,
  RescueAsset,
  SearchArea
} from './types';

/** 位置有效期：超过即判过期（10 分钟） */
export const STALE_AFTER_MS = 10 * 60_000;

export function isPositionStale(observedAt: string | number | Date, nowMs: number): boolean {
  return nowMs - new Date(observedAt).getTime() > STALE_AFTER_MS;
}

export interface MergeInput {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  pending: PendingReport[];
  /** 已存在但尚未定夺的冲突 */
  existingConflicts: MergeConflict[];
  /** 归队的单位；不传则合并全部 queued 记录 */
  assetIds?: string[];
  nowMs: number;
}

export interface MergeResult {
  areas: SearchArea[];
  assets: RescueAsset[];
  pending: PendingReport[];
  conflicts: MergeConflict[];
  summary: MergeSummary;
}

interface ActiveAreaEntry {
  reportId: string;
  areaId: string;
  coverage: number;
  observedAt: string;
  redirectedFromAreaId?: string;
}

const activeMission = (missions: Mission[], assetId: string): Mission | undefined =>
  missions
    .filter((m) => m.assetIds.includes(assetId) && m.status !== 'closed' && m.status !== 'draft')
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];

/**
 * 合并失联单位带回的记录：
 * - 一律按观测时间判定过期，绝不拿恢复时刻当新位置；
 * - 任务记录优先于单位回报的旧搜索区，新增覆盖落到实际执行的区；
 * - 覆盖率矛盾、一区双派只列冲突，不定夺前保留原值。
 */
export function mergePendingReports(input: MergeInput): MergeResult {
  const { nowMs } = input;
  const batchId = crypto.randomUUID();
  const mergedAt = new Date(nowMs).toISOString();

  const scope = new Set(input.assetIds ?? input.pending.map((r) => r.assetId));
  const queued = input.pending.filter((r) => r.status === 'queued' && scope.has(r.assetId));
  const untouched = input.pending.filter((r) => !(r.status === 'queued' && scope.has(r.assetId)));

  const assets = [...input.assets];
  const areas = input.areas.map((area) => ({ ...area, coverageSources: [...area.coverageSources] }));
  const processed: PendingReport[] = [];
  const conflicts = [...input.existingConflicts];
  const details: string[] = [];
  let positionUpdated = 0;
  let positionStale = 0;
  let coverageApplied = 0;
  let redirected = 0;
  let reportsRejected = 0;

  // ---- 位置：按观测时间判过期，过期只标记不采用 ----
  for (const report of queued.filter((r) => r.type === 'position')) {
    const asset = assets.find((a) => a.id === report.assetId);
    if (!asset || report.lat === undefined || report.lng === undefined) {
      processed.push({ ...report, status: 'rejected', note: '单位不存在或位置数据缺失' });
      reportsRejected += 1;
      continue;
    }
    // 观测时间早于已采用的观测时间，属于更旧的数据，不回退
    if (+new Date(report.observedAt) <= +new Date(asset.lastSeen)) {
      processed.push({ ...report, status: 'rejected', note: '观测时间不早于在位数据' });
      reportsRejected += 1;
      continue;
    }
    if (isPositionStale(report.observedAt, nowMs)) {
      positionStale += 1;
      processed.push({
        ...report,
        status: 'held',
        note: `观测时间 ${formatClock(report.observedAt)} 已超过 ${STALE_AFTER_MS / 60000} 分钟，位置判过期，需重新推算，未采用恢复时刻坐标`
      });
      details.push(`${asset.name} 位置过期（观测于 ${formatClock(report.observedAt)}），未更新坐标，需重算`);
      continue;
    }
    const idx = assets.findIndex((a) => a.id === report.assetId);
    assets[idx] = { ...asset, lat: report.lat, lng: report.lng, lastSeen: report.observedAt };
    positionUpdated += 1;
    processed.push({ ...report, status: 'merged', note: `按观测时间 ${formatClock(report.observedAt)} 采用` });
    details.push(`${asset.name} 位置已按观测时间 ${formatClock(report.observedAt)} 更新`);
  }

  // ---- 覆盖：任务记录定区，矛盾/双派只挂冲突 ----
  // 本次合并中每个单位的有效覆盖去向（用于查“同一单位同时到两个区”）
  const perAssetArea = new Map<string, ActiveAreaEntry[]>();

  // 先做任务改投，得到每条覆盖的实际落区
  const resolved: { report: PendingReport; entry: ActiveAreaEntry }[] = [];
  for (const report of queued.filter((r) => r.type === 'coverage')) {
    const asset = input.assets.find((a) => a.id === report.assetId);
    if (!asset || report.areaId === undefined || report.coverage === undefined) {
      processed.push({ ...report, status: 'rejected', note: '单位、搜索区或覆盖率缺失' });
      reportsRejected += 1;
      continue;
    }
    const targetArea = areas.find((a) => a.id === report.areaId);
    if (!targetArea) {
      processed.push({ ...report, status: 'rejected', note: `回报区 ${report.areaId} 不存在` });
      reportsRejected += 1;
      continue;
    }
    const mission = activeMission(input.missions, report.assetId);
    let areaId = report.areaId;
    let redirectFrom: string | undefined;
    if (mission && mission.areaId !== report.areaId) {
      // 单位已被调给新任务：任务记录说了算，旧搜索区不覆盖任务安排
      areaId = mission.areaId;
      redirectFrom = report.areaId;
      redirected += 1;
      details.push(`${asset.name} 回报 ${report.areaId} 覆盖，但现行任务为“${mission.title}”，覆盖改记到 ${mission.areaId}`);
    }
    const entry: ActiveAreaEntry = {
      reportId: report.id,
      areaId,
      coverage: report.coverage,
      observedAt: report.observedAt,
      redirectedFromAreaId: redirectFrom
    };
    resolved.push({ report, entry });
    pushMap(perAssetArea, report.assetId, entry);
  }

  const heldReportIds = new Set<string>();

  // 冲突一：同一单位本次同时覆盖两个区（任务双派）
  for (const [assetId, entries] of perAssetArea) {
    const areaIds = [...new Set(entries.map((e) => e.areaId))];
    if (areaIds.length < 2) continue;
    const asset = input.assets.find((a) => a.id === assetId)!;
    const relatedMissions = input.missions
      .filter((m) => m.assetIds.includes(assetId) && m.status !== 'closed' && m.status !== 'draft')
      .map((m) => ({ missionId: m.id, title: m.title, areaId: m.areaId }));
    entries.forEach((e) => heldReportIds.add(e.reportId));
    conflicts.push({
      id: crypto.randomUUID(),
      kind: 'assignment',
      status: 'open',
      detectedAt: mergedAt,
      assetIds: [assetId],
      areaId: undefined,
      heldReportIds: entries.map((e) => e.reportId),
      options: entries.map((e) => ({
        reportId: e.reportId,
        assetId,
        areaId: e.areaId,
        coverage: e.coverage,
        observedAt: e.observedAt,
        redirectedFromAreaId: e.redirectedFromAreaId
      })),
      missions: relatedMissions,
      message: `${asset.name} 同时在 ${areaIds.join('、')} 两个区有覆盖回报，疑似一区双派，请指挥员确认其实际执行区`
    });
    details.push(`冲突：${asset.name} 同时分到 ${areaIds.join('、')}，覆盖暂缓，等待定夺`);
  }

  // 每个单位在每个区只取最新一笔观测参与比对
  const incomingClaim = new Map<string, { assetId: string; entry: ActiveAreaEntry }>();
  for (const { report, entry } of resolved) {
    const key = `${report.assetId}@${entry.areaId}`;
    const prior = incomingClaim.get(key);
    if (!prior || +new Date(entry.observedAt) > +new Date(prior.entry.observedAt)) {
      incomingClaim.set(key, { assetId: report.assetId, entry });
    }
  }

  // 冲突二：不同单位对同一区给出矛盾覆盖率（新回报之间，或新回报与区内既有来源之间）
  for (const area of areas) {
    // 区内既有来源（指挥员此前已接受的值），每单位取最新
    const existing = new Map<string, { assetId: string; coverage: number; observedAt: string }>();
    for (const source of area.coverageSources) {
      const prior = existing.get(source.assetId);
      if (!prior || +new Date(source.observedAt) > +new Date(prior.observedAt)) {
        existing.set(source.assetId, { assetId: source.assetId, coverage: source.coverage, observedAt: source.observedAt });
      }
    }
    const incomingHere = [...incomingClaim.values()]
      .filter((c) => c.entry.areaId === area.id && !heldReportIds.has(c.entry.reportId));

    // 新回报之间先两两比对：没有在位来源时，彼此相差 >5 即互为矛盾，整组挂起
    const contradicted = new Set<string>();
    if (existing.size === 0) {
      for (let i = 0; i < incomingHere.length; i++) {
        for (let j = i + 1; j < incomingHere.length; j++) {
          if (incomingHere[i].assetId === incomingHere[j].assetId) continue;
          if (Math.abs(incomingHere[i].entry.coverage - incomingHere[j].entry.coverage) > 5) {
            contradicted.add(incomingHere[i].entry.reportId);
            contradicted.add(incomingHere[j].entry.reportId);
          }
        }
      }
    }
    // 与在位来源比对：能与任一在位来源吻合（≤5）即沿用；否则视为矛盾，挂起待裁定
    for (const claim of incomingHere) {
      if (existing.size === 0) continue;
      const agrees = [...existing.values()].some((base) => base.assetId !== claim.assetId && Math.abs(base.coverage - claim.entry.coverage) <= 5);
      if (!agrees) contradicted.add(claim.entry.reportId);
    }
    if (contradicted.size === 0) continue;

    const held = incomingHere.filter((c) => contradicted.has(c.entry.reportId));
    held.forEach((c) => heldReportIds.add(c.entry.reportId));
    const allValues = [...[...existing.values()].map((c) => c.coverage), ...held.map((c) => c.entry.coverage)];
    conflicts.push({
      id: crypto.randomUUID(),
      kind: 'coverage',
      status: 'open',
      detectedAt: mergedAt,
      assetIds: [...new Set([...existing.keys(), ...held.map((c) => c.assetId)])],
      areaId: area.id,
      heldReportIds: held.map((c) => c.entry.reportId),
      options: held.map((c) => ({
        reportId: c.entry.reportId,
        assetId: c.assetId,
        areaId: area.id,
        coverage: c.entry.coverage,
        observedAt: c.entry.observedAt,
        redirectedFromAreaId: c.entry.redirectedFromAreaId
      })),
      message: `${area.name} 各单位覆盖率矛盾（${Math.min(...allValues)}%～${Math.max(...allValues)}%），请指挥员裁定；未定夺前保留原覆盖值 ${area.coverage}%`
    });
    details.push(`冲突：${area.name} 覆盖率矛盾（${Math.min(...allValues)}%～${Math.max(...allValues)}%），保留原值 ${area.coverage}%，等待定夺`);
  }

  // 未落冲突的覆盖才入库；有冲突的区/单位整批挂起，原值不动
  for (const { report, entry } of resolved) {
    const asset = input.assets.find((a) => a.id === report.assetId)!;
    if (heldReportIds.has(entry.reportId)) {
      processed.push({
        ...report,
        areaId: entry.areaId,
        status: 'held',
        note: entry.redirectedFromAreaId
          ? `已按现行任务改投至 ${entry.areaId}（原回报 ${entry.redirectedFromAreaId}）；冲突待指挥员定夺，原覆盖值保留`
          : '冲突待指挥员定夺，原覆盖值保留'
      });
      continue;
    }
    const source: CoverageSource = {
      id: crypto.randomUUID(),
      reportId: report.id,
      areaId: entry.areaId,
      assetId: report.assetId,
      coverage: entry.coverage,
      observedAt: entry.observedAt,
      mergedAt,
      redirectedFromAreaId: entry.redirectedFromAreaId,
      note: entry.redirectedFromAreaId ? `按现行任务改投，原回报区 ${entry.redirectedFromAreaId}` : undefined
    };
    const idx = areas.findIndex((a) => a.id === entry.areaId);
    const sources = [...areas[idx].coverageSources, source];
    areas[idx] = { ...areas[idx], coverage: aggregateCoverage(sources), coverageSources: sources };
    coverageApplied += 1;
    processed.push({
      ...report,
      areaId: entry.areaId,
      status: 'merged',
      note: entry.redirectedFromAreaId
        ? `覆盖落到实际执行区 ${entry.areaId}（原回报 ${entry.redirectedFromAreaId}）`
        : `覆盖 ${entry.coverage}% 已并入 ${entry.areaId}`
    });
    details.push(`${asset.name} 覆盖 ${entry.coverage}% 记入 ${entry.areaId}${entry.redirectedFromAreaId ? `（任务改投，原报 ${entry.redirectedFromAreaId}）` : ''}`);
  }

  const summary: MergeSummary = {
    id: batchId,
    mergedAt,
    assetIds: [...scope],
    positionUpdated,
    positionStale,
    coverageApplied,
    redirected,
    conflictsOpened: conflicts.length - input.existingConflicts.length,
    reportsRejected,
    details
  };

  return { areas, assets, pending: [...untouched, ...processed], conflicts, summary };
}

/** 覆盖率聚合：同源取新，跨源取最大（各扫一段，不重复计） */
export function aggregateCoverage(sources: CoverageSource[]): number {
  const byAsset = new Map<string, CoverageSource>();
  for (const source of sources) {
    const prior = byAsset.get(source.assetId);
    if (!prior || +new Date(source.observedAt) > +new Date(prior.observedAt)) byAsset.set(source.assetId, source);
  }
  const max = Math.max(0, ...[...byAsset.values()].map((s) => s.coverage));
  return Math.round(max);
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
