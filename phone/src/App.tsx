// Wearable Task Guide — phone app. One screen, two jobs:
//
//   Get ready   three things must be true before a take — the guide server is
//               reachable, the glasses are connected, the glasses are on Wi-Fi.
//               Each is one row that says how it's doing and offers the single
//               thing to do about it. Once all three are fine the section folds
//               away, because it has nothing left to say.
//   Guide       one big switch, what the guide is doing right now (listening,
//               thinking, speaking), what it heard and what it said.
//
// Everything clever happens on the server; see useGuideLink.ts.

import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { File, Paths } from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import BluetoothSdk, { DeviceModels, type Device } from '@mentra/bluetooth-sdk';
import { useMentraBluetooth } from '@mentra/bluetooth-sdk/react';
import type { GuideModeWire, GuidePhase, PanelState } from '../../src/transport/phone-protocol.ts';
import { Button, Card, Pulse, Segmented, StatusRow, type Tone } from './components';
import { ProfileScreen } from './ProfileScreen';
import { radius, space, type, usePalette } from './theme';
import { useGuideLink } from './useGuideLink';

// Remember the glasses across launches so the app reconnects on its own.
const DEVICE_FILE = 'default-glasses.json';
const defaultDeviceStorage = {
  load: async (): Promise<Device | null> => {
    const file = new File(Paths.document, DEVICE_FILE);
    if (!file.exists) return null;
    try {
      return JSON.parse(await file.text()) as Device;
    } catch {
      return null;
    }
  },
  save: async (device: Device | null): Promise<void> => {
    const file = new File(Paths.document, DEVICE_FILE);
    if (!device) {
      if (file.exists) file.delete();
      return;
    }
    file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(device));
  },
};

async function ensureAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const wanted = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  ];
  const results = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => results[p] === PermissionsAndroid.RESULTS.GRANTED);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// UI work without glasses: build with EXPO_PUBLIC_PREVIEW=live to see the
// running screen filled with a stand-in session. Never set in a real build.
const PREVIEW: PanelState | null =
  process.env.EXPO_PUBLIC_PREVIEW === 'live'
    ? {
        active: true,
        mode: 'toolkit',
        phase: 'listening',
        heard: 'help me start the washing machine',
        lastLine: 'Step one. Open the detergent drawer at the top left of the machine.',
        status: 'Ready — Wearable Task Guide listening',
        geminiOff: null,
      }
    : null;

const PHASE_TEXT: Record<GuidePhase, string> = {
  idle: '',
  listening: 'Listening — speak when you’re ready',
  thinking: 'Thinking…',
  speaking: 'Speaking — it listens again when it finishes',
};

const MODE_TEXT: Record<GuideModeWire, string> = {
  baseline: 'The default guide.',
  toolkit: 'Adapted to the wearer’s profile.',
};

export default function App() {
  useKeepAwake();
  const c = usePalette();
  const scheme = useColorScheme();

  const [problem, setProblem] = useState('');
  const mentra = useMentraBluetooth({
    autoConnectDefault: true,
    defaultDeviceStorage,
    defaultModel: DeviceModels.MentraLive,
    scanTimeoutMs: 10_000,
    onError: (e) => setProblem(errorText(e)),
  });

  const glasses = mentra.glasses;
  const connected = glasses.connected || !!PREVIEW;
  const wifi = PREVIEW ? ({ state: 'connected', ssid: 'Home Wi-Fi' } as const) : glasses.connected ? glasses.wifi : null;
  const wifiOn = wifi ? wifi.state === 'connected' : null;
  const link = useGuideLink({ connected: glasses.connected, wifi: PREVIEW ? null : wifiOn });
  const panel = PREVIEW ?? link.panel;
  const active = !!panel?.active;
  const phase: GuidePhase = panel?.phase ?? 'idle';

  const serverOk = link.server === 'connected';
  const ready = serverOk && connected && wifiOn === true;

  // ── Get ready ─────────────────────────────────────────────────────────────
  const [setupOpen, setSetupOpen] = useState(false);
  const [wifiFormOpen, setWifiFormOpen] = useState(false);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [joining, setJoining] = useState(false);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (wifiOn) setWifiFormOpen(false);
  }, [wifiOn]);

  const scan = async (): Promise<void> => {
    setProblem('');
    if (!(await ensureAndroidPermissions())) return setProblem('Allow Bluetooth and the microphone to find your glasses.');
    try {
      await mentra.scan.start();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setScanned(true);
    }
  };
  const connect = async (device: Device): Promise<void> => {
    setProblem('');
    try {
      await mentra.connect(device);
      await mentra.setDefaultDevice(device);
    } catch (e) {
      setProblem(`Couldn’t connect to ${device.name}. ${errorText(e)}`);
    }
  };
  const forget = (): void =>
    Alert.alert('Disconnect the glasses?', 'The guide stops, and this phone won’t reconnect to them on its own.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          if (active) link.setActive(false);
          void mentra.disconnect().then(() => mentra.clearDefaultDevice()).catch((e) => setProblem(errorText(e)));
        },
      },
    ]);
  const joinWifi = async (): Promise<void> => {
    setProblem('');
    setJoining(true);
    try {
      const result = await BluetoothSdk.sendWifiCredentials(ssid.trim(), password);
      if (result.state === 'connected') setPassword('');
      else setProblem(result.error === 'wrong_password' ? 'That password didn’t work.' : `The glasses couldn’t join “${ssid.trim()}”.`);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setJoining(false);
    }
  };

  const server: { tone: Tone; detail: string } =
    link.server === 'connected' ? { tone: 'ok', detail: 'Connected' }
    : link.server === 'refused' ? { tone: 'danger', detail: `This app’s access code was refused (${link.serverDetail}). It needs rebuilding with the right one.` }
    : link.server === 'offline' ? { tone: 'warn', detail: `Can’t reach it${link.serverDetail ? ` — ${link.serverDetail}` : ''}. Check this phone’s internet; retrying…` }
    : { tone: 'busy', detail: 'Connecting…' };

  const linkState = glasses.connected ? 'connected' : glasses.connection.state;
  const glassesRow: { tone: Tone; detail: string } =
    connected ? { tone: 'ok', detail: `Connected${glasses.connected && glasses.battery.level != null ? ` · battery ${glasses.battery.level}%` : ''}` }
    : linkState !== 'disconnected' ? { tone: 'busy', detail: linkState === 'scanning' ? 'Looking for glasses nearby…' : 'Connecting…' }
    : mentra.defaultDevice ? { tone: 'warn', detail: `Not connected to ${mentra.defaultDevice.name}. Are they on and nearby?` }
    : { tone: 'warn', detail: 'Not connected. Turn the glasses on, then scan.' };

  const wifiRow: { tone: Tone; detail: string } =
    !connected ? { tone: 'idle', detail: 'Connect the glasses first.' }
    : wifi?.state === 'connected' ? { tone: 'ok', detail: `On “${wifi.ssid}”` }
    : { tone: 'warn', detail: 'Not on Wi-Fi. The camera sends video over it.' };

  // ── Guide ─────────────────────────────────────────────────────────────────
  const [typed, setTyped] = useState('');
  const [typeOpen, setTypeOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const blockedBy =
    !serverOk ? 'Waiting for the guide server.'
    : !connected ? 'Connect the glasses to begin.'
    : null;

  const changeMode = (mode: GuideModeWire): void => {
    if (!active) return link.setMode(mode);
    // A take runs in one mode from start to finish, so this can't be silent.
    Alert.alert('Pause the guide to switch?', 'Switching stops the current task. Press Start again to begin in the new mode.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'Pause and switch',
        onPress: () => {
          link.setActive(false);
          link.setMode(mode);
        },
      },
    ]);
  };

  const headline = active ? 'Live' : ready ? 'Ready' : 'Getting ready';
  const headlineTone = active ? c.stop : ready ? c.ok : c.warn;
  const showSetup = !ready || setupOpen;

  const setupCard = (
    <Card title="Get ready">
      {!showSetup ? (
        <StatusRow tone="ok" title="Everything’s connected" detail="Server, glasses and Wi-Fi" action={{ label: 'Details', onPress: () => setSetupOpen(true) }} />
      ) : (
        <>
          <StatusRow tone={server.tone} title="Guide server" detail={server.detail} />
          <Divider />
          <StatusRow
            tone={glassesRow.tone}
            title="Glasses"
            detail={glassesRow.detail}
            action={
              connected ? { label: 'Disconnect', onPress: forget }
              : linkState === 'disconnected' ? { label: scanned ? 'Scan again' : 'Scan', onPress: () => void scan(), disabled: mentra.busy }
              : undefined
            }
          >
            {!connected &&
              mentra.scan.devices.map((d) => (
                <Button key={d.id} label={`Connect to ${d.name}`} onPress={() => void connect(d)} disabled={mentra.busy} kind="secondary" />
              ))}
            {!connected && scanned && !mentra.scan.active && mentra.scan.devices.length === 0 ? (
              <Text style={[s.help, { color: c.textMuted }]}>
                None found. Check they’re switched on, and that the Mentra app isn’t holding the connection — close it and scan again.
              </Text>
            ) : null}
            {connected && Platform.OS === 'ios' ? (
              <Text style={[s.help, { color: c.textMuted }]}>
                To hear the guide in the glasses, also pick them in Settings › Bluetooth. iPhone doesn’t let an app do that for you.
              </Text>
            ) : null}
          </StatusRow>
          <Divider />
          <StatusRow
            tone={wifiRow.tone}
            title="Glasses Wi-Fi"
            detail={wifiRow.detail}
            action={connected && !wifiOn && !wifiFormOpen ? { label: 'Set up', onPress: () => setWifiFormOpen(true) } : undefined}
          >
            {connected && !wifiOn && wifiFormOpen ? (
              <>
                <Field label="Network name" value={ssid} onChangeText={setSsid} />
                <Field
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secure={!showPassword}
                  trailing={{ label: showPassword ? 'Hide' : 'Show', onPress: () => setShowPassword((v) => !v) }}
                />
                <Button label={joining ? 'Joining…' : 'Join network'} onPress={() => void joinWifi()} disabled={!ssid.trim() || joining} />
                <Text style={[s.help, { color: c.textMuted }]}>Any network with internet works, including this phone’s hotspot.</Text>
              </>
            ) : null}
          </StatusRow>
          {problem ? <Notice text={problem} onDismiss={() => setProblem('')} /> : null}
          {ready ? <Button label="Hide details" kind="quiet" onPress={() => setSetupOpen(false)} /> : null}
        </>
      )}
    </Card>
  );

  const modePicker = (
    <View style={s.modeBlock}>
      <Segmented
        label="Guide mode"
        value={panel?.mode ?? null}
        disabled={!panel}
        onChange={changeMode}
        options={[
          { value: 'baseline', label: 'Baseline' },
          { value: 'toolkit', label: 'Toolkit' },
        ]}
      />
      {panel ? <Text style={[s.help, { color: c.textMuted }]}>{MODE_TEXT[panel.mode]}</Text> : null}
      <Button label="My profile" kind="secondary" onPress={() => setProfileOpen(true)} disabled={!serverOk} hint="See and change the wearer’s profile" />
    </View>
  );

  const guideCard = (
    <Card title="Guide">
      <Pressable
        onPress={() => link.setActive(!active)}
        disabled={!!blockedBy && !active}
        accessibilityRole="switch"
        accessibilityLabel="Guide"
        accessibilityValue={{ text: active ? 'On' : 'Off' }}
        accessibilityHint={active ? 'Stops the guide, the camera and the microphone' : 'Starts the guide, the camera and the microphone'}
        accessibilityState={{ checked: active, disabled: !!blockedBy && !active }}
        style={({ pressed }) => [
          s.power,
          { backgroundColor: active ? c.stop : c.go },
          pressed ? s.pressed : null,
          blockedBy && !active ? s.disabled : null,
        ]}
      >
        <Text style={s.powerGlyph}>{active ? '■' : '▶'}</Text>
        <Text style={s.powerText}>{active ? 'Stop' : 'Start'}</Text>
      </Pressable>

      <View style={s.phaseRow} accessibilityLiveRegion="polite">
        {active ? <Pulse color={phase === 'listening' ? c.ok : c.accent} active={phase !== 'idle'} /> : null}
        <Text style={[s.phase, { color: panel?.geminiOff ? c.danger : c.text }]}>
          {panel?.geminiOff ? `The AI is switched off on the server: ${panel.geminiOff}`
            : !active ? blockedBy ?? (wifiOn ? 'Press Start, then just talk.' : 'You can start, but the guide can’t see until the glasses are on Wi-Fi.')
            : phase === 'listening' && panel?.status && !/^Ready/.test(panel.status) ? panel.status
            : PHASE_TEXT[phase]}
        </Text>
      </View>

      {/* Before a take the mode is part of getting going; during one it steps aside. */}
      {!active ? modePicker : null}

      {active ? (
        typeOpen ? (
          <View style={s.typeRow}>
            <View style={s.flex}>
              <Field label="Type a request" value={typed} onChangeText={setTyped} autoFocus onSubmit={() => { if (typed.trim()) { link.say(typed.trim()); setTyped(''); } }} />
            </View>
            <Button label="Send" disabled={!typed.trim()} onPress={() => { link.say(typed.trim()); setTyped(''); }} />
          </View>
        ) : (
          <Button label="Type instead of speaking" kind="quiet" onPress={() => setTypeOpen(true)} />
        )
      ) : null}
    </Card>
  );

  const conversation =
    panel && (panel.heard || panel.lastLine) ? (
      <Card title="Conversation">
        {panel.heard ? (
          <View style={s.turn}>
            <Text style={[s.who, { color: c.textMuted }]}>You said</Text>
            <Text style={[s.heard, { color: c.text }]}>“{panel.heard}”</Text>
          </View>
        ) : null}
        {panel.lastLine ? (
          <View style={s.turn}>
            <Text style={[s.who, { color: c.textMuted }]}>Guide</Text>
            <Text style={[s.speech, { color: c.text }]}>{panel.lastLine}</Text>
          </View>
        ) : null}
      </Card>
    ) : null;

  return (
    <SafeAreaView style={[s.root, { backgroundColor: c.bg }]}>
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.header}>
            <View style={s.flex}>
              <Text style={[s.subtitle, { color: c.textMuted }]}>A11Y toolkit application</Text>
              <Text style={[s.title, { color: c.text }]} accessibilityRole="header">Wearable Task Guide</Text>
            </View>
            <View style={[s.pill, { borderColor: headlineTone }]} accessible accessibilityLabel={`Status: ${headline}`}>
              <View style={[s.pillDot, { backgroundColor: headlineTone }]} />
              <Text style={[s.pillText, { color: c.text }]}>{headline}</Text>
            </View>
          </View>

          {/* Whatever needs the person's attention comes first. */}
          {ready ? (
            <>
              {guideCard}
              {conversation}
              {active ? <Card title="Mode">{modePicker}</Card> : null}
              {setupCard}
            </>
          ) : (
            <>
              {setupCard}
              {guideCard}
              {conversation}
              {active ? <Card title="Mode">{modePicker}</Card> : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <ProfileScreen open={profileOpen} onClose={() => setProfileOpen(false)} />
    </SafeAreaView>
  );
}

function Divider() {
  const c = usePalette();
  return <View style={[s.divider, { backgroundColor: c.border }]} />;
}

// A problem, in words, with a way to put it away. Announced to screen readers.
function Notice(props: { text: string; onDismiss: () => void }) {
  const c = usePalette();
  return (
    <View style={[s.notice, { backgroundColor: c.dangerSoft, borderColor: c.danger }]} accessibilityRole="alert">
      <Text style={[s.noticeText, { color: c.text }]}>! {props.text}</Text>
      <Button label="Dismiss" kind="quiet" size="small" onPress={props.onDismiss} />
    </View>
  );
}

// A text input with a label that stays visible (placeholders vanish as you type).
function Field(props: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  secure?: boolean;
  autoFocus?: boolean;
  onSubmit?: () => void;
  trailing?: { label: string; onPress: () => void };
}) {
  const c = usePalette();
  return (
    <View style={s.field}>
      <Text style={[s.fieldLabel, { color: c.textMuted }]}>{props.label}</Text>
      <View style={[s.inputWrap, { backgroundColor: c.bg, borderColor: c.border }]}>
        <TextInput
          style={[s.input, { color: c.text }]}
          value={props.value}
          onChangeText={props.onChangeText}
          secureTextEntry={props.secure}
          autoFocus={props.autoFocus}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType={props.onSubmit ? 'send' : 'done'}
          onSubmitEditing={props.onSubmit}
          accessibilityLabel={props.label}
        />
        {props.trailing ? <Button label={props.trailing.label} kind="quiet" size="small" onPress={props.trailing.onPress} /> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scroll: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm, gap: space.md },
  subtitle: { fontSize: type.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  title: { fontSize: type.title + 2, fontWeight: '800', flexShrink: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  pillDot: { width: 8, height: 8, borderRadius: radius.pill },
  pillText: { fontSize: type.caption + 1, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
  help: { fontSize: type.caption + 1, lineHeight: 20 },
  notice: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.xs },
  noticeText: { fontSize: type.body, lineHeight: 22 },
  power: { minHeight: 96, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.md },
  powerGlyph: { color: '#ffffff', fontSize: 26 },
  powerText: { color: '#ffffff', fontSize: type.display, fontWeight: '800' },
  phaseRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 24 },
  phase: { flex: 1, fontSize: type.lead, lineHeight: 25 },
  row: { flexDirection: 'row', gap: space.md },
  modeBlock: { gap: space.sm },
  typeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  turn: { gap: space.xs },
  who: { fontSize: type.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  heard: { fontSize: type.lead, lineHeight: 26, fontStyle: 'italic' },
  speech: { fontSize: type.speech, lineHeight: 31 },
  field: { gap: space.xs },
  fieldLabel: { fontSize: type.caption + 1, fontWeight: '600' },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.md, minHeight: 52, paddingLeft: space.md },
  input: { flex: 1, fontSize: type.body, paddingVertical: space.md },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
});
