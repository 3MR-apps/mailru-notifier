"""Генератор сигнала нового письма: два мягких тона (ми5 → си5), 0,6 с, моно 16 бит 44,1 кГц.
Звук синтезирован с нуля, без сторонних сэмплов."""
import math, struct, sys, wave

RATE = 44100
out = sys.argv[1]

def tone(freq, start, dur, amp):
    """Синус с обертонами и экспоненциальным затуханием, мягкая атака 8 мс."""
    samples = {}
    n0, n = int(start * RATE), int(dur * RATE)
    for i in range(n):
        t = i / RATE
        attack = min(1.0, t / 0.008)
        decay = math.exp(-t * 6.5)
        v = (math.sin(2 * math.pi * freq * t)
             + 0.35 * math.sin(2 * math.pi * freq * 2 * t)
             + 0.12 * math.sin(2 * math.pi * freq * 3 * t))
        samples[n0 + i] = amp * attack * decay * v / 1.47
    return samples

total = int(0.6 * RATE)
buf = [0.0] * total
for part in (tone(659.25, 0.0, 0.55, 0.42), tone(987.77, 0.11, 0.49, 0.38)):
    for k, v in part.items():
        if k < total:
            buf[k] += v

fade = int(0.02 * RATE)  # плавный конец без щелчка
for i in range(fade):
    buf[total - 1 - i] *= i / fade

peak = max(abs(x) for x in buf)
scale = 0.85 / peak
with wave.open(out, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b''.join(struct.pack('<h', int(x * scale * 32767)) for x in buf))
print('written', out, round(total / RATE, 2), 's')
