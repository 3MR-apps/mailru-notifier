"""Генератор встроенных сигналов нового письма.

Запуск из папки расширения: python tools/make_sound.py
Пишет sound/<id>.wav (моно, 16 бит, 44,1 кГц). Все звуки синтезированы с нуля,
без сторонних сэмплов. Список id должен совпадать с SOUND_PRESETS в lib/util.js.
"""
import math
import os
import struct
import wave

RATE = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sound')


def tone(buf, freq, start, dur, amp, decay=6.5, attack=0.008, partials=((1, 1.0), (2, 0.35), (3, 0.12)), sweep_to=None):
    """Добавляет в buf тон с обертонами, мягкой атакой и экспоненциальным затуханием.
    partials — пары (множитель частоты, громкость); sweep_to — конечная частота для скольжения."""
    n0, n = int(start * RATE), int(dur * RATE)
    norm = sum(a for _, a in partials)
    phase = [0.0] * len(partials)
    for i in range(n):
        k = n0 + i
        if k >= len(buf):
            break
        t = i / RATE
        f = freq if sweep_to is None else freq * (sweep_to / freq) ** (t / dur)
        env = min(1.0, t / attack) * math.exp(-t * decay)
        v = 0.0
        for j, (mult, a) in enumerate(partials):
            phase[j] += 2 * math.pi * f * mult / RATE
            v += a * math.sin(phase[j])
        buf[k] += amp * env * v / norm


def render(length, parts):
    buf = [0.0] * int(length * RATE)
    for args, kwargs in parts:
        tone(buf, *args, **kwargs)
    fade = int(0.02 * RATE)  # плавный конец без щелчка
    for i in range(fade):
        buf[len(buf) - 1 - i] *= i / fade
    peak = max(abs(x) for x in buf) or 1.0
    return [x * 0.85 / peak for x in buf]


BELL = ((1, 1.0), (2.76, 0.45), (5.4, 0.2), (8.93, 0.08))  # неровные обертоны колокола
SOFT = ((1, 1.0), (2, 0.08))
BLIP = ((1, 1.0), (3, 0.3), (5, 0.12))

SOUNDS = {
    # «Колокольчик» — два мягких тона ми5 → си5 (сигнал по умолчанию)
    'chime': render(0.6, [((659.25, 0.0, 0.55, 0.42), {}), ((987.77, 0.11, 0.49, 0.38), {})]),
    # «Капля» — две короткие капли со скольжением вниз
    'drop': render(0.45, [((1500, 0.0, 0.16, 0.5), {'decay': 18, 'sweep_to': 600, 'partials': SOFT}),
                          ((1200, 0.15, 0.2, 0.4), {'decay': 16, 'sweep_to': 480, 'partials': SOFT})]),
    # «Звон» — одиночный колокол до6 с долгим затуханием
    'bell': render(0.9, [((1046.5, 0.0, 0.9, 0.6), {'decay': 4.5, 'attack': 0.003, 'partials': BELL})]),
    # «Мягкий» — тихий тёплый тон ля4 с медленной атакой
    'soft': render(0.7, [((440.0, 0.0, 0.7, 0.5), {'decay': 5.0, 'attack': 0.04, 'partials': SOFT})]),
    # «Три ноты» — восходящее арпеджио до5 – ми5 – соль5
    'trio': render(0.7, [((523.25, 0.0, 0.3, 0.4), {'decay': 9}), ((659.25, 0.12, 0.3, 0.4), {'decay': 9}),
                         ((783.99, 0.24, 0.45, 0.45), {'decay': 6})]),
    # «Двойной сигнал» — два коротких звонких сигнала ля5
    'blip': render(0.3, [((880.0, 0.0, 0.08, 0.5), {'decay': 25, 'attack': 0.003, 'partials': BLIP}),
                         ((880.0, 0.13, 0.1, 0.5), {'decay': 22, 'attack': 0.003, 'partials': BLIP})]),
}


def write(path, samples):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1.0, min(1.0, x)) * 32767)) for x in samples))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for sid, samples in SOUNDS.items():
        path = os.path.join(OUT, sid + '.wav')
        write(path, samples)
        print('saved', os.path.normpath(path), round(len(samples) / RATE, 2), 's')
