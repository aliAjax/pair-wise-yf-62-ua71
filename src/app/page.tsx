'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Grid, Group, List, Progress, Select, SimpleGrid, Stack, Switch, Table, Text, Textarea, TextInput, ThemeIcon, Timeline, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useEffect, useState } from 'react';
import { useCommandStore, STALE_MS } from '@/lib/store';
import { SearchMap } from '@/components/SearchMap';
import { MergePanel } from '@/components/MergePanel';

const missionSchema = z.object({
  title: z.string().min(3, '任务名称至少3个字'),
  areaId: z.string().min(1),
  assetIds: z.array(z.string()).min(1, '至少调派一个单位'),
  priority: z.enum(['normal', 'urgent']),
  note: z.string().max(160)
});

export default function CommandPage() {
  const state = useCommandStore();
  const [selectedAssets, setSelectedAssets] = useState<string[]>(['ship-01']);
  const { register, handleSubmit, reset, setValue, formState: { errors } } = useForm<z.infer<typeof missionSchema>>({
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

  // 离线期间自动积累位置观测与覆盖记录
  useEffect(() => {
    if (!state.offline) return;
    const timer = setInterval(() => state.accumulateOfflineRecords(), 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.offline]);

  const pendingMerge = state.observations.filter((o) => !o.merged).length + state.coverageReports.filter((r) => !r.merged).length;
  const pendingConflicts = state.conflicts.filter((c) => c.status === 'pending').length;

  return (
    <main className={state.lowBandwidth ? 'low-bandwidth' : ''}>
      <Stack p="xl" gap="lg" maw={1600} mx="auto">
        <Group justify="space-between" align="flex-end">
          <div><Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线缓存模式' : '联合指挥在线'}</Badge><Title order={1} className="section-title">海上搜救联合指挥</Title><Text c="dimmed">搜索区、力量与任务在同一时间线上协同</Text></div>
          <Group><Switch label="低带宽" checked={state.lowBandwidth} onChange={state.toggleBandwidth} /><Switch label="模拟离线" checked={state.offline} onChange={state.toggleOffline} /></Group>
        </Group>

        <SimpleGrid cols={{ base: 2, md: 5 }}>
          {[
            ['活动搜索区', state.areas.filter((item) => item.status === 'active').length],
            ['在岗单位', state.assets.filter((item) => item.status !== 'offline' && state.missions.some((m) => m.assetIds.includes(item.id) && m.status !== 'closed')).length],
            ['在线单位', state.assets.filter((item) => item.status !== 'offline').length],
            ['进行中任务', state.missions.filter((item) => item.status === 'in_progress').length],
            ['过期位置', state.assets.filter((item) => Date.now() - new Date(item.lastSeen).getTime() > STALE_MS).length],
            ['待合并记录', pendingMerge],
            ['待决冲突', pendingConflicts]
          ].map(([label, value]) => <Card key={String(label)} withBorder><Text size="sm" c="dimmed">{label}</Text><Title order={2}>{value}</Title></Card>)}
        </SimpleGrid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}><Card withBorder><Group justify="space-between"><Title order={3}>搜救态势</Title><Text size="sm">风况：{brief.data?.wind ?? '读取中'} · 能见度：{brief.data?.visibility ?? '--'}</Text></Group><SearchMap areas={state.areas} assets={state.assets} /></Card></Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}><Card withBorder h="100%"><Title order={3}>单位在岗状态</Title><Stack mt="md">{state.assets.map((asset) => {
            const stale = Date.now() - new Date(asset.lastSeen).getTime() > STALE_MS;
            const onMission = state.missions.some((m) => m.assetIds.includes(asset.id) && m.status !== 'closed');
            const dutyLabel = asset.status === 'offline' ? '失联' : onMission ? '在岗 · 任务中' : '在岗 · 待命';
            const dutyColor = asset.status === 'offline' ? 'red' : onMission ? 'blue' : 'teal';
            const pendingCount = state.observations.filter((o) => o.assetId === asset.id && !o.merged).length + state.coverageReports.filter((r) => r.assetId === asset.id && !r.merged).length;
            return <Card key={asset.id} withBorder padding="sm"><Group justify="space-between"><b>{asset.name}</b><Group gap={4}><Badge size="xs" color={dutyColor}>{dutyLabel}</Badge><Badge color={asset.status === 'offline' ? 'red' : asset.status === 'assigned' ? 'blue' : 'teal'}>{asset.status}</Badge></Group></Group><Text size="xs" c={stale ? 'red' : 'dimmed'}>{stale ? '位置已过期 · ' : ''}观测于 {formatDistanceToNow(new Date(asset.lastSeen), { addSuffix: true, locale: zhCN })}{pendingCount > 0 ? ` · 待合并 ${pendingCount}` : ''}</Text><Group mt="xs"><Button size="compact-xs" onClick={() => state.setAssetStatus(asset.id, asset.status === 'offline' ? 'ready' : 'offline')}>{asset.status === 'offline' ? '恢复在线' : '标记失联'}</Button></Group></Card>;
          })}</Stack></Card></Grid.Col>
        </Grid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 5 }}><Card withBorder><Title order={3}>派发新任务</Title><form onSubmit={handleSubmit(submitMission)}><Stack mt="md"><TextInput label="任务名称" {...register('title')} error={errors.title?.message} /><label>搜索区<select {...register('areaId')} style={{ width: '100%', padding: 8 }}>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><label>调派单位（可多选）<select multiple value={selectedAssets} onChange={(event) => setSelectedAssets(Array.from(event.currentTarget.selectedOptions, (option) => option.value))} style={{ width: '100%', minHeight: 86 }}>{state.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label>优先级<select {...register('priority')} style={{ width: '100%', padding: 8 }}><option value="urgent">紧急</option><option value="normal">常规</option></select></label><Textarea label="任务说明" {...register('note')} /><Button type="submit">派发任务</Button></Stack></form></Card></Grid.Col>
          <Grid.Col span={{ base: 12, lg: 7 }}><Card withBorder><Title order={3}>任务与搜索区</Title><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th align="left">搜索区</th><th align="left">状态</th><th align="left">覆盖率</th></tr></thead><tbody>{state.areas.map((area) => <tr key={area.id}><td style={{ padding: '8px 0' }}>{area.name}</td><td>{area.status}</td><td style={{ width: '42%' }}><Progress value={area.coverage} /></td></tr>)}</tbody></table><List mt="lg" spacing="sm">{state.missions.map((mission) => <List.Item key={mission.id}><Group justify="space-between"><div><b>{mission.title}</b><Text size="xs" c="dimmed">{mission.areaId} · {mission.assetIds.join(' / ')}</Text></div><Group><Badge>{mission.status}</Badge><Button size="compact-xs" onClick={() => state.setMissionStatus(mission.id, mission.status === 'in_progress' ? 'closed' : 'in_progress')}>{mission.status === 'closed' ? '重开' : '推进'}</Button></Group></Group></List.Item>)}</List></Card></Grid.Col>
        </Grid>

        <Card withBorder><Title order={3}>联合事件时间线</Title><Timeline mt="lg" active={1} bulletSize={18} lineWidth={2}>{state.events.slice(0, 10).map((event) => <Timeline.Item key={event.id} title={`${event.actor} · ${new Date(event.time).toLocaleTimeString()}`}><Text size="sm">{event.message}</Text></Timeline.Item>)}</Timeline></Card>

        <MergePanel />
      </Stack>
    </main>
  );
}
