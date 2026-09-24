// Just enough of the VST2 SDK for an Airwindows processor to compile, and nothing else.
//
// Airwindows plugins are written against `AudioEffectX`, but they use almost none of it: a
// sample rate, four or five parameter slots, and a pile of methods that report names to a host.
// The SDK itself is not redistributable, so it is not here and it is not needed - what is here
// is the handful of declarations those files touch, with bodies that do nothing.
//
// This is deliberately dumb. Every symbol below exists because some plugin's .cpp mentions it,
// not because it does anything. The DSP is in processReplacing, and processReplacing needs a
// sample rate and the parameter values; everything else is host plumbing that a worklet has no
// use for. If a new plugin fails to compile, the fix is almost always one more no-op here.

#ifndef POPTART_AUDIOEFFECTX_SHIM_H
#define POPTART_AUDIOEFFECTX_SHIM_H

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>

typedef int32_t VstInt32;
typedef int64_t VstInt64;
typedef void* audioMasterCallback;

enum VstPlugCategory { kPlugCategUnknown = 0, kPlugCategEffect, kPlugCategSynth, kPlugCategMastering };

enum {
  kVstMaxProgNameLen = 24,
  kVstMaxParamStrLen = 8,
  kVstMaxVendorStrLen = 64,
  kVstMaxProductStrLen = 64,
  kVstMaxEffectNameLen = 32,
};

inline void vst_strncpy(char* dst, const char* src, size_t n) {
  if (!dst || !src) return;
  std::strncpy(dst, src, n);
  dst[n] = '\0';
}

inline void float2string(float value, char* text, size_t n) { (void)value; vst_strncpy(text, "", n); }
inline void int2string(VstInt32 value, char* text, size_t n) { (void)value; vst_strncpy(text, "", n); }
inline void dB2string(float value, char* text, size_t n) { (void)value; vst_strncpy(text, "", n); }

class AudioEffect {
 public:
  virtual ~AudioEffect() {}
  // The one piece of host state the DSP actually reads: nearly every Airwindows plugin scales
  // its coefficients by the sample rate against a 44100 reference.
  virtual void setSampleRate(float rate) { sampleRate = rate; }
  virtual float getSampleRate() { return sampleRate; }
  virtual void setBlockSize(VstInt32 size) { blockSize = size; }
  virtual VstInt32 getBlockSize() { return blockSize; }

  void setNumInputs(VstInt32 n) { numInputs = n; }
  void setNumOutputs(VstInt32 n) { numOutputs = n; }
  void setUniqueID(VstInt32 id) { uniqueId = id; }
  void setUniqueID(unsigned long id) { uniqueId = (VstInt32)id; }
  void canProcessReplacing(bool state = true) { (void)state; }
  void canDoubleReplacing(bool state = true) { (void)state; }
  void programsAreChunks(bool state = true) { (void)state; }
  void isSynth(bool state = true) { (void)state; }
  void setInitialDelay(VstInt32 delay) { (void)delay; }
  void noTail(bool state = true) { (void)state; }
  void setEditor(void* editor) { (void)editor; }
  void updateDisplay() {}
  VstInt32 getMasterVersion() { return 2400; }

 protected:
  float sampleRate = 44100.0f;
  VstInt32 blockSize = 128;
  VstInt32 numInputs = 2;
  VstInt32 numOutputs = 2;
  VstInt32 uniqueId = 0;
  char _programName[kVstMaxProgNameLen + 1] = "Default";
  std::set<std::string> _canDo;
};

class AudioEffectX : public AudioEffect {
 public:
  AudioEffectX(audioMasterCallback master, VstInt32 numPrograms, VstInt32 numParams) {
    (void)master;
    (void)numPrograms;
    (void)numParams;
  }
  virtual ~AudioEffectX() {}
};

#endif
