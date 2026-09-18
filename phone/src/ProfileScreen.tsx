// My profile — see the wearer's profile and change it, to show how a change
// in the profile changes what the guide does.
//
// The server owns everything: GET /webview/profile is the profile as rows
// with their controls, POST /webview/profile {key, value} saves one need
// (null removes it), POST /webview/profile/reset puts the default profile
// back. Every answer is the fresh profile, and the screen re-renders from it —
// nothing is guessed on the phone. `effect` is what the guide will do with
// the profile in toolkit mode, straight from the surface.

import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ProfileNeedView, ProfileView } from '../../src/transport/phone-protocol.ts';
import { Button, Card, Segmented } from './components';
import { radius, space, type, usePalette } from './theme';
import { SERVER_URL } from './useGuideLink';

const PROFILE_URL = `${SERVER_URL}/webview/profile`;

async function call(path: string, body?: unknown): Promise<ProfileView> {
  const res = await fetch(`${PROFILE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ProfileView & { error?: string };
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

export function ProfileScreen(props: { open: boolean; onClose: () => void }) {
  const c = usePalette();
  const [view, setView] = useState<ProfileView | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (path: string, body?: unknown): Promise<void> => {
    setBusy(true);
    setProblem('');
    try {
      setView(await call(path, body));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (props.open) void run('');
  }, [props.open, run]);

  const save = (key: string, value: unknown): void => void run('', { key, value });
  const remove = (n: ProfileNeedView): void =>
    Alert.alert(`Remove “${n.label}”?`, 'The guide goes back to its default for this.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => save(n.key, null) },
    ]);
  const reset = (): void =>
    Alert.alert('Reset the profile?', 'Puts back the default profile.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: () => void run('/reset', {}) },
    ]);

  return (
    <Modal visible={props.open} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <SafeAreaView style={[s.root, { backgroundColor: c.bg }]}>
        <View style={s.header}>
          <Text style={[s.title, { color: c.text }]} accessibilityRole="header">My profile</Text>
          <Button label="Done" kind="quiet" size="small" onPress={props.onClose} />
        </View>
        <ScrollView contentContainerStyle={s.scroll}>
          {problem ? (
            <View style={[s.notice, { backgroundColor: c.dangerSoft, borderColor: c.danger }]} accessibilityRole="alert">
              <Text style={[s.noticeText, { color: c.text }]}>! {problem}</Text>
              <Button label="Try again" kind="quiet" size="small" onPress={() => void run('')} />
            </View>
          ) : null}

          {view ? (
            <>
              <Card title="What the guide will do">
                {(view.effect ?? ['(the server needs updating to show this)']).map((line) => (
                  <Text key={line} style={[s.effect, { color: c.text }]}>• {line}</Text>
                ))}
                <Text style={[s.effect, { color: c.textMuted }]}>• Speaks to you as an adult — always</Text>
                <Text style={[s.help, { color: view.profileOn ? c.ok : c.textMuted }]}>
                  {view.profileOn ? 'In use now.' : view.mode === 'toolkit' ? 'Used when the guide starts in Toolkit mode.' : 'Used in Toolkit mode. Baseline ignores the profile.'}
                </Text>
              </Card>

              <Card title="Abilities">
                {view.needs.map((n, i) => (
                  <View key={n.key} style={[s.need, i > 0 ? { borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth } : null]}>
                    <View style={s.needTop}>
                      <Text style={[s.needLabel, { color: c.text }]}>{n.label}</Text>
                      <Button label="Remove" kind="quiet" size="small" onPress={() => remove(n)} disabled={busy} />
                    </View>
                    <NeedControl need={n} disabled={busy} onChange={(v) => save(n.key, v)} />
                    <Text style={[s.help, { color: c.textMuted }]}>{n.help}</Text>
                  </View>
                ))}
                {view.needs.length === 0 ? <Text style={[s.help, { color: c.textMuted }]}>Nothing set — the guide uses its defaults.</Text> : null}
              </Card>

              {view.available.length ? (
                <Card title="Add">
                  {view.available.map((a) => (
                    <Button key={a.key} label={a.label} kind="secondary" onPress={() => save(a.key, a.default)} disabled={busy} hint={a.help} />
                  ))}
                  <Text style={[s.help, { color: c.textMuted }]}>Adding starts at the usual setting.</Text>
                </Card>
              ) : null}

              <Button label="Reset to default" kind="quiet" onPress={reset} disabled={busy} />
            </>
          ) : !problem ? (
            <Text style={[s.help, { color: c.textMuted }]}>Loading…</Text>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// One control per kind of need. The server says which kind; the phone only draws it.
function NeedControl(props: { need: ProfileNeedView; disabled: boolean; onChange: (v: unknown) => void }) {
  const c = usePalette();
  const n = props.need;
  if (n.kind === 'toggle') {
    return (
      <Segmented
        label={n.label}
        value={n.value ? 'on' : 'off'}
        disabled={props.disabled}
        onChange={(v) => props.onChange(v === 'on')}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ]}
      />
    );
  }
  if (n.kind === 'choice' && n.options) {
    return <Segmented label={n.label} value={String(n.value)} disabled={props.disabled} onChange={props.onChange} options={n.options} />;
  }
  if (n.kind === 'range') {
    const value = typeof n.value === 'number' ? n.value : 1;
    const step = n.step ?? 0.1;
    const min = n.min ?? 0;
    const max = n.max ?? 10;
    const at = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
    return (
      <View style={s.range} accessible accessibilityLabel={`${n.label}: ${value}${n.unit ?? ''}`}>
        <Button label="−" kind="secondary" onPress={() => props.onChange(at(value - step))} disabled={props.disabled || value <= min} hint="Lower" />
        <Text style={[s.rangeValue, { color: c.text }]}>{value}{n.unit ?? ''}</Text>
        <Button label="+" kind="secondary" onPress={() => props.onChange(at(value + step))} disabled={props.disabled || value >= max} hint="Higher" />
      </View>
    );
  }
  return <Text style={[s.help, { color: c.text }]}>{String(n.value)}</Text>;
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { fontSize: type.title, fontWeight: '800' },
  scroll: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  notice: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.xs },
  noticeText: { fontSize: type.body, lineHeight: 22 },
  effect: { fontSize: type.lead, lineHeight: 26 },
  help: { fontSize: type.caption + 1, lineHeight: 20 },
  need: { gap: space.sm, paddingTop: space.md },
  needTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  needLabel: { fontSize: type.body, fontWeight: '700' },
  range: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rangeValue: { flex: 1, textAlign: 'center', fontSize: type.title, fontWeight: '700' },
});
