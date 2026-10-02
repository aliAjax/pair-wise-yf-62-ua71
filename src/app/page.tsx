'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Grid, Group, List, Progress, SimpleGrid, Stack, Switch, Table, Text, Textarea, TextInput, Timeline, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useState } from 'react';
import { useCommandStore } from '@/lib/store';
import { isPositionStale } from '@/lib/merge';
import { SearchMap } from '@/components/SearchMap';
import { ConflictPanel, PendingBadge, ReconnectPanel } from '@/components/MergePanel';

const missionSchema = z.object({
  title: z.string().min(3, '任务名称至少3个字'),
  areaId: z.string().min(1),
  assetIds: z.array(z.string()).min(1, '至少调派一个单位'),
  priority: z.enum(['normal', 'urgent']),
  note: z.string().max(160)
});

const assetTypeLabel: Record<string, string> = { ship: '船艇', helicopter: '直升机', drone: '无人机', shore: '岸上观察点' };
const assetStatusMeta: Record<string, { label: string; color: string }> = {
  ready: { label: '在岗待命', color: 'teal' },
  assigned: { label: '执行任务', color: 'blue' },
  offline: { label: '失联', color: 'red' },
  returning: { label: '归队·位置待重算', color: 'orange' }
};

export default function CommandPage() {
  const state = useCommandStore();
  const [selectedAssets, setSelectedAssets] = useState<string[]>(['ship-01']);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof missionSchema>>({
    resolver: zodResolver(missionSchema),
    defaultValues: { title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' }
  });
  const brief = useQuery({
    queryKey: ['sea-state'],
    queryFn: async () => ({ wind: '东北风 6级', visibility: '4.2海里', tide: '涨潮' }),
    refetchInterval: state.lowBandwidth ? false : 60_000
  });

  const submitMission = (values: z.infer<typeof missionSchema>) => {
    state.dispatchMission({ ...values, assetIds: selectedAssets });
    reset({ title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' });
  };

  const nameOf = (id: string) => state.assets.find((a) => a.id === id)?.name ?? id;
  const areaNameOf = (id: string) => state.areas.find((a) => a.id === id)?.name ?? id;
  const pendingCount = state.pendingReports.filter((r) => r.status === 'queued').length;
  const openConflicts = state.conflicts.filter((c) => c.status === 'open').length;
  const staleCount = state.assets.filter((a) => isPositionStale(a.lastSeen, Date.now())).length;
  const offlineCount = state.assets.filter((a) => a.status === 'offline').length;
  const returningCount = state.assets.filter((a) => a.status === 'returning').length;

  const restoreAsset = (assetId: string) => {
    const hasQueue = state.pendingReports.some((r) => r.assetId === assetId && r.status === 'queued');
    if (hasQueue) state.reconnectAndMerge([assetId]);
    else state.setAssetStatus(assetId, 'ready');
  };

  return (
    <main className={state.lowBandwidth ? 'low-bandwidth' : ''}>
      <Stack p="xl" gap="lg" maw={1600} mx="auto">
        <Group justify="space-between" align="flex-end">
          <div><Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线缓存模式' : '联合指挥在线'}</Badge><Title order={1} className="section-title">海上搜救联合指挥</Title><Text c="dimmed">搜索区、力量与任务在同一时间线上协同</Text></div>
          <Group><Switch label="低带宽" checked={state.lowBandwidth} onChange={state.toggleBandwidth} /><Switch label="模拟离线" checked={state.offline} onChange={state.toggleOffline} /></Group>
        </Group>

        <SimpleGrid cols={{ base: 1, md: 4 }}>
          {[
            ['失联 / 归队待重算', `${offlineCount} / ${returningCount}`],
            ['位置过期需重算', staleCount],
            ['失联积累待合并', pendingCount],
            ['冲突待定夺', openConflicts]
          ].map(([label, value]) => (
            <Card key={String(label)} withBorder>
              <Text size="sm" c="dimmed">{label}</Text>
              <Title order={2} c={label === '冲突待定夺' && value !== 0 ? 'orange' : undefined}>{value}</Title>
            </Card>
          ))}
        </SimpleGrid>

        {state.lowBandwidth && (
          <Card withBorder bg="yellow.0">
            <Text size="sm" fw={600}>低带宽模式：地图与明细已关闭，仅保留合并摘要、在岗情况与冲突定夺。</Text>
          </Card>
        )}

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            {!state.lowBandwidth && (
              <Card withBorder>
                <Group justify="space-between"><Title order={3}>搜救态势</Title><Text size="sm">风况：{brief.data?.wind ?? '读取中'} · 能见度：{brief.data?.visibility ?? '--'}</Text></Group>
                <SearchMap areas={state.areas} assets={state.assets} />
              </Card>
            )}
            {state.lowBandwidth && (
              <Card withBorder h="100%">
                <Title order={3}>搜索区摘要</Title>
                <List mt="md" spacing="xs">
                  {state.areas.map((area) => (
                    <List.Item key={area.id}>{area.name} · {area.status} · 覆盖 {area.coverage}% · 来源 {area.coverageSources.length} 笔</List.Item>
                  ))}
                </List>
              </Card>
            )}
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Card withBorder h="100%">
              <Title order={3}>单位在岗情况</Title>
              <Stack mt="md">
                {state.assets.map((asset) => {
                  const stale = isPositionStale(asset.lastSeen, Date.now());
                  const meta = assetStatusMeta[asset.status] ?? { label: asset.status, color: 'gray' };
                  return (
                    <Card key={asset.id} withBorder padding="sm">
                      <Group justify="space-between">
                        <div>
                          <b>{asset.name}</b>
                          <Text component="span" size="xs" c="dimmed" ml={6}>{assetTypeLabel[asset.type]}</Text>
                        </div>
                        <Group gap={6}>
                          <PendingBadge reports={state.pendingReports} assetId={asset.id} />
                          <Badge color={meta.color}>{meta.label}</Badge>
                        </Group>
                      </Group>
                      <Text size="xs" c={stale || asset.status === 'returning' ? 'red' : 'dimmed'}>
                        {(stale || asset.status === 'returning') ? '位置已过期，按观测时间判定，需重算 · ' : ''}
                        观测于 {formatDistanceToNow(new Date(asset.lastSeen), { addSuffix: true, locale: zhCN })}
                      </Text>
                      <Group mt="xs">
                        <Button size="compact-xs" onClick={() => asset.status === 'offline' ? restoreAsset(asset.id) : state.setAssetStatus(asset.id, 'offline')}>
                          {asset.status === 'offline' ? '恢复在线并合并' : '标记失联'}
                        </Button>
                        {asset.status === 'returning' && (
                          <Button size="compact-xs" variant="light" color="orange" onClick={() => state.setAssetStatus(asset.id, 'ready')}>位置重算后确认在岗</Button>
                        )}
                      </Group>
                    </Card>
                  );
                })}
              </Stack>
            </Card>
          </Grid.Col>
        </Grid>

        <ReconnectPanel assets={state.assets} areas={state.areas} />
        <ConflictPanel assets={state.assets} areas={state.areas} />

        {!state.lowBandwidth && (
          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <Card withBorder>
                <Title order={3}>派发新任务</Title>
                <form onSubmit={handleSubmit(submitMission)}>
                  <Stack mt="md">
                    <TextInput label="任务名称" {...register('title')} error={errors.title?.message} />
                    <label>搜索区<select {...register('areaId')} style={{ width: '100%', padding: 8 }}>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
                    <label>调派单位（可多选）<select multiple value={selectedAssets} onChange={(event) => setSelectedAssets(Array.from(event.currentTarget.selectedOptions, (option) => option.value))} style={{ width: '100%', minHeight: 86 }}>{state.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
                    <label>优先级<select {...register('priority')} style={{ width: '100%', padding: 8 }}><option value="urgent">紧急</option><option value="normal">常规</option></select></label>
                    <Textarea label="任务说明" {...register('note')} />
                    <Button type="submit">派发任务</Button>
                  </Stack>
                </form>
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Card withBorder>
                <Title order={3}>任务与搜索区覆盖来源</Title>
                <Table mt="md">
                  <thead><tr><th>搜索区</th><th>状态</th><th style={{ width: '38%' }}>覆盖率</th><th>覆盖来源</th></tr></thead>
                  <tbody>
                    {state.areas.map((area) => (
                      <tr key={area.id}>
                        <td>{area.name}</td>
                        <td><Badge size="xs">{area.status}</Badge></td>
                        <td><Progress value={area.coverage} /> <Text size="xs" c="dimmed">{area.coverage}%</Text></td>
                        <td>
                          <List size="xs" spacing={2}>
                            {area.coverageSources.map((source) => (
                              <List.Item key={source.id}>
                                {nameOf(source.assetId)} {source.coverage}%
                                <Text component="span" c="dimmed"> · 观测 {new Date(source.observedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
                                {source.redirectedFromAreaId && <Badge size="xs" color="blue" ml={4}>任务改投，原报 {areaNameOf(source.redirectedFromAreaId)}</Badge>}
                              </List.Item>
                            ))}
                          </List>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <List mt="lg" spacing="sm">
                  {state.missions.map((mission) => (
                    <List.Item key={mission.id}>
                      <Group justify="space-between">
                        <div><b>{mission.title}</b><Text size="xs" c="dimmed">{areaNameOf(mission.areaId)} · {mission.assetIds.map(nameOf).join('、')} · 更新于 {new Date(mission.updatedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text></div>
                        <Group><Badge>{mission.status}</Badge><Button size="compact-xs" onClick={() => state.setMissionStatus(mission.id, mission.status === 'in_progress' ? 'closed' : 'in_progress')}>{mission.status === 'closed' ? '重开' : '推进'}</Button></Group>
                      </Group>
                    </List.Item>
                  ))}
                </List>
              </Card>
            </Grid.Col>
          </Grid>
        )}

        {!state.lowBandwidth && (
          <Card withBorder>
            <Title order={3}>联合事件时间线</Title>
            <Timeline mt="lg" active={1} bulletSize={18} lineWidth={2}>
              {state.events.slice(0, 12).map((event) => (
                <Timeline.Item key={event.id} title={`${event.actor} · ${new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false })}`}>
                  <Text size="sm">{event.message}</Text>
                </Timeline.Item>
              ))}
            </Timeline>
          </Card>
        )}
      </Stack>
    </main>
  );
}
