// The two Microsoft-only calls Cloud Seed uses, so it compiles with clang.
//
// Upstream's parameter-formatting helper writes display strings with `strcpy_s`, which is a
// Windows extension. Nothing poptart calls goes near it - the strings are for upstream's own
// panel and poptart generates its own - but it is in a header that the DSP includes, so it has
// to exist for the file to compile.
//
// Force-included from the build rather than patched into the source: the pin is what makes a
// song reproducible, and a patched checkout is a pin that means less than it says.

#ifndef POPTART_CLOUDSEED_COMPAT_H
#define POPTART_CLOUDSEED_COMPAT_H

#include <cstddef>
#include <cstdio>

inline int strcpy_s(char* dst, size_t size, const char* src) {
  if (!dst || !src || size == 0) return 22;         // EINVAL, which is what the original returns
  std::snprintf(dst, size, "%s", src);
  return 0;
}

#endif
