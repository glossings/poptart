// poptart-audio - the CoreAudio bits Node can't reach.
//
// Two jobs the rest of poptart can't do from JavaScript:
//
//   1. Enumerate audio devices with their real input/output channel counts AND their UIDs. Node's
//      fallback is `system_profiler SPAudioDataType`, which has the channel counts but no UIDs, no
//      subdevice information, and takes ~1s to run.
//   2. Build and inspect the aggregate device that lets ONE scsynth see several interfaces at once.
//      scsynth opens exactly one device (see sc/poptart.scd), so an aggregate is the only way
//      input("Scarlett", 1) and input("Mic", 1) can both be live in the same set.
//
// Why not the `macos-audio-devices` npm package, which also creates aggregates: it exposes no
// drift compensation (an aggregate of two independent-clock devices audibly drifts apart without
// it) and can't read a subdevice list back, so channel offsets would have to be assumed rather
// than read. Both are load-bearing here.
//
// Every command prints one JSON value to stdout and exits 0, or prints {"error": "..."} and exits
// 1. Build with `native/build.sh`; the built binary is committed so installing poptart needs no
// Swift toolchain. If it's missing or unrunnable the server falls back to system_profiler and the
// aggregate features simply turn off (see server.js).

import Foundation
import CoreAudio

// MARK: - property helpers

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func dataSize(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress) -> UInt32? {
    var addr = addr
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr else { return nil }
    return size
}

func value<T>(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress, default def: T) -> T {
    var addr = addr
    var out = def
    var size = UInt32(MemoryLayout<T>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &out) == noErr else { return def }
    return out
}

func stringValue(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var out: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &out) == noErr else { return nil }
    return out as String
}

/// Channel count on one scope, summed across the device's streams - the number that decides how
/// many channels scsynth can open and how far input()'s channel numbers can go.
func channelCount(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
    let addr = address(kAudioDevicePropertyStreamConfiguration, scope)
    guard let size = dataSize(device, addr), size > 0 else { return 0 }
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { buffer.deallocate() }
    var mutableAddr = addr
    var ioSize = size
    guard AudioObjectGetPropertyData(device, &mutableAddr, 0, nil, &ioSize, buffer) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(buffer.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func allDeviceIDs() -> [AudioObjectID] {
    let addr = address(kAudioHardwarePropertyDevices)
    guard let size = dataSize(AudioObjectID(kAudioObjectSystemObject), addr) else { return [] }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    guard count > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: count)
    var mutableAddr = addr
    var ioSize = size
    let status = ids.withUnsafeMutableBytes { raw -> OSStatus in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &mutableAddr, 0, nil, &ioSize, raw.baseAddress!)
    }
    return status == noErr ? ids : []
}

func defaultDeviceID(_ selector: AudioObjectPropertySelector) -> AudioObjectID {
    value(AudioObjectID(kAudioObjectSystemObject), address(selector), default: AudioObjectID(kAudioObjectUnknown))
}

func fourCC(_ value: UInt32) -> String {
    let bytes = [UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff), UInt8((value >> 8) & 0xff), UInt8(value & 0xff)]
    return String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? ""
}

// MARK: - device model

struct Device {
    let id: AudioObjectID
    let uid: String
    let name: String
    let inChannels: Int
    let outChannels: Int
    let sampleRate: Double
    let transport: String
    let isAggregate: Bool

    var json: [String: Any] {
        ["uid": uid, "name": name, "inChannels": inChannels, "outChannels": outChannels,
         "sampleRate": sampleRate, "transport": transport, "isAggregate": isAggregate]
    }
}

func describe(_ id: AudioObjectID) -> Device? {
    guard let uid = stringValue(id, kAudioDevicePropertyDeviceUID),
          let name = stringValue(id, kAudioObjectPropertyName) else { return nil }
    let transport = fourCC(value(id, address(kAudioDevicePropertyTransportType), default: UInt32(0)))
    return Device(
        id: id,
        uid: uid,
        name: name,
        inChannels: channelCount(id, scope: kAudioObjectPropertyScopeInput),
        outChannels: channelCount(id, scope: kAudioObjectPropertyScopeOutput),
        sampleRate: value(id, address(kAudioDevicePropertyNominalSampleRate), default: Double(0)),
        transport: transport,
        isAggregate: transport == "grup" || transport == "acgg"
    )
}

func allDevices() -> [Device] { allDeviceIDs().compactMap(describe) }

func device(uid: String) -> Device? { allDevices().first { $0.uid == uid } }

/// An aggregate's subdevices in the order CoreAudio lays their channels out - the whole point of
/// reading this back rather than assuming the order we passed to `create`. Channel offsets for
/// input("name", n) are the running sum of these devices' input channel counts.
///
/// Two lists matter, and they can differ: FULL is what the aggregate was configured with, ACTIVE
/// is what's actually plugged in and contributing channels right now. Unplugging an interface
/// drops it from ACTIVE and shifts every offset after it, so offsets must be computed from ACTIVE
/// - while FULL is what tells the user "the mic you configured isn't here".
///
/// The two properties have DIFFERENT payload types, which is easy to get wrong and segfaults when
/// you do: Full is a CFArray of UID strings, Active is a raw array of AudioObjectIDs.
func configuredSubDeviceUIDs(_ aggregate: AudioObjectID) -> [String] {
    var addr = address(kAudioAggregateDevicePropertyFullSubDeviceList)
    guard let size = dataSize(aggregate, addr), size > 0 else { return [] }
    var array: CFArray? = nil
    var ioSize = size
    guard AudioObjectGetPropertyData(aggregate, &addr, 0, nil, &ioSize, &array) == noErr,
          let uids = array as? [String] else { return [] }
    return uids
}

func activeSubDeviceIDs(_ aggregate: AudioObjectID) -> [AudioObjectID] {
    let addr = address(kAudioAggregateDevicePropertyActiveSubDeviceList)
    guard let size = dataSize(aggregate, addr), size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    guard count > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: count)
    var mutableAddr = addr
    var ioSize = size
    let status = ids.withUnsafeMutableBytes { raw -> OSStatus in
        AudioObjectGetPropertyData(aggregate, &mutableAddr, 0, nil, &ioSize, raw.baseAddress!)
    }
    return status == noErr ? ids : []
}

// MARK: - output

func emit(_ value: Any) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

func fail(_ message: String) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["error": message], options: [])
    FileHandle.standardError.write(data)
    FileHandle.standardError.write("\n".data(using: .utf8)!)
    exit(1)
}

// MARK: - commands

func cmdList() -> Never {
    let defaultOut = defaultDeviceID(kAudioHardwarePropertyDefaultOutputDevice)
    let defaultIn = defaultDeviceID(kAudioHardwarePropertyDefaultInputDevice)
    let devices = allDevices().map { d -> [String: Any] in
        var json = d.json
        json["isDefaultOutput"] = d.id == defaultOut
        json["isDefaultInput"] = d.id == defaultIn
        return json
    }
    emit(devices)
}

/// The ordered subdevice layout of an aggregate, with each one's input channels - exactly what
/// pattern-core needs to turn input("Scarlett", 1) into an absolute channel.
func cmdLayout(uid: String) -> Never {
    guard let agg = device(uid: uid) else { fail("no audio device with UID \(uid)") }
    guard agg.isAggregate else {
        // A plain interface is a one-entry layout - the same shape, so callers need no special case.
        emit(["uid": agg.uid, "name": agg.name, "isAggregate": false,
              "inChannels": agg.inChannels, "subDevices": [agg.json], "missing": []])
    }
    let active = activeSubDeviceIDs(agg.id).compactMap(describe)
    let subs = active.map(\.json)
    // Configured but not currently present: named so the UI can say which interface to plug back
    // in, since its absence silently renumbers every channel after it.
    let activeUIDs = Set(active.map(\.uid))
    let missing = configuredSubDeviceUIDs(agg.id).filter { !activeUIDs.contains($0) }
    emit(["uid": agg.uid, "name": agg.name, "isAggregate": true,
          "inChannels": agg.inChannels, "subDevices": subs, "missing": missing])
}

/// Builds (or rebuilds) an aggregate. `main` is the clock master; every OTHER subdevice gets drift
/// compensation, which is what keeps independent-clock interfaces from sliding apart over a set.
/// Destroys any existing aggregate with the same UID first, so this is idempotent - "rebuild from
/// this list of devices" rather than "add one more".
func cmdCreate(name: String, uid: String, main: String, subs: [String]) -> Never {
    guard !subs.isEmpty else { fail("an aggregate needs at least one subdevice") }
    guard subs.contains(main) else { fail("the main device \(main) is not in the subdevice list") }
    for sub in subs where device(uid: sub) == nil { fail("no audio device with UID \(sub)") }

    if let existing = device(uid: uid) {
        let status = AudioHardwareDestroyAggregateDevice(existing.id)
        if status != noErr { fail("could not replace the existing aggregate (OSStatus \(status))") }
    }

    // Order matters: channel offsets follow this list, and the layout command reads it back.
    let subDicts: [[String: Any]] = subs.map { sub in
        [kAudioSubDeviceUIDKey as String: sub,
         // The clock master must not drift-correct itself; everything else must.
         kAudioSubDeviceDriftCompensationKey as String: sub == main ? 0 : 1]
    }
    let description: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: name,
        kAudioAggregateDeviceUIDKey as String: uid,
        kAudioAggregateDeviceSubDeviceListKey as String: subDicts,
        kAudioAggregateDeviceMainSubDeviceKey as String: main,
        // Persistent and visible in Audio MIDI Setup: a private aggregate would vanish when this
        // short-lived process exits, and scsynth (a different process) could never open it.
        kAudioAggregateDeviceIsPrivateKey as String: 0,
        kAudioAggregateDeviceIsStackedKey as String: 0,
    ]

    var newID = AudioObjectID(kAudioObjectUnknown)
    let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &newID)
    guard status == noErr, newID != kAudioObjectUnknown else {
        fail("could not create the aggregate device (OSStatus \(status))")
    }
    guard let created = describe(newID) else { fail("the aggregate was created but could not be read back") }
    let ordered = activeSubDeviceIDs(newID).compactMap(describe).map(\.json)
    var json = created.json
    json["subDevices"] = ordered
    emit(json)
}

func cmdDestroy(uid: String) -> Never {
    guard let target = device(uid: uid) else { emit(["destroyed": false, "reason": "not found"]) }
    guard target.isAggregate else { fail("\(target.name) is not an aggregate device") }
    let status = AudioHardwareDestroyAggregateDevice(target.id)
    if status != noErr { fail("could not destroy the aggregate (OSStatus \(status))") }
    emit(["destroyed": true])
}

// MARK: - argument parsing

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("usage: poptart-audio list | layout --uid <uid> | create --name <n> --uid <uid> --main <uid> --sub <uid>… | destroy --uid <uid>")
}
args.removeFirst()

func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func flags(_ name: String) -> [String] {
    var out: [String] = []
    var i = 0
    while i < args.count {
        if args[i] == "--\(name)", i + 1 < args.count { out.append(args[i + 1]); i += 2 } else { i += 1 }
    }
    return out
}

switch command {
case "list":
    cmdList()
case "layout":
    guard let uid = flag("uid") else { fail("layout needs --uid") }
    cmdLayout(uid: uid)
case "create":
    guard let name = flag("name") else { fail("create needs --name") }
    guard let uid = flag("uid") else { fail("create needs --uid") }
    let subs = flags("sub")
    guard let main = flag("main") ?? subs.first else { fail("create needs at least one --sub") }
    cmdCreate(name: name, uid: uid, main: main, subs: subs)
case "destroy":
    guard let uid = flag("uid") else { fail("destroy needs --uid") }
    cmdDestroy(uid: uid)
default:
    fail("unknown command \(command)")
}
