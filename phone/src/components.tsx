// The handful of building blocks the screen is made of. Each one carries its
// own accessibility role, label and state, so the screen reads correctly with
// VoiceOver / TalkBack without the screen having to think about it.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, space, touch, type, usePalette } from './theme';

export type Tone = 'ok' | 'busy' | 'warn' | 'danger' | 'idle';

// ✓ ! … — the glyph says the state; the color only reinforces it.
const GLYPH: Record<Tone, string> = { ok: '✓', busy: '…', warn: '!', danger: '!', idle: '–' };
const TONE_WORD: Record<Tone, string> = { ok: 'OK', busy: 'In progress', warn: 'Needs attention', danger: 'Problem', idle: 'Not started' };

export function Card(props: { children: ReactNode; title?: string }) {
  const c = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      {props.title ? (
        <Text style={[styles.cardTitle, { color: c.textMuted }]} accessibilityRole="header">
          {props.title}
        </Text>
      ) : null}
      {props.children}
    </View>
  );
}

// One prerequisite: what it is, how it's doing, and the single thing to do about it.
export function StatusRow(props: {
  tone: Tone;
  title: string;
  detail: string;
  action?: { label: string; onPress: () => void; disabled?: boolean };
  children?: ReactNode;
}) {
  const c = usePalette();
  const fg = props.tone === 'ok' ? c.ok : props.tone === 'danger' ? c.danger : props.tone === 'warn' ? c.warn : c.textMuted;
  const bg = props.tone === 'ok' ? c.okSoft : props.tone === 'danger' ? c.dangerSoft : props.tone === 'warn' ? c.warnSoft : c.surfaceAlt;
  return (
    <View style={styles.statusRow}>
      <View style={styles.statusTop}>
        <View style={[styles.badge, { backgroundColor: bg }]} accessible={false} importantForAccessibility="no">
          <Text style={[styles.badgeGlyph, { color: fg }]}>{GLYPH[props.tone]}</Text>
        </View>
        <View style={styles.statusText} accessible accessibilityLabel={`${props.title}. ${TONE_WORD[props.tone]}. ${props.detail}`}>
          <Text style={[styles.rowTitle, { color: c.text }]}>{props.title}</Text>
          <Text style={[styles.rowDetail, { color: c.textMuted }]}>{props.detail}</Text>
        </View>
        {props.action ? <Button label={props.action.label} onPress={props.action.onPress} disabled={props.action.disabled} size="small" /> : null}
      </View>
      {props.children ? <View style={styles.statusChildren}>{props.children}</View> : null}
    </View>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'quiet';
  size?: 'small' | 'large';
  flex?: boolean;
  hint?: string;
}) {
  const c = usePalette();
  const kind = props.kind ?? 'primary';
  const bg = kind === 'primary' ? c.accent : kind === 'secondary' ? c.surfaceAlt : 'transparent';
  const fg = kind === 'primary' ? c.onAccent : kind === 'secondary' ? c.text : c.accent;
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.hint}
      accessibilityState={{ disabled: !!props.disabled }}
      hitSlop={props.size === 'small' ? 8 : 0}
      style={({ pressed }) => [
        styles.button,
        props.size === 'small' ? styles.buttonSmall : null,
        props.size === 'large' ? styles.buttonLarge : null,
        props.flex ? styles.flex : null,
        { backgroundColor: bg, borderColor: kind === 'secondary' ? c.border : 'transparent' },
        pressed ? styles.pressed : null,
        props.disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, props.size === 'large' ? styles.buttonTextLarge : null, { color: fg }]}>{props.label}</Text>
    </Pressable>
  );
}

// A card that stays folded until its title is pressed. What is inside is not
// mounted while it is folded, so a picture in there costs nothing unseen.
export function Disclosure(props: { title: string; summary?: string; children: ReactNode }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={props.summary ? `${props.title}. ${props.summary}` : props.title}
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        style={({ pressed }) => [styles.disclosureHead, pressed ? styles.pressed : null]}
      >
        <Text style={[styles.cardTitle, { color: c.textMuted }]}>{props.title}</Text>
        {props.summary && !open ? (
          <Text style={[styles.disclosureSummary, { color: c.textMuted }]} numberOfLines={1}>
            {props.summary}
          </Text>
        ) : (
          <View style={styles.flex} />
        )}
        <Text style={[styles.disclosureGlyph, { color: c.textMuted }]}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? props.children : null}
    </View>
  );
}

// A choice between two or three options. Behaves as a radio group for assistive tech.
export function Segmented<T extends string>(props: {
  label: string;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const c = usePalette();
  return (
    <View
      style={[styles.segmented, { backgroundColor: c.surfaceAlt, borderColor: c.border }, props.disabled ? styles.disabled : null]}
      accessibilityRole="radiogroup"
      accessibilityLabel={props.label}
    >
      {props.options.map((o) => {
        const selected = props.value === o.value;
        return (
          <Pressable
            key={o.value}
            disabled={props.disabled}
            onPress={() => !selected && props.onChange(o.value)}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected, disabled: !!props.disabled }}
            style={[styles.segment, selected ? { backgroundColor: c.accent } : null]}
          >
            <Text style={[styles.segmentText, { color: selected ? c.onAccent : c.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
              {selected ? '✓ ' : ''}
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// A softly pulsing dot for "something is happening". Holds still when the
// person has asked their phone to reduce motion.
export function Pulse(props: { color: string; active: boolean }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled || reduce || !props.active) return v.setValue(1);
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [props.active, v]);
  return <Animated.View style={[styles.pulse, { backgroundColor: props.color, opacity: v }]} accessible={false} importantForAccessibility="no" />;
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.md },
  cardTitle: { fontSize: type.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  statusRow: { gap: space.sm },
  statusTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  statusText: { flex: 1, gap: 2 },
  statusChildren: { marginLeft: 36 + space.md, gap: space.sm },
  badge: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  badgeGlyph: { fontSize: 18, fontWeight: '800' },
  rowTitle: { fontSize: type.body, fontWeight: '600' },
  rowDetail: { fontSize: type.caption + 1, lineHeight: 19 },
  button: { minHeight: touch, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.lg, alignItems: 'center', justifyContent: 'center' },
  buttonSmall: { minHeight: 44, paddingHorizontal: space.md },
  buttonLarge: { minHeight: 64 },
  buttonText: { fontSize: type.body, fontWeight: '600' },
  buttonTextLarge: { fontSize: type.lead, fontWeight: '700' },
  segmented: { flexDirection: 'row', borderRadius: radius.md, borderWidth: 1, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xs },
  segmentText: { fontSize: type.body, fontWeight: '600' },
  disclosureHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 },
  disclosureSummary: { flex: 1, fontSize: type.caption, textAlign: 'right' },
  disclosureGlyph: { fontSize: type.lead },
  pulse: { width: 12, height: 12, borderRadius: radius.pill },
  flex: { flex: 1 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
});
