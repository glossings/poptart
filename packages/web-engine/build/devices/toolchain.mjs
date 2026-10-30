// How poptart's scsynth extensions are compiled and linked on each platform scsynth runs on.
//
// Shared by the device build (native.mjs), the keylock build (osc-engine/native/rubberband/
// build.mjs) and the device parity test, which has to compile its harness the way the shipped
// extension is compiled or it tests something nobody runs.
//
// One compiler everywhere: clang. macOS has nothing else; GitHub's Windows runners ship LLVM; on
// Linux it is a package away. The same compiler on every platform is what keeps -ffast-math
// meaning the same rewrites, so a device's output does not depend on which machine built it.
//
// What a plugin IS differs per platform, and the rest of this file is that difference:
//
//   macOS    a Mach-O bundle named .scx, universal (arm64 + x86_64), symbols left for scsynth
//   Windows  a DLL named .scx, x64, built against the MSVC ABI scsynth itself is built with, its
//            C runtime linked in statically so it needs no Visual C++ redistributable
//   Linux    a shared object named .so, x86_64, libstdc++ linked in statically so it loads on a
//            distribution older than the one that built it
//
// In every case scsynth finds the plugin by its extension and calls the `load` it exports
// (SC_API_EXPORT in the SuperCollider headers). Nothing in poptart's extensions calls into
// scsynth by symbol: everything goes through the InterfaceTable `load` is handed.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The DSP flags. Changing these changes what every device sounds like, on every platform. */
export const DSP_FLAGS = ['-O3', '-std=c++17', '-ffast-math', '-fno-rtti'];

/**
 * Where a platform's build lives under an extension's bin/, relative to it. macOS's is bin/
 * itself, which is where it has always been (and where every existing checkout and install
 * expects it); the others get a folder each, so scsynth handed bin/ on one platform never sees
 * another platform's file.
 */
export function binSubdir(platform = process.platform, arch = process.arch) {
  return platform === 'darwin' ? '' : `${platform}-${arch}`;
}

/** The file extension scsynth loads plugins by on a platform. */
export function pluginSuffix(platform = process.platform) {
  return platform === 'linux' ? '.so' : '.scx';
}

/** The C++ compiler. CXX overrides it, as it does for make. */
export function compiler() {
  return process.env.CXX || 'clang++';
}

/** What the compiler is told about the platform, for every translation unit. */
export function targetFlags({ platform = process.platform, arch, rtti = false } = {}) {
  if (platform === 'darwin') {
    return ['-fPIC', ...(arch ? ['-arch', arch] : []), '-mmacosx-version-min=11', '-DSC_DARWIN'];
  }
  if (platform === 'win32') {
    return [
      '--target=x86_64-pc-windows-msvc',
      // Static C runtime (/MT): the plugin carries what it needs instead of asking the machine
      // for a Visual C++ redistributable of a matching version.
      '-fms-runtime-lib=static',
      // M_PI and friends, which the MSVC headers hide unless asked.
      '-D_USE_MATH_DEFINES',
      // Anything that pulls in windows.h must not get its min and max macros, which break
      // std::min and std::max wherever they appear after it.
      '-DNOMINMAX',
      '-DWIN32_LEAN_AND_MEAN',
      '-D_CRT_SECURE_NO_WARNINGS',
      // The MSVC standard library uses typeid unless told RTTI is off.
      ...(rtti ? [] : ['-D_HAS_STATIC_RTTI=0']),
    ];
  }
  return ['-fPIC', '-DSC_LINUX'];
}

/** The arguments that turn objects into a plugin `out` scsynth can load. */
export function linkFlags({ platform = process.platform, arch, out, frameworks = [] } = {}) {
  if (platform === 'darwin') {
    return [
      '-bundle', '-undefined', 'dynamic_lookup',
      ...(arch ? ['-arch', arch] : []), '-mmacosx-version-min=11',
      ...frameworks.flatMap((f) => ['-framework', f]),
      '-o', out,
    ];
  }
  if (platform === 'win32') {
    return [
      '--target=x86_64-pc-windows-msvc', '-fms-runtime-lib=static',
      '-shared', '-fuse-ld=lld',
      // A DLL nobody links against needs no import library beside it.
      '-Wl,/noimplib',
      '-o', out,
    ];
  }
  return [
    '-shared', '-fPIC',
    // Every symbol resolved at link time: a plugin with one left over loads, and then takes the
    // server down the first time that code runs.
    '-Wl,-z,defs',
    '-static-libstdc++', '-static-libgcc', '-Wl,--exclude-libs,ALL',
    '-o', out,
  ];
}

/** An executable's file name on a platform (the parity test's harness). */
export function exeName(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Runs the compiler with `args`, through a response file where a command line could be too long
 * (Windows stops at 32767 characters, and a link of every device is close to that). Each argument
 * is quoted on a line of its own, with forward slashes, which both of clang's response-file
 * dialects read the same way.
 */
export function runCompiler(args, { cwd, responseFile = null } = {}) {
  if (!responseFile) {
    execFileSync(compiler(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    return;
  }
  const quoted = args.map((a) => {
    const s = String(a).replace(/\\/g, '/');
    if (s.includes('"')) throw new Error(`cannot put ${s} in a response file`);
    return `"${s}"`;
  });
  fs.writeFileSync(responseFile, `${quoted.join('\n')}\n`, 'utf8');
  execFileSync(compiler(), [`@${responseFile}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Unpacks a .tar.gz into `dest`, optionally only the members matching `include` (a shell glob)
 * and never those matching `exclude`.
 *
 * Three tars, three dialects. macOS's is bsdtar. Windows has bsdtar too (System32\tar.exe), but a
 * bash step on a GitHub runner puts Git's GNU tar first on the PATH, and GNU tar reads `C:\...`
 * as a remote host - so on Windows the system one is named outright. Linux's is GNU tar, which
 * spells bsdtar's --include as a wildcard member.
 */
export function extractTarGz(archive, dest, { include = null, exclude = [], platform = process.platform } = {}) {
  const ex = exclude.map((e) => `--exclude=${e}`);
  if (platform === 'linux') {
    execFileSync('tar', ['xzf', archive, '-C', dest, ...ex, ...(include ? ['--wildcards', include] : [])]);
    return;
  }
  const tar = platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tar, ['xzf', archive, '-C', dest, ...ex, ...(include ? [`--include=${include}`] : [])]);
}
