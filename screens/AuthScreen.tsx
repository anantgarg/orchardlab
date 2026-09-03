import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../lib/supabase';

// Supabase requires E.164 phone numbers: "+" followed by 8–15 digits.
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

export default function AuthScreen() {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanPhone = phone.replace(/[\s().-]/g, '');

  async function sendCode() {
    setError(null);
    if (!PHONE_RE.test(cleanPhone)) {
      setError('Enter your number with the country code, e.g. +14155551234');
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithOtp({ phone: cleanPhone });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setCode('');
    setStep('code');
  }

  async function verifyCode() {
    setError(null);
    const token = code.trim();
    if (token.length < 4) {
      setError('Enter the code from the text message.');
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.verifyOtp({ phone: cleanPhone, token, type: 'sms' });
    setBusy(false);
    if (err) setError(err.message);
    // On success App.tsx receives SIGNED_IN from onAuthStateChange and leaves this screen.
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <Text style={styles.title}>Recipe Recorder</Text>

        {step === 'phone' ? (
          <>
            <Text style={styles.label}>Sign in with your phone number</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="+14155551234"
              placeholderTextColor="#999"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              autoFocus
              editable={!busy}
              onSubmitEditing={sendCode}
            />
            <Button label="Send code" onPress={sendCode} busy={busy} />
          </>
        ) : (
          <>
            <Text style={styles.label}>Enter the code sent to {cleanPhone}</Text>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              placeholderTextColor="#999"
              keyboardType="number-pad"
              autoComplete="sms-otp"
              textContentType="oneTimeCode"
              maxLength={8}
              autoFocus
              editable={!busy}
              onSubmitEditing={verifyCode}
            />
            <Button label="Verify" onPress={verifyCode} busy={busy} />
            <Pressable
              onPress={() => {
                setStep('phone');
                setError(null);
              }}
              disabled={busy}
              hitSlop={8}
            >
              <Text style={styles.link}>Use a different number</Text>
            </Pressable>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Button({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonDim]}
      onPress={onPress}
      disabled={busy}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '700', color: '#111', marginBottom: 16 },
  label: { fontSize: 16, color: '#444' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 20,
    color: '#111',
  },
  button: {
    backgroundColor: '#e8590c',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDim: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  link: { color: '#e8590c', fontSize: 15, textAlign: 'center', paddingVertical: 8 },
  error: { color: '#c92a2a', fontSize: 15 },
});
