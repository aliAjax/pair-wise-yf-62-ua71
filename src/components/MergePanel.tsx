'use client';

import { Badge, Button, Card, Group, List, Stack, Text, Title } from '@mantine/core';
import { isPositionStale } from '@/lib/merge';
import type { MergeConflict, MergeSummary, PendingReport, RescueAsset, SearchArea } from '@/lib/types';
import { useCommandStore } from '@/lib/store';

function clock(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ReconnectPanel({ assets, areas }: { assets: RescueAsset[]; areas: SearchArea[] }) {
  const state = useCommandStore();
  const queued = state.pendingReports.filter((r) => r.status === 'queued');
  const offlineIds = [...new Set(queued.map((r) => r.assetId))];
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  const areaOf = (id?: string) => areas.find((a) => a.id === id)?.name ?? id ?? '--';

  return (
    <Card withBorder>
      <Group justify="space-between">
        <Title order={3}>失联积累与归队合并</Title>
        <Group>
          <Button size="compact-sm" variant="light" onClick={state.seedOfflineBacklog}>灌入演示积累</Button>
          <Button size="compact-sm" disabled={offlineIds.length === 0} onClick={() => state.reconnectAndMerge()}>
            网络恢复 · 合并归队{offlineIds.length > 0 ? `（${offlineIds.length} 单位）` : ''}
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed" mt={4}>
        失联期间船艇、直升机、岸上观察点本地积累位置与覆盖记录；恢复后按观测时间判定过期，任务安排优先于旧搜索区，矛盾只列冲突不自动选值。
      </Text>

      {queued.length === 0 ? (
        <Text size="sm" c="dimmed" mt="md">当前没有待合并的失联积累。</Text>
      ) : (
        <List mt="md" spacing="xs">
          {queued.map((report) => {
            const stale = report.type === 'position' && isPositionStale(report.observedAt, Date.now());
            return (
              <List.Item key={report.id}>
                <Group gap="sm">
                  <b>{nameOf(report.assetId)}</b>
                  <Badge color={report.type === 'position' ? 'blue' : 'grape'}>
                    {report.type === 'position' ? '位置' : `覆盖 ${areaOf(report.areaId)} ${report.coverage}%`}
                  </Badge>
                  {stale && <Badge color="red">观测已过期，需重算</Badge>}
                  <Text size="xs" c="dimmed">观测于 {clock(report.observedAt)}</Text>
                </Group>
                {report.note && <Text size="xs" c="dimmed">{report.note}</Text>}
              </List.Item>
            );
          })}
        </List>
      )}

      <MergeHistory summaries={state.mergeSummaries} assets={assets} />
    </Card>
  );
}

export function ConflictPanel({ assets, areas }: { assets: RescueAsset[]; areas: SearchArea[] }) {
  const state = useCommandStore();
  const open = state.conflicts.filter((c) => c.status === 'open');
  const resolved = state.conflicts.filter((c) => c.status === 'resolved');
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  const areaOf = (id?: string) => areas.find((a) => a.id === id)?.name ?? id ?? '--';

  if (state.conflicts.length === 0) {
    return (
      <Card withBorder>
        <Title order={3}>冲突定夺</Title>
        <Text size="sm" c="dimmed" mt="md">暂无冲突。覆盖率矛盾或一区双派时，会在此列出，由指挥员裁定；未定夺前一律保留原覆盖值。</Text>
      </Card>
    );
  }

  const renderConflict = (conflict: MergeConflict) => (
    <Card key={conflict.id} withBorder padding="sm" bg={conflict.status === 'resolved' ? 'gray.0' : undefined}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Badge color={conflict.kind === 'coverage' ? 'grape' : 'orange'}>
              {conflict.kind === 'coverage' ? '覆盖率矛盾' : '一区双派'}
            </Badge>
            {conflict.status === 'resolved'
              ? <Badge color="teal">已定夺 · {conflict.resolution}</Badge>
              : <Badge color="red">待定夺 · 原值保留</Badge>}
          </Group>
          <Text size="sm" mt={4}>{conflict.message}</Text>
        </div>
      </Group>
      <List mt="xs" spacing={4}>
        {conflict.options.map((option) => (
          <List.Item key={option.reportId}>
            <Group gap="sm" justify="space-between">
              <Text size="sm">
                {nameOf(option.assetId)}：{conflict.kind === 'coverage'
                  ? `${areaOf(option.areaId)} ${option.coverage}%`
                  : `${areaOf(option.areaId)} ${option.coverage}%`}
                {option.redirectedFromAreaId && <Text component="span" c="dimmed" size="xs">（按现行任务从 {areaOf(option.redirectedFromAreaId)} 改投）</Text>}
                <Text component="span" c="dimmed" size="xs"> · 观测于 {clock(option.observedAt)}</Text>
              </Text>
              {conflict.status === 'open' && (
                <Button size="compact-xs" onClick={() => state.resolveConflict(conflict.id, option.reportId)}>采用此笔</Button>
              )}
            </Group>
          </List.Item>
        ))}
      </List>
      {conflict.status === 'open' && (
        <Group mt="xs">
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => state.keepOriginalConflict(conflict.id)}>全部不采用 · 保留原值</Button>
        </Group>
      )}
    </Card>
  );

  return (
    <Card withBorder>
      <Title order={3}>冲突定夺</Title>
      <Stack mt="md" gap="sm">
        {open.map(renderConflict)}
        {resolved.length > 0 && open.length === 0 && <Text size="xs" c="dimmed">以下冲突已定夺</Text>}
        {resolved.map(renderConflict)}
      </Stack>
    </Card>
  );
}

export function MergeHistory({ summaries, assets }: { summaries: MergeSummary[]; assets: RescueAsset[] }) {
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  if (summaries.length === 0) return null;
  return (
    <Stack mt="lg" gap="xs">
      <Title order={5}>合并摘要</Title>
      {summaries.map((summary) => (
        <Card key={summary.id} withBorder padding="xs">
          <Group gap="xs">
            <Text size="xs" c="dimmed">{clock(summary.mergedAt)}</Text>
            <Badge size="xs" color="teal">位置 ×{summary.positionUpdated}</Badge>
            {summary.positionStale > 0 && <Badge size="xs" color="red">过期 ×{summary.positionStale}</Badge>}
            <Badge size="xs" color="grape">覆盖 ×{summary.coverageApplied}</Badge>
            {summary.redirected > 0 && <Badge size="xs" color="blue">任务改投 ×{summary.redirected}</Badge>}
            {summary.conflictsOpened > 0 && <Badge size="xs" color="orange">新冲突 ×{summary.conflictsOpened}</Badge>}
            {summary.reportsRejected > 0 && <Badge size="xs" color="gray">未采用 ×{summary.reportsRejected}</Badge>}
          </Group>
          <Text size="xs" c="dimmed" mt={4}>{summary.assetIds.map(nameOf).join('、')} 归队</Text>
          <List size="xs" mt={4} spacing={2}>
            {summary.details.map((detail, i) => <List.Item key={i}>{detail}</List.Item>)}
          </List>
        </Card>
      ))}
    </Stack>
  );
}

export function PendingBadge({ reports, assetId }: { reports: PendingReport[]; assetId: string }) {
  const count = reports.filter((r) => r.assetId === assetId && r.status === 'queued').length;
  if (count === 0) return null;
  return <Badge color="yellow" size="xs">{count} 笔待合并</Badge>;
}
