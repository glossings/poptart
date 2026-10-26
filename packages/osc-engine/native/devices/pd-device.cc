// The two things every device shares that are not generated: how a position becomes a value,
// and how a device is found by name.
//
// This is descriptor.mjs's denormalize()/clampParam() in C++, and it has to stay that way: the
// panel's readout, the knob and the DSP all read one number through one function in the browser,
// and a song moved to the desktop has to land on the same number. The curves are the
// descriptor's own three and there are no others.

#include "pd-device.h"

#include <cmath>
#include <cstring>

float pd_denormalize(const PdParamSpec& spec, float position) {
    float t = position;
    if (!(t > 0.f)) t = 0.f;        // also catches NaN, which clamps to the bottom of the range
    if (t > 1.f) t = 1.f;
    float v;
    switch (spec.curve) {
        case kPdExponential:
            // A ratio sweep: 20 Hz to 20 kHz feels linear under the hand. Undefined at zero, and
            // the descriptor refuses an exponential control whose range touches it.
            v = spec.min * std::pow(spec.max / spec.min, t);
            break;
        case kPdPower:
            v = spec.min + (spec.max - spec.min) * std::pow(t, spec.curveExp);
            break;
        default:
            v = spec.min + (spec.max - spec.min) * t;
            break;
    }
    // Only reachable from a range that cannot be swept (a zero span, an exponential one that
    // touches zero), which the descriptor refuses - so the bottom of the range is as good an
    // answer as there is, and it is a definite one.
    if (!std::isfinite(v)) return spec.min;
    // The step is what makes an enum land on an engine and a semitone knob on a whole step.
    if (spec.step > 0.f) v = std::round(v / spec.step) * spec.step;
    if (v < spec.min) return spec.min;
    if (v > spec.max) return spec.max;
    return v;
}

extern "C" const PdDeviceInfo* pd_find_device(const char* name) {
    if (!name) return nullptr;
    const PdDeviceInfo* table = pd_device_table();
    const int count = pd_device_count();
    for (int i = 0; i < count; ++i) {
        if (strcasecmp(table[i].name, name) == 0) return &table[i];
    }
    return nullptr;
}

void pd_mono_sum(const float* interleaved, int frames, int channels, float* out) {
    if (channels <= 1) {
        std::memcpy(out, interleaved, sizeof(float) * (size_t)frames);
        return;
    }
    // Accumulated the way the browser accumulates it: each channel DIVIDED by the count (not
    // multiplied by a reciprocal), added in channel order, and rounded to a float on every add -
    // which is what `data[i] += c[i] / chans.length` on a Float32Array does. The arithmetic is the
    // parity test's business, so it is copied rather than improved.
    for (int i = 0; i < frames; ++i) {
        float sum = 0.f;
        for (int c = 0; c < channels; ++c) {
            sum = (float)((double)sum + (double)interleaved[(size_t)i * channels + c] / (double)channels);
        }
        out[i] = sum;
    }
}
