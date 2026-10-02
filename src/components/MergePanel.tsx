'use client';

import { Badge, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { STALE_MS, useCommandStore } from '@/lib/store';

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

/** 合并归队面板：离线记录、冲突定夺、覆盖来源；低带宽仅摘要 */
export function MergePanel() {
  const state = useCommandStore();
  const pendingObs = state.observations.filter((o) => !o.merged);
  const pendingReports = state.coverageReports.filter((r) => !r.merged);
  const pendingConflicts = state.conflicts.filter((c) => c.status === 'pending');
  const decidedConflicts = state.conflicts.filter((c) => c.status === 'decided');
  const rejectedReports = state.coverageReports.filter((r) => r.status === 'rejected');

  const staleCount = state.assets.filter((a) => Date.now() - new Date(a.lastSeen).getTime() > STALE_MS).length;

  if (state.lowBandwidth) {
    return (
      <Card withBorder>
        <Group justify="space-between">
          <Title order={3}>合并归队</Title>
          <Badge color="gray">低带宽 · 仅摘要</Badge>
        </Group>
        <Text size="sm" mt="xs">
          待合并：{pendingObs.length} 条位置观测、{pendingReports.length} 条覆盖回报 ·
          待指挥员定夺冲突 {pendingConflicts.length} 起 · 过期位置 {staleCount} 处 ·
          覆盖来源 {state.coverageSources.length} 条
        </Text>
        <Group mt="md">
          <Button size="xs" variant="light" onClick={state.accumulateOfflineRecords} disabled={!state.offline}>积累离线记录</Button>
          <Button size="xs" onClick={state.mergeOfflineRecords} disabled={pendingObs.length + pendingReports.length === 0}>合并归队</Button>
        </Group>
      </Card>
    );
  }

  return (
    <Card withBorder>
      <Group justify="space-between">
        <Title order={3}>合并归队</Title>
        <Group>
          {state.lastMergedAt && <Text size="xs" c="dimmed">上次合并 {formatDistanceToNow(new Date(state.lastMergedAt), { addSuffix: true, locale: zhCN })}</Text>}
          <Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线缓存中' : '网络在线'}</Badge>
        </Group>
      </Group>

      <Group mt="md">
        <Button size="xs" variant="light" onClick={state.accumulateOfflineRecords} disabled={!state.offline}>积累离线记录</Button>
        <Button size="xs" onClick={state.mergeOfflineRecords} disabled={pendingObs.length + pendingReports.length === 0}>
          合并归队{pendingObs.length + pendingReports.length > 0 ? `（${pendingObs.length + pendingReports.length}）` : ''}
        </Button>
        <Text size="xs" c="dimmed">失联单位离线积累观测与覆盖，恢复后按观测时间合并</Text>
      </Group>

      <Stack mt="md" gap="xs">
        <Text size="sm" fw={600}>待合并记录</Text>
        {pendingObs.length + pendingReports.length === 0 ? (
          <Text size="xs" c="dimmed">无待合并的离线记录</Text>
        ) : (
          <Table fz="xs">
            <thead><tr><th>单位</th><th>类型</th><th>观测时间</th><th>内容</th></tr></thead>
            <tbody>
              {pendingObs.map((o) => {
                const stale = Date.now() - new Date(o.observedAt).getTime() > STALE_MS;
                return (
                  <tr key={o.id}>
                    <td>{o.assetName}</td>
                    <td><Badge size="xs" color={stale ? 'red' : 'blue'}>位置观测{stale ? '·过期' : ''}</Badge></td>
                    <td>{fmtTime(o.observedAt)}</td>
                    <td>{o.lat.toFixed(3)}, {o.lng.toFixed(3)}</td>
                  </tr>
                );
              })}
              {pendingReports.map((r) => (
                <tr key={r.id}>
                  <td>{r.assetName}</td>
                  <td><Badge size="xs" color="grape">覆盖回报</Badge></td>
                  <td>{fmtTime(r.observedAt)}</td>
                  <td>{state.areas.find((a) => a.id === r.areaId)?.name ?? r.areaId} · 覆盖率 {r.coverage}%</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>

      <Stack mt="md" gap="xs">
        <Text size="sm" fw={600}>冲突定夺（未定夺保留原覆盖值）</Text>
        {pendingConflicts.length === 0 && <Text size="xs" c="dimmed">无待决冲突</Text>}
        {pendingConflicts.map((c) => (
          <Card key={c.id} withBorder padding="xs">
            <Group justify="space-between">
              <div>
                <Text size="sm" fw={600}>{c.title}</Text>
                <Text size="xs" c="dimmed">{c.kind === 'coverage' ? '覆盖率矛盾' : '任务分配矛盾'}</Text>
              </div>
              <Badge color="orange">待定夺</Badge>
            </Group>
            <Group mt="xs">
              {c.candidates.map((cand) => (
                <Button key={cand.key} size="compact-xs" variant="light" onClick={() => state.resolveConflict(c.id, cand.key)}>
                  {cand.label}{typeof cand.value === 'number' ? ` · ${cand.value}%` : ` · ${state.areas.find((a) => a.id === cand.value)?.name ?? cand.value}`}
                </Button>
              ))}
            </Group>
          </Card>
        ))}
        {decidedConflicts.map((c) => (
          <Group key={c.id} justify="space-between">
            <Text size="xs" c="dimmed">{c.title} → 已按 {c.candidates.find((cd) => cd.key === c.decidedKey)?.label ?? c.decidedKey} 定夺</Text>
            <Badge size="xs" color="teal">已定夺</Badge>
          </Group>
        ))}
      </Stack>

      <Stack mt="md" gap="xs">
        <Text size="sm" fw={600}>覆盖来源（合并后可追溯）</Text>
        {state.coverageSources.length === 0 ? (
          <Text size="xs" c="dimmed">暂无落地覆盖来源</Text>
        ) : (
          <Table fz="xs">
            <thead><tr><th>搜索区</th><th>来源单位</th><th>覆盖率</th><th>观测时间</th><th>状态</th></tr></thead>
            <tbody>
              {state.coverageSources.slice().reverse().map((s) => (
                <tr key={s.id}>
                  <td>{state.areas.find((a) => a.id === s.areaId)?.name ?? s.areaId}</td>
                  <td>{s.assetName}</td>
                  <td>{s.coverage}%</td>
                  <td>{fmtTime(s.observedAt)}</td>
                  <td><Badge size="xs" color={s.decision === 'applied' ? 'teal' : s.decision === 'superseded' ? 'gray' : 'red'}>{s.decision === 'applied' ? '已采用' : s.decision === 'superseded' ? '被替代' : '已驳回'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>

      {rejectedReports.length > 0 && (
        <Stack mt="md" gap="xs">
          <Text size="sm" fw={600}>未落地回报（任务记录说了算）</Text>
          {rejectedReports.slice().reverse().map((r) => (
            <Text key={r.id} size="xs" c="red">{r.assetName} → {state.areas.find((a) => a.id === r.areaId)?.name ?? r.areaId}：{r.reason}</Text>
          ))}
        </Stack>
      )}
    </Card>
  );
}
